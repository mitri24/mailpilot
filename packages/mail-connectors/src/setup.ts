import { promises as dns } from "node:dns";
import { domainToASCII } from "node:url";
import { connectorError } from "./errors.js";
import type { FetchLike } from "./http.js";

export type SetupProvider = "gmail" | "microsoft" | "imap";

export interface ImapSettingsSuggestion {
  host: string;
  port: number;
  /** true = implicit TLS; false = STARTTLS (the connector enforces it, never plaintext). */
  secure: boolean;
  username: string;
}

export interface AccountSetupSuggestion {
  emailAddress: string;
  domain: string;
  /** null when nothing could be determined. */
  provider: SetupProvider | null;
  auth: "oauth" | "password" | "app_password" | null;
  imap: ImapSettingsSuggestion | null;
  source: "known_domain" | "mx" | "srv" | "ispdb" | "guess" | "none";
  /** Even "high" is a suggestion: whether IMAP/OAuth access is allowed is up to the provider or organization. */
  confidence: "high" | "medium" | "low";
  /** German hints, including what is uncertain. */
  notes: string[];
}

export interface SetupResolver {
  resolveMx(domain: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveSrv(name: string): Promise<Array<{ name: string; port: number; priority: number; weight: number }>>;
}

export interface SuggestAccountSetupOptions {
  resolver?: SetupResolver;
  fetch?: FetchLike;
  /** Query Mozilla's ISPDB (sends only the domain). Default true. */
  useIspdb?: boolean;
  /** Timeout per DNS/HTTP lookup in ms. Default 3000. */
  timeoutMs?: number;
  ispdbBaseUrl?: string;
}

const ISPDB_BASE = "https://autoconfig.thunderbird.net/v1.1/";
const ICLOUD_DOMAINS = new Set(["icloud.com", "me.com", "mac.com"]);
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const MICROSOFT_DOMAINS = new Set([
  "outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.de", "hotmail.de", "live.de", "outlook.at",
  "live.at", "hotmail.ch", "outlook.fr", "hotmail.fr", "live.fr", "outlook.it", "hotmail.it", "hotmail.co.uk",
  "live.co.uk",
]);
const ACCESS_NOTE =
  "Ob der Zugriff erlaubt ist, entscheidet der Anbieter bzw. Ihre Organisation: Bei Hochschul- und Firmenkonten ist IMAP oft abgeschaltet oder nur mit App-Passwort oder Freigabe durch die IT möglich.";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function hostOf(name: string): string {
  return name.replace(/\.$/, "").toLowerCase();
}

function base(email: string, domain: string): AccountSetupSuggestion {
  return { emailAddress: email, domain, provider: null, auth: null, imap: null, source: "none", confidence: "low", notes: [] };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlField(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match ? decodeXmlText(match[1] ?? "") : null;
}

interface IspdbResult {
  imap: ImapSettingsSuggestion;
  instruction: string | null;
}

/** Parses Thunderbird autoconfig XML (clientConfig v1.1); SSL preferred over STARTTLS, plain ignored. */
export function parseIspdbXml(xml: string, email: string): IspdbResult | null {
  const [local = "", domain = ""] = [email.slice(0, email.lastIndexOf("@")), email.slice(email.lastIndexOf("@") + 1)];
  const substitute = (value: string): string =>
    value.replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain);
  const servers = [...xml.matchAll(/<incomingServer\s+type="imap"\s*>([\s\S]*?)<\/incomingServer>/gi)].map((match) => match[1] ?? "");
  const candidates = servers
    .map((block) => {
      const hostname = xmlField(block, "hostname");
      const port = Number(xmlField(block, "port"));
      const socketType = (xmlField(block, "socketType") ?? "").toUpperCase();
      const username = xmlField(block, "username");
      if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      if (socketType !== "SSL" && socketType !== "STARTTLS") return null;
      return { host: hostOf(substitute(hostname)), port, secure: socketType === "SSL", username: substitute(username ?? "%EMAILADDRESS%") };
    })
    .filter((entry): entry is ImapSettingsSuggestion => entry !== null)
    .sort((a, b) => Number(b.secure) - Number(a.secure));
  const imap = candidates[0];
  if (!imap || !/^[a-z0-9.-]+$/.test(imap.host)) return null;
  const instructions = [...xml.matchAll(/<instruction(?:\s+lang="([a-z-]+)")?\s*>([\s\S]*?)<\/instruction>/gi)].map((match) => ({
    lang: match[1]?.toLowerCase() ?? "",
    text: decodeXmlText(match[2] ?? "").replace(/<[^>]*>/g, "").slice(0, 300),
  }));
  const instruction = (instructions.find((entry) => entry.lang === "de") ?? instructions[0])?.text ?? null;
  return { imap, instruction: instruction || null };
}

async function lookupIspdb(domain: string, email: string, options: Required<Pick<SuggestAccountSetupOptions, "timeoutMs">> & SuggestAccountSetupOptions): Promise<IspdbResult | null> {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${options.ispdbBaseUrl ?? ISPDB_BASE}${encodeURIComponent(domain)}`;
  const response = await withTimeout(fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs) }), options.timeoutMs);
  if (!response || !response.ok) return null;
  const text = await withTimeout(response.text(), options.timeoutMs);
  return text ? parseIspdbXml(text, email) : null;
}

function registrableGuess(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * Suggests how to connect an address: known providers first, then MX (Google Workspace,
 * Microsoft 365, iCloud), RFC 6186 SRV records and Mozilla's ISPDB. The result is a
 * suggestion with stated uncertainty, never a promise that access is permitted.
 */
export async function suggestAccountSetup(email: string, options: SuggestAccountSetupOptions = {}): Promise<AccountSetupSuggestion> {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, at);
  const domain = domainToASCII(trimmed.slice(at + 1).toLowerCase());
  if (at <= 0 || !local || !domain || !domain.includes(".")) {
    throw connectorError("config", "invalid email address", { userAction: "E-Mail-Adresse prüfen" });
  }
  const address = `${local}@${domain}`;
  const timeoutMs = options.timeoutMs ?? 3000;
  const resolver: SetupResolver = options.resolver ?? { resolveMx: (d) => dns.resolveMx(d), resolveSrv: (n) => dns.resolveSrv(n) };
  const result = base(address, domain);

  if (ICLOUD_DOMAINS.has(domain)) {
    return {
      ...result,
      provider: "imap",
      auth: "app_password",
      imap: { host: "imap.mail.me.com", port: 993, secure: true, username: local },
      source: "known_domain",
      confidence: "high",
      notes: [
        "iCloud Mail verlangt ein app-spezifisches Passwort (in den Apple-Account-Einstellungen erstellen).",
        "Benutzername ist laut Apple meist der Teil vor dem @; scheitert die Anmeldung, die vollständige Adresse verwenden.",
      ],
    };
  }
  if (GMAIL_DOMAINS.has(domain)) {
    return { ...result, provider: "gmail", auth: "oauth", source: "known_domain", confidence: "high", notes: ["Anmeldung über Google (OAuth)."] };
  }
  if (MICROSOFT_DOMAINS.has(domain)) {
    return { ...result, provider: "microsoft", auth: "oauth", source: "known_domain", confidence: "high", notes: ["Anmeldung über Microsoft (OAuth)."] };
  }

  const mx = (await withTimeout(resolver.resolveMx(domain), timeoutMs)) ?? [];
  const mxHosts = mx.sort((a, b) => a.priority - b.priority).map((record) => hostOf(record.exchange));
  if (mxHosts.some((host) => host.endsWith(".google.com") || host.endsWith(".googlemail.com") || host === "smtp.google.com")) {
    return {
      ...result,
      provider: "gmail",
      auth: "oauth",
      source: "mx",
      confidence: "medium",
      notes: ["Die Domain empfängt E-Mails über Google Workspace (MX-Eintrag).", "Ihre Organisation kann Drittanbieter-Apps sperren; dann muss die IT MailPilot freigeben.", ACCESS_NOTE],
    };
  }
  if (mxHosts.some((host) => host.endsWith(".protection.outlook.com"))) {
    return {
      ...result,
      provider: "microsoft",
      auth: "oauth",
      source: "mx",
      confidence: "medium",
      notes: ["Die Domain empfängt E-Mails über Microsoft 365 (MX-Eintrag).", "Je nach Richtlinie muss die IT MailPilot erst zulassen (Administratorzustimmung).", ACCESS_NOTE],
    };
  }
  if (mxHosts.some((host) => host.endsWith(".mail.icloud.com"))) {
    return {
      ...result,
      provider: "imap",
      auth: "app_password",
      imap: { host: "imap.mail.me.com", port: 993, secure: true, username: address },
      source: "mx",
      confidence: "low",
      notes: [
        "Die Domain empfängt E-Mails über iCloud+ (eigene Domain, MX-Eintrag).",
        "Welcher Benutzername bei eigenen Domains gilt, ist nicht geprüft; meist die iCloud-Adresse. Ein app-spezifisches Passwort ist nötig.",
      ],
    };
  }

  for (const [service, secure] of [["_imaps._tcp", true], ["_imap._tcp", false]] as const) {
    const records = (await withTimeout(resolver.resolveSrv(`${service}.${domain}`), timeoutMs)) ?? [];
    const usable = records
      .filter((record) => hostOf(record.name) !== "" && record.name !== "." && record.port > 0)
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
    const best = usable[0];
    if (best) {
      const host = hostOf(best.name);
      // RFC 6186 §6: a target outside the mail domain may come from a spoofed DNS answer.
      const inDomain = host === domain || host.endsWith(`.${domain}`);
      return {
        ...result,
        provider: "imap",
        auth: "password",
        imap: { host, port: best.port, secure, username: address },
        source: "srv",
        confidence: inDomain ? "medium" : "low",
        notes: [
          `Server aus dem DNS-Eintrag ${service} (RFC 6186).`,
          ...(inDomain ? [] : [`Der Eintrag verweist auf ${host} außerhalb von ${domain} – bitte vor dem Verbinden bestätigen.`]),
          ...(secure ? [] : ["Der Server bietet nur STARTTLS an; MailPilot verbindet sich ausschließlich verschlüsselt."]),
          ACCESS_NOTE,
        ],
      };
    }
  }

  if (options.useIspdb !== false) {
    const lookups = [domain, ...new Set(mxHosts.map(registrableGuess).filter((candidate) => candidate !== domain))].slice(0, 2);
    for (const candidate of lookups) {
      const ispdb = await lookupIspdb(candidate, address, { ...options, timeoutMs });
      if (ispdb) {
        return {
          ...result,
          provider: "imap",
          auth: "password",
          imap: ispdb.imap,
          source: "ispdb",
          confidence: "medium",
          notes: [
            "Einstellungen aus der Thunderbird-Anbieterdatenbank (ISPDB).",
            ...(ispdb.instruction ? [`Hinweis des Anbieters: ${ispdb.instruction}`] : []),
            ACCESS_NOTE,
          ],
        };
      }
    }
  }

  return {
    ...result,
    provider: "imap",
    auth: "password",
    imap: { host: `imap.${domain}`, port: 993, secure: true, username: address },
    source: "guess",
    confidence: "low",
    notes: ["Keine Angaben gefunden – Server „imap.<Domain>“ ist nur eine Vermutung. Bitte beim Anbieter oder der IT nachfragen.", ACCESS_NOTE],
  };
}
