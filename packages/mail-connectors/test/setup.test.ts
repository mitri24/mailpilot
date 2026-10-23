import { describe, expect, it } from "vitest";
import { parseIspdbXml, suggestAccountSetup, type SetupResolver } from "../src/index.js";
import { mockFetch } from "./helpers/http.js";

function resolver(records: { mx?: Record<string, string[]>; srv?: Record<string, Array<{ name: string; port: number; priority?: number; weight?: number }>> }): SetupResolver & { queries: string[] } {
  const queries: string[] = [];
  const notFound = (name: string) => Object.assign(new Error(`queryMx ENOTFOUND ${name}`), { code: "ENOTFOUND" });
  return {
    queries,
    async resolveMx(domain) {
      queries.push(`MX ${domain}`);
      const hosts = records.mx?.[domain];
      if (!hosts) throw notFound(domain);
      return hosts.map((exchange, index) => ({ exchange, priority: (index + 1) * 10 }));
    },
    async resolveSrv(name) {
      queries.push(`SRV ${name}`);
      const entries = records.srv?.[name];
      if (!entries) throw notFound(name);
      return entries.map((entry) => ({ priority: 0, weight: 0, ...entry }));
    },
  };
}

const ISPDB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>pop.example.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <enable visiturl="https://help.example.com/imap">
      <instruction>You must allow IMAP access once in the settings!</instruction>
      <instruction lang="de">Sie müssen den Zugriff über IMAP einmalig in den Einstellungen erlauben!</instruction>
    </enable>
  </emailProvider>
</clientConfig>`;

const noIspdb = { useIspdb: false } as const;

describe("suggestAccountSetup", () => {
  it("iCloud-Domains → imap.mail.me.com:993 mit App-Passwort", async () => {
    for (const domain of ["icloud.com", "me.com", "mac.com"]) {
      const suggestion = await suggestAccountSetup(`anna.beispiel@${domain}`, { resolver: resolver({}), ...noIspdb });
      expect(suggestion).toMatchObject({
        provider: "imap",
        auth: "app_password",
        imap: { host: "imap.mail.me.com", port: 993, secure: true, username: "anna.beispiel" },
        source: "known_domain",
        confidence: "high",
      });
      expect(suggestion.notes.join(" ")).toContain("app-spezifisches Passwort");
    }
  });

  it("Gmail- und Microsoft-Verbraucherdomains → OAuth", async () => {
    expect(await suggestAccountSetup("anna@googlemail.com", noIspdb)).toMatchObject({ provider: "gmail", auth: "oauth", imap: null, confidence: "high" });
    expect(await suggestAccountSetup("anna@hotmail.de", noIspdb)).toMatchObject({ provider: "microsoft", auth: "oauth", imap: null });
    expect(await suggestAccountSetup("Anna@Outlook.com", noIspdb)).toMatchObject({ provider: "microsoft", emailAddress: "Anna@outlook.com" });
  });

  it("erkennt Google Workspace und Microsoft 365 am MX-Eintrag – mit Hinweis auf Freigabe durch die IT", async () => {
    const workspace = await suggestAccountSetup("anna@example.org", { resolver: resolver({ mx: { "example.org": ["ASPMX.L.GOOGLE.COM.", "alt1.aspmx.l.google.com"] } }), ...noIspdb });
    expect(workspace).toMatchObject({ provider: "gmail", auth: "oauth", source: "mx", confidence: "medium" });
    expect(workspace.notes.join(" ")).toMatch(/Google Workspace.*IT MailPilot freigeben/s);
    const m365 = await suggestAccountSetup("anna@example.com", { resolver: resolver({ mx: { "example.com": ["example-com.mail.protection.outlook.com"] } }), ...noIspdb });
    expect(m365).toMatchObject({ provider: "microsoft", auth: "oauth", source: "mx" });
    expect(m365.notes.join(" ")).toContain("Hochschul- und Firmenkonten ist IMAP oft abgeschaltet");
  });

  it("RFC 6186: _imaps._tcp vor _imap._tcp, Priorität und Gewicht werden beachtet", async () => {
    const records = resolver({
      mx: { "example.org": ["mx.example.org"] },
      srv: {
        "_imaps._tcp.example.org": [
          { name: "backup.example.org", port: 993, priority: 20 },
          { name: "imap.example.org", port: 993, priority: 10, weight: 5 },
        ],
      },
    });
    expect(await suggestAccountSetup("anna@example.org", { resolver: records, ...noIspdb })).toMatchObject({
      provider: "imap",
      auth: "password",
      imap: { host: "imap.example.org", port: 993, secure: true, username: "anna@example.org" },
      source: "srv",
      confidence: "medium",
    });
    const starttls = await suggestAccountSetup("anna@example.org", {
      resolver: resolver({ srv: { "_imap._tcp.example.org": [{ name: "mail.example.org.", port: 143 }] } }),
      ...noIspdb,
    });
    expect(starttls).toMatchObject({ imap: { host: "mail.example.org", port: 143, secure: false }, source: "srv" });
    expect(starttls.notes.join(" ")).toContain("ausschließlich verschlüsselt");
    // "." as target means: service not offered.
    const disabled = await suggestAccountSetup("anna@example.org", {
      resolver: resolver({ srv: { "_imaps._tcp.example.org": [{ name: "", port: 0 }] } }),
      ...noIspdb,
    });
    expect(disabled.source).toBe("guess");
  });

  it("fragt die ISPDB mit Timeout ab, bevorzugt SSL und übernimmt den Anbieterhinweis", async () => {
    const http = mockFetch((request) =>
      request.url.toString() === "https://autoconfig.thunderbird.net/v1.1/example.com"
        ? new Response(ISPDB_XML, { status: 200, headers: { "Content-Type": "text/xml" } })
        : new Response("Not Found", { status: 404 }),
    );
    const suggestion = await suggestAccountSetup("anna@example.com", { resolver: resolver({}), fetch: http.fetch });
    expect(suggestion).toMatchObject({
      provider: "imap",
      imap: { host: "imap.example.com", port: 993, secure: true, username: "anna@example.com" },
      source: "ispdb",
      confidence: "medium",
    });
    expect(suggestion.notes).toContain("Hinweis des Anbieters: Sie müssen den Zugriff über IMAP einmalig in den Einstellungen erlauben!");
    expect(http.requests.map((r) => r.url.hostname)).toEqual(["autoconfig.thunderbird.net"]);
  });

  it("bricht hängende Abfragen per Timeout ab und liefert eine als unsicher markierte Vermutung", async () => {
    const hanging: SetupResolver = { resolveMx: () => new Promise(() => {}), resolveSrv: () => new Promise(() => {}) };
    const http = mockFetch(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const suggestion = await suggestAccountSetup("anna@example.org", { resolver: hanging, fetch: http.fetch, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(suggestion).toMatchObject({
      provider: "imap",
      imap: { host: "imap.example.org", port: 993, secure: true },
      source: "guess",
      confidence: "low",
    });
    expect(suggestion.notes[0]).toContain("nur eine Vermutung");
  });

  it("lehnt ungültige Adressen ab", async () => {
    await expect(suggestAccountSetup("keine-adresse", noIspdb)).rejects.toMatchObject({ code: "config", userAction: "E-Mail-Adresse prüfen" });
  });

  it("parseIspdbXml ignoriert Klartext-Server", () => {
    const plainOnly = ISPDB_XML.replace(/STARTTLS|SSL/g, "plain");
    expect(parseIspdbXml(plainOnly, "anna@example.com")).toBeNull();
    const starttlsOnly = `<clientConfig version="1.1"><emailProvider id="example.com"><incomingServer type="imap"><hostname>imap.example.com</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer></emailProvider></clientConfig>`;
    expect(parseIspdbXml(starttlsOnly, "anna@example.com")?.imap).toEqual({
      host: "imap.example.com",
      port: 143,
      secure: false,
      username: "anna",
    });
  });

  it("SRV-Ziel außerhalb der Domain: nur geringe Sicherheit und Hinweis zur Bestätigung", async () => {
    const suggestion = await suggestAccountSetup("anna@example.org", {
      resolver: resolver({ srv: { "_imaps._tcp.example.org": [{ name: "imap.example.com", port: 993 }] } }),
      ...noIspdb,
    });
    expect(suggestion).toMatchObject({ source: "srv", confidence: "low", imap: { host: "imap.example.com" } });
    expect(suggestion.notes.join(" ")).toContain("außerhalb von example.org");
  });
});
