import { createHash } from "node:crypto";
import { compile, type HtmlToTextOptions } from "html-to-text";
import { MailParser } from "mailparser";
import type { AddressObject, AttachmentStream, EmailAddress, HeaderLines, Headers, HeaderValue, MessageText } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { NormalizedAddress, NormalizedAttachment, NormalizedMessage } from "./types.js";

export const DEFAULT_MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const SNIPPET_LENGTH = 200;

/** The parts of a NormalizedMessage that come from the message itself (not from the provider). */
export type MimeContent = Pick<
  NormalizedMessage,
  | "rfcMessageId"
  | "inReplyTo"
  | "references"
  | "from"
  | "to"
  | "cc"
  | "subject"
  | "sentAt"
  | "bodyText"
  | "bodyHtmlSanitized"
  | "remoteContentBlocked"
  | "snippet"
  | "attachments"
  | "sizeBytes"
  | "contentHash"
  | "headersFingerprint"
  | "truncated"
>;

export interface ProcessMimeOptions {
  /** Bytes beyond this limit are not parsed and `truncated` is set. */
  maxMessageBytes?: number;
  /** Full size reported by the server when `raw` is only the beginning of the message. */
  sizeBytes?: number | null;
  /** Set when the caller already downloaded only part of the message. */
  truncated?: boolean;
}

export type BodyContent = Pick<
  NormalizedMessage,
  "bodyText" | "bodyHtmlSanitized" | "remoteContentBlocked" | "snippet" | "contentHash"
>;

// ---------------------------------------------------------------------------------------------
// Hashing and identifiers

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Returns the bare Message-ID (without angle brackets) or null. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bracketed = /<([^<>\s]+)>/.exec(raw);
  const candidate = bracketed?.[1] ?? raw.trim().split(/\s+/)[0] ?? "";
  const id = candidate.replace(/^<+|>+$/g, "").trim();
  return id.length > 0 && id.length <= 998 ? id : null;
}

/** sha256 over the whitespace-normalized text; equal text means no new analysis is needed. */
export function computeContentHash(bodyText: string): string {
  return sha256(bodyText.normalize("NFC").replace(/\s+/g, " ").trim());
}

/** sha256 over From, Date, Subject and Message-ID (fallback identity when Message-ID is missing). */
export function computeHeadersFingerprint(input: {
  from: string | null;
  date: string | null;
  subject: string | null;
  messageId: string | null;
}): string {
  return sha256(
    [input.from?.toLowerCase() ?? "", input.date ?? "", input.subject ?? "", input.messageId ?? ""]
      .map((value) => value.normalize("NFC").trim())
      .join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------
// HTML sanitizing

const REMOTE_IMAGE_CLASS = "mp-remote-image";
const INLINE_IMAGE_CLASS = "mp-inline-image";
const MAX_DATA_IMAGE_CHARS = 100_000;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const REMOTE_URL = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
// The optional quote owns the second \s*, so whitespace runs cannot backtrack quadratically.
const REMOTE_CSS_URL = /url\(\s*(?:['"]\s*)?(?:[a-z][a-z0-9+.-]*:)?\/\//gi;
/** @import "…" without url() – the url() form is already counted by REMOTE_CSS_URL. */
const REMOTE_CSS_IMPORT = /@import\s+['"]\s*(?:[a-z][a-z0-9+.-]*:)?\/\//gi;
const TRACKER_URL = /(?:^|[/?&._=-])(?:pixel|beacon|track|tracking|trk|open|opened|wf\/open)(?:[/?&._=-]|$)/i;
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

const ALLOWED_TAGS = [
  "a", "abbr", "address", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small",
  "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt",
  "u", "ul", "var", "wbr",
];

const CELL_ATTRIBUTES = ["colspan", "rowspan", "bgcolor", "nowrap", "scope"];
const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  "*": ["style", "title", "dir", "lang", "align", "valign", "width", "height"],
  a: ["href", "rel"],
  img: ["src", "alt"],
  span: ["class"],
  font: ["color", "face", "size"],
  table: ["border", "cellpadding", "cellspacing", "bgcolor"],
  td: CELL_ATTRIBUTES,
  th: CELL_ATTRIBUTES,
  tr: ["bgcolor"],
  ol: ["start", "type", "reversed"],
  ul: ["type"],
  li: ["value"],
  col: ["span"],
  colgroup: ["span"],
};

// Values may contain colors, lengths, keywords and rgb()/hsl(), but never url(), expression() or escapes.
const SAFE_CSS_VALUE =
  /^(?!.*(?:url|expression|image|image-set|element|paint|cross-fade|var|env|attr|src)\s*\()(?!.*(?:javascript:|vbscript:|behavior|binding))[^<>{}\\;]*$/i;
const SAFE_CSS_PROPERTIES = [
  "color", "background-color", "font", "font-family", "font-size", "font-style", "font-variant", "font-weight",
  "text-align", "text-decoration", "text-indent", "text-transform", "line-height", "letter-spacing",
  "word-spacing", "white-space", "vertical-align", "direction", "margin", "margin-top", "margin-right",
  "margin-bottom", "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style",
  "border-width", "border-radius", "border-collapse", "border-spacing", "width", "height", "max-width",
  "min-width", "max-height", "min-height", "display", "float", "clear", "list-style-type", "table-layout",
];
const ALLOWED_STYLES: Record<string, RegExp[]> = Object.fromEntries(
  SAFE_CSS_PROPERTIES.map((property) => [property, [SAFE_CSS_VALUE]]),
);

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function parsePixels(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

function isTrackingPixel(attribs: sanitizeHtml.Attributes, src: string): boolean {
  const width = parsePixels(attribs.width);
  const height = parsePixels(attribs.height);
  if ((width !== null && width <= 2) || (height !== null && height <= 2)) return true;
  const style = (attribs.style ?? "").toLowerCase().replace(/\s+/g, "");
  if (/display:none|visibility:hidden|opacity:0(?:[;.]|$)|max-height:0(?:px)?(?:;|$)/.test(style)) return true;
  if (/(?:^|;)(?:width|height):[0-2](?:\.\d+)?(?:px)?(?:;|$)/.test(style)) return true;
  return TRACKER_URL.test(src);
}

function imagePlaceholder(className: string, alt: string | undefined): sanitizeHtml.Tag {
  const label = alt?.trim().slice(0, 100);
  return {
    tagName: "span",
    attribs: {
      class: className,
      title: className === REMOTE_IMAGE_CLASS ? "Externes Bild blockiert" : "Eingebettetes Bild",
    },
    text: label ? `[Bild: ${label}]` : "[Bild]",
  };
}

interface SanitizeState {
  blocked: number;
  /** Attribute objects of images to remove entirely (matched by identity in exclusiveFilter). */
  dropped: WeakSet<sanitizeHtml.Attributes>;
}

// Renaming a tag to a disallowed name leaves a stale entry in sanitize-html's transform map
// (the next sibling then closes with that name), so dropped images keep their name and are
// removed by exclusiveFilter instead.
function dropImage(state: SanitizeState): sanitizeHtml.Tag {
  const attribs: sanitizeHtml.Attributes = {};
  state.dropped.add(attribs);
  return { tagName: "img", attribs };
}

function transformImage(state: SanitizeState, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const src = (attribs.src ?? "").trim();
  const remoteSrcset = /(?:^|,)\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(attribs.srcset ?? "");
  if (REMOTE_URL.test(src) || remoteSrcset) {
    state.blocked += 1;
    return isTrackingPixel(attribs, src) ? dropImage(state) : imagePlaceholder(REMOTE_IMAGE_CLASS, attribs.alt);
  }
  if (/^cid:/i.test(src)) return imagePlaceholder(INLINE_IMAGE_CLASS, attribs.alt);
  if (src.length <= MAX_DATA_IMAGE_CHARS && SAFE_DATA_IMAGE.test(src)) {
    const kept: sanitizeHtml.Attributes = { src };
    if (attribs.alt) kept.alt = attribs.alt;
    const width = parsePixels(attribs.width);
    const height = parsePixels(attribs.height);
    if (width !== null) kept.width = String(width);
    if (height !== null) kept.height = String(height);
    return { tagName: "img", attribs: kept };
  }
  return dropImage(state);
}

function transformLink(attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const href = (attribs.href ?? "").trim();
  const kept: sanitizeHtml.Attributes = {};
  if (SAFE_LINK.test(href)) {
    kept.href = href;
    kept.rel = "noopener noreferrer";
  }
  if (attribs.title) kept.title = attribs.title;
  return { tagName: "a", attribs: kept };
}

/** Counts remote references on any tag (background, poster, srcset, CSS url()) before they are dropped. */
function countRemoteAttributes(tagName: string, attribs: sanitizeHtml.Attributes): number {
  let count = 0;
  for (const key of ["background", "poster", "data", "src"]) {
    if (key === "src" && tagName === "img") continue;
    const value = attribs[key];
    if (value && REMOTE_URL.test(value)) count += 1;
  }
  if (attribs.srcset && tagName !== "img" && /(?:^|,)\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(attribs.srcset)) count += 1;
  if (tagName === "link" && attribs.href && REMOTE_URL.test(attribs.href)) count += 1;
  if (attribs.style) count += countMatches(attribs.style, REMOTE_CSS_URL);
  return count;
}

/** Linear scan: an unclosed <style> must not make every later <style> rescan to the end. */
function countRemoteInStyleBlocks(html: string): number {
  const open = /<style\b/gi;
  const close = /<\/style/gi;
  let count = 0;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    const tagEnd = html.indexOf(">", match.index);
    if (tagEnd < 0) break;
    close.lastIndex = tagEnd;
    const end = close.exec(html);
    const css = html.slice(tagEnd + 1, end ? end.index : html.length);
    count += countMatches(css, REMOTE_CSS_URL) + countMatches(css, REMOTE_CSS_IMPORT);
    if (!end) break;
    open.lastIndex = end.index + 7;
  }
  return count;
}

export interface SanitizedHtml {
  html: string;
  /** Remote references removed: images (incl. tracking pixels), backgrounds, CSS url(), embeds. */
  remoteContentBlocked: number;
}

/**
 * Makes mail HTML safe to render: no scripts, event handlers, forms, frames or style blocks;
 * inline styles only from an allow-list without url(); remote images replaced by a placeholder
 * (tracking pixels removed entirely); links only http/https/mailto with rel="noopener noreferrer".
 */
export function sanitizeEmailHtml(html: string): SanitizedHtml {
  const state: SanitizeState = { blocked: countRemoteInStyleBlocks(html), dropped: new WeakSet() };
  const output = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedClasses: { span: [REMOTE_IMAGE_CLASS, INLINE_IMAGE_CLASS] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
    allowedStyles: { "*": ALLOWED_STYLES },
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "template"],
    disallowedTagsMode: "discard",
    exclusiveFilter: (frame) => state.dropped.has(frame.attribs),
    transformTags: {
      a: (_tagName, attribs) => transformLink(attribs),
      img: (_tagName, attribs) => transformImage(state, attribs),
      "*": (tagName, attribs) => {
        state.blocked += countRemoteAttributes(tagName, attribs);
        return { tagName, attribs };
      },
    },
  });
  return { html: output.trim(), remoteContentBlocked: state.blocked };
}

// ---------------------------------------------------------------------------------------------
// Text

const HEADING_SELECTORS = ["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
  selector,
  options: { uppercase: false },
}));

const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: `span.${REMOTE_IMAGE_CLASS}`, format: "skip" },
    { selector: `span.${INLINE_IMAGE_CLASS}`, format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    ...HEADING_SELECTORS,
  ],
};

const htmlToPlainText = compile(HTML_TO_TEXT_OPTIONS);

const INVISIBLE_CHARS = /[\u200b-\u200d\u2060\ufeff\u034f\u00ad]/g;

/** Line endings, invisible characters and blank-line runs normalized; content unchanged. */
export function normalizeText(text: string): string {
  // trimEnd per line instead of /[ \t]+$/gm, which is quadratic on long whitespace runs.
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSnippet(bodyText: string): string | null {
  const flat = reduceForAnalysis(bodyText, { maxChars: SNIPPET_LENGTH * 5 }).text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= SNIPPET_LENGTH) return flat;
  const cut = flat.slice(0, SNIPPET_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SNIPPET_LENGTH * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Turns a provider body (HTML and/or plain text) into the stored representation.
 * Plain text wins for `bodyText`; HTML is only converted when no text/plain exists.
 */
export function processBody(input: { html?: string | null; text?: string | null }): BodyContent {
  let bodyHtmlSanitized: string | null = null;
  let remoteContentBlocked = 0;
  if (input.html && input.html.trim()) {
    const sanitized = sanitizeEmailHtml(input.html);
    bodyHtmlSanitized = sanitized.html || null;
    remoteContentBlocked = sanitized.remoteContentBlocked;
  }
  const plain = input.text ? normalizeText(input.text) : "";
  const bodyText = plain || (bodyHtmlSanitized ? normalizeText(htmlToPlainText(bodyHtmlSanitized)) : "");
  return {
    bodyText,
    bodyHtmlSanitized,
    remoteContentBlocked,
    snippet: buildSnippet(bodyText),
    contentHash: computeContentHash(bodyText),
  };
}

// ---------------------------------------------------------------------------------------------
// MIME

interface ParsedMime {
  headers: Headers;
  headerLines: HeaderLines;
  html: string | null;
  text: string | null;
  attachments: NormalizedAttachment[];
}

function attachmentMeta(attachment: AttachmentStream, size: number): NormalizedAttachment {
  const disposition = attachment.contentDisposition?.toLowerCase();
  const inline = disposition === "inline" || (disposition !== "attachment" && (attachment.related === true || Boolean(attachment.cid)));
  return { filename: attachment.filename ?? null, contentType: attachment.contentType ?? null, size, inline };
}

/** Streams the message through MailParser; attachment bytes are counted and discarded, never kept. */
function parseMime(input: Buffer): Promise<ParsedMime> {
  return new Promise((resolve, reject) => {
    const parser = new MailParser({
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      skipTextLinks: true,
      checksumAlgo: false,
    });
    const result: ParsedMime = { headers: new Map(), headerLines: [], html: null, text: null, attachments: [] };
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    parser.on("headers", (headers: Headers) => {
      result.headers = headers;
    });
    parser.on("headerLines", (lines: HeaderLines) => {
      result.headerLines = lines;
    });
    parser.on("data", (data: AttachmentStream | MessageText) => {
      if (data.type === "text") {
        result.html = data.html ?? null;
        result.text = data.text ?? null;
        return;
      }
      let size = 0;
      data.content.on("data", (chunk: Buffer) => {
        size += chunk.length;
      });
      data.content.once("end", () => {
        result.attachments.push(attachmentMeta(data, data.size ?? size));
        data.release?.();
      });
      data.content.once("error", fail);
    });
    parser.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(result);
    });
    parser.once("error", fail);
    parser.end(input);
  });
}

function headerString(value: HeaderValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function rawHeaderValue(lines: HeaderLines, key: string): string | null {
  const line = lines.find((entry) => entry.key === key)?.line;
  if (!line) return null;
  const value = line.slice(line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  return value || null;
}

/** mailparser substitutes "now" for unparseable dates, so the raw header is parsed here. */
function parseMailDate(raw: string | null): Date | null {
  if (!raw) return null;
  for (const candidate of [raw, raw.replace(/\([^)]*\)/g, " ").trim()]) {
    const time = Date.parse(candidate);
    if (!Number.isNaN(time)) return new Date(time);
  }
  return null;
}

function isAddressObject(value: unknown): value is AddressObject {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as AddressObject).value);
}

function flattenAddresses(entries: EmailAddress[], out: NormalizedAddress[]): void {
  for (const entry of entries) {
    if (entry.group) {
      flattenAddresses(entry.group, out);
      continue;
    }
    const address = entry.address?.trim().toLowerCase();
    if (address) out.push({ name: entry.name?.trim() || null, address });
  }
}

function addressList(value: HeaderValue | undefined): NormalizedAddress[] {
  const out: NormalizedAddress[] = [];
  const objects = Array.isArray(value) ? value : [value];
  for (const object of objects) {
    if (isAddressObject(object)) flattenAddresses(object.value, out);
  }
  return out;
}

function parseReferences(value: HeaderValue | undefined): string[] {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value.filter((v) => typeof v === "string").join(" ") : "";
  const bracketed = [...raw.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1] ?? "");
  const ids = bracketed.length > 0 ? bracketed : raw.split(/\s+/);
  return [...new Set(ids.map((id) => normalizeMessageId(id)).filter((id): id is string => id !== null))];
}

function fallbackParse(input: Buffer): ParsedMime {
  const raw = input.toString("utf8");
  const split = raw.search(/\r?\n\r?\n/);
  return { headers: new Map(), headerLines: [], html: null, text: split >= 0 ? raw.slice(split).trim() : raw, attachments: [] };
}

/**
 * Parses a raw RFC 5322 message into the content fields of NormalizedMessage.
 * Attachments are reported as metadata only; their bytes are never retained.
 */
export async function processMime(raw: Buffer | string, options: ProcessMimeOptions = {}): Promise<MimeContent> {
  const buffer = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const limit = Math.max(1, Math.floor(options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES));
  const truncated = (options.truncated ?? false) || buffer.length > limit;
  const input = buffer.length > limit ? buffer.subarray(0, limit) : buffer;
  let parsed: ParsedMime;
  try {
    parsed = await parseMime(input);
  } catch {
    parsed = fallbackParse(input);
  }
  const { headers } = parsed;
  const messageId = normalizeMessageId(headerString(headers.get("message-id")));
  const inReplyTo = normalizeMessageId(headerString(headers.get("in-reply-to")));
  const from = addressList(headers.get("from"))[0] ?? null;
  const subject = headerString(headers.get("subject"))?.trim() || null;
  const rawDate = rawHeaderValue(parsed.headerLines, "date");
  const sentAt = parseMailDate(rawDate);
  const body = processBody({ html: parsed.html, text: parsed.text });
  return {
    rfcMessageId: messageId ? `<${messageId}>` : null,
    inReplyTo: inReplyTo ? `<${inReplyTo}>` : null,
    references: parseReferences(headers.get("references")).map((id) => `<${id}>`),
    from,
    to: addressList(headers.get("to")),
    cc: addressList(headers.get("cc")),
    subject,
    sentAt,
    ...body,
    attachments: parsed.attachments,
    sizeBytes: Math.max(options.sizeBytes ?? 0, buffer.length),
    headersFingerprint: computeHeadersFingerprint({
      from: from?.address ?? null,
      date: sentAt ? sentAt.toISOString() : rawDate,
      subject,
      messageId,
    }),
    truncated,
  };
}

// ---------------------------------------------------------------------------------------------
// Reduction for analysis

export interface ReduceOptions {
  maxChars: number;
  /** Budget for `quotedContext`; defaults to a third of maxChars (200–1500). */
  maxQuotedChars?: number;
}

export interface ReducedText {
  text: string;
  /** Beginning of the most recent quoted message, kept as context for the reply. */
  quotedContext: string | null;
  signatureRemoved: boolean;
  truncated: boolean;
}

const ATTRIBUTION_PATTERNS = [
  /^\s*Am\s.{4,240}?\s(?:schrieb\s.{1,240}|hat\s.{1,240}\sgeschrieben)\s*:\s*$/i,
  /^\s*On\s.{4,240}?\swrote\s*:\s*$/i,
  /^\s*Le\s.{4,240}?\sa\s+écrit\s*:\s*$/i,
  /^.{1,240}\sschrieb\s+am\s.{4,120}:\s*$/i,
];
const ATTRIBUTION_START = /^\s*(?:Am|On|Le)\s/i;
const ATTRIBUTION_VERB = /schrieb|geschrieben|wrote|écrit/i;
/** A date (21.10.2026, 2026-10-21, 22 oct. 2026, Oct 22, 2026) or a time (09:12). */
const DATE_HINT = /\d{1,4}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}:\d{2}|\d{1,2}\.?\s+[a-zäöüéû]{3,}\.?\s+\d{4}|[a-z]{3,}\.?\s+\d{1,2},?\s+\d{4}/i;
const MAX_ATTRIBUTION_CHARS = 400;
const SENTENCE_END = /[.!?]\s*$/;
/** "Max <max@example.org> wrote:" style lines only count when quoted lines follow. */
const LOOSE_ATTRIBUTION = /^.{1,240}\s(?:schrieb|wrote|a écrit)\s*:\s*$/i;
const HEADER_FROM = /^\s*\*?(?:Von|From|De|Absender)\s*:\*?\s*\S/i;
const HEADER_FIELDS: Array<[string, RegExp]> = [
  ["date", /^\s*\*?(?:Gesendet|Sent|Datum|Date|Envoyé|Envoy)\s*:/i],
  ["to", /^\s*\*?(?:An|To|À)\s*:/i],
  ["subject", /^\s*\*?(?:Betreff|Subject|Objet)\s*:/i],
  ["cc", /^\s*\*?(?:Cc|Kopie)\s*:/i],
];
const SEPARATOR =
  /^\s*[-_=*]{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Original-Nachricht|Originalnachricht|Message d'origine|Message original|Forwarded message|Weitergeleitete Nachricht|Message transféré|Nachricht weitergeleitet)\s*[-_=*]{2,}\s*$/i;
const FORWARD_HEADER =
  /^\s*(?:Begin forwarded message|Anfang der weitergeleiteten Nachricht|Début du message réexpédié|Début du message transféré)\s*:\s*$/i;
const UNDERSCORE_LINE = /^\s*_{8,}\s*$/;
/** RFC 3676 signature separator, kept verbatim by toLines(); a bare "--" needs a signature-like tail. */
const STRICT_DELIMITER = "-- ";
const MOBILE_SIGNATURE =
  /^\s*(?:Von meinem \S+(?: \S+)? gesendet|Gesendet von meinem \S+(?: \S+)?|Sent from my \S+(?: \S+)?|Envoyé de mon \S+(?: \S+)?|Get Outlook for (?:iOS|Android)|Outlook für (?:iOS|Android) herunterladen)\s*\.?\s*$/i;
const STRONG_GREETING = new RegExp(
  `^\\s*(?:${[
    "(?:mit\\s+)?(?:freundlichen|besten|herzlichen|lieben|vielen|schönen|sonnigen|kollegialen|freundliche|beste|herzliche|liebe|viele|schöne)\\s+(?:grüßen|grüssen|grüße|grüsse|gruß|gruss)(?:\\s+(?:aus|von|nach)\\s+.{1,40})?",
    "(?:grüße|grüsse|gruß|gruss)(?:\\s+(?:aus|von|nach)\\s+.{1,40})?",
    "mfg|lg|vg|bg|sg|hg",
    "(?:best|kind|warm|warmest|warmly)\\s+(?:regards|wishes)",
    "regards|sincerely|yours sincerely|yours truly|all the best",
    "(?:bien\\s+)?cordialement|(?:meilleures|sincères|cordiales)\\s+salutations|salutations|bien à vous|amicalement",
  ].join("|")})\\s*[,!.]?\\s*$`,
  "i",
);
const WEAK_GREETING =
  /^\s*(?:best|cheers|thanks|thank you|many thanks|thanks again|take care|danke|danke schön|vielen dank|herzlichen dank|merci|merci beaucoup|bises|à bientôt|ciao|tschüss)\s*[,!.]?\s*$/i;
const POSTSCRIPT = /^\s*(?:P\.?\s?(?:P\.?\s?)?S\.?|Nachtrag|Addendum)\s*[:.]/i;
/** Phone numbers, addresses, URLs and typical contact labels. */
const CONTACT_LINE = /\+?\d[\d ()/.-]{6,}\d|@|https?:\/\/|www\.|\b(?:tel|fon|phone|fax|mobil|mobile|handy|e-?mail|web)\b/i;

function quoteDepth(line: string): number {
  const match = /^\s*((?:>\s?)+)/.exec(line);
  return match ? (match[1] ?? "").replace(/\s/g, "").length : 0;
}

function stripQuoteLevel(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

/** Normalized lines; an exact "-- " line keeps its trailing space so it stays a strict delimiter. */
function toLines(bodyText: string): string[] {
  const raw = bodyText.replace(/\r\n?/g, "\n").replace(INVISIBLE_CHARS, "").replace(/\u00a0/g, " ").split("\n");
  const out: string[] = [];
  let blanks = 0;
  for (const line of raw) {
    const value = line === STRICT_DELIMITER ? line : line.trimEnd();
    if (value === "") {
      blanks += 1;
      if (blanks > 1 || out.length === 0) continue;
    } else {
      blanks = 0;
    }
    out.push(value);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Name, title, company, address or contact line – not a sentence or a request. */
function isSignatureLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.length > 80) return false;
  if (CONTACT_LINE.test(trimmed)) return true;
  if (/[?:!]$/.test(trimmed)) return false;
  // "Ja, kommt morgen." ends a sentence; "Beispiel Inc." or "Anna B." ends with an abbreviation.
  if (/\.$/.test(trimmed) && !/(?:^|\s)\S{1,3}\.$/.test(trimmed)) return false;
  if (trimmed.includes("|")) return true;
  return trimmed.split(/\s+/).length <= 3;
}

interface Boundary {
  index: number;
  headerLength: number;
}

/** Real attributions are short, contain the verb and a date or time. */
function isAttribution(text: string): boolean {
  return (
    text.length <= MAX_ATTRIBUTION_CHARS &&
    ATTRIBUTION_VERB.test(text) &&
    DATE_HINT.test(text) &&
    ATTRIBUTION_PATTERNS.some((re) => re.test(text))
  );
}

function attributionLength(lines: string[], i: number): number {
  const line = lines[i] ?? "";
  if (line.length > MAX_ATTRIBUTION_CHARS) return 0;
  if (isAttribution(line)) return 1;
  // Clients wrap long attributions; a line that ends a sentence is never continued.
  if (ATTRIBUTION_START.test(line) && !SENTENCE_END.test(line)) {
    let joined = line;
    for (let extra = 1; extra <= 2 && i + extra < lines.length; extra++) {
      const next = (lines[i + extra] ?? "").trim();
      if (!next) break;
      joined = `${joined} ${next}`;
      if (isAttribution(joined)) return extra + 1;
      if (SENTENCE_END.test(next)) break;
    }
  }
  if (LOOSE_ATTRIBUTION.test(line)) {
    const next = lines.slice(i + 1).find((candidate) => candidate.trim() !== "");
    if (next !== undefined && quoteDepth(next) > 0) return 1;
  }
  return 0;
}

/** Outlook-style header block: From plus date, recipient and subject lines. */
function headerBlockLength(lines: string[], i: number): number {
  if (!HEADER_FROM.test(lines[i] ?? "")) return 0;
  const seen = new Set<string>();
  let last = -1;
  for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
    for (const [name, re] of HEADER_FIELDS) {
      if (re.test(lines[j] ?? "")) {
        seen.add(name);
        last = j;
      }
    }
  }
  return seen.has("date") && seen.has("to") && seen.has("subject") ? last - i + 1 : 0;
}

function boundaryAt(lines: string[], i: number): number {
  const line = lines[i] ?? "";
  if (quoteDepth(line) > 0) return 0;
  if (SEPARATOR.test(line) || FORWARD_HEADER.test(line)) {
    const next = lines.findIndex((candidate, j) => j > i && candidate.trim() !== "");
    const block = next >= 0 ? headerBlockLength(lines, next) : 0;
    return block > 0 ? next + block - i : 1;
  }
  if (UNDERSCORE_LINE.test(line)) {
    const next = lines.findIndex((candidate, j) => j > i && candidate.trim() !== "");
    const block = next >= 0 ? headerBlockLength(lines, next) : 0;
    return block > 0 ? next + block - i : 0;
  }
  return attributionLength(lines, i) || headerBlockLength(lines, i);
}

function findBoundary(lines: string[]): Boundary | null {
  for (let i = 0; i < lines.length; i++) {
    const length = boundaryAt(lines, i);
    if (length > 0) return { index: i, headerLength: length };
  }
  return null;
}

function collapseLines(lines: string[]): string {
  return lines
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isDelimiter(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (line === STRICT_DELIMITER) return true;
  if (line.trim() !== "--") return false;
  const tail = lines.slice(index + 1).filter((candidate) => candidate.trim());
  return tail.length > 0 && tail.length <= 12 && tail.every(isSignatureLine);
}

/** Own (unquoted, non-attribution) content that would remain after cutting. */
function hasOwnContent(lines: string[]): boolean {
  return lines.some((line, index) => line.trim() !== "" && quoteDepth(line) === 0 && boundaryAt(lines, index) === 0);
}

function removeSignature(lines: string[]): { lines: string[]; removed: boolean } {
  let removed = false;
  let result = lines;
  const delimiter = result.findIndex((_, index) => index > 0 && isDelimiter(result, index));
  if (delimiter > 0) {
    result = result.slice(0, delimiter);
    removed = true;
  }
  const withoutMobile = result.filter((line) => !MOBILE_SIGNATURE.test(line));
  if (withoutMobile.length !== result.length) {
    result = withoutMobile;
    removed = true;
  }
  const contentIndexes = result.map((line, index) => (line.trim() ? index : -1)).filter((index) => index >= 0);
  for (const index of contentIndexes.slice(-12)) {
    const line = result[index] ?? "";
    const strong = STRONG_GREETING.test(line);
    if (!strong && !WEAK_GREETING.test(line)) continue;
    const rest = result.slice(index + 1);
    const postscript = rest.findIndex((candidate) => POSTSCRIPT.test(candidate));
    const tail = (postscript >= 0 ? rest.slice(0, postscript) : rest).filter((candidate) => candidate.trim());
    // Only a closing block counts: what follows must look like name/contact lines, not text.
    if (tail.length > (strong ? 10 : 4) || !tail.every(isSignatureLine)) continue;
    result = [...result.slice(0, index), ...(postscript >= 0 ? ["", ...rest.slice(postscript)] : [])];
    removed = true;
    break;
  }
  if (removed && !hasOwnContent(result) && hasOwnContent(lines)) return { lines, removed: false };
  return { lines: result, removed };
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const floor = Math.floor(max * 0.7);
  const paragraph = cut.lastIndexOf("\n\n");
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  const space = cut.lastIndexOf(" ");
  const at = paragraph >= floor ? paragraph : sentence >= floor ? sentence + 1 : space >= floor ? space : max;
  return { text: cut.slice(0, at).trimEnd(), truncated: true };
}

/** First quoted message only: older nested quotes and the quoted signature are dropped. */
function extractQuoted(quoted: string[], headerLength: number, maxChars: number): string | null {
  if (quoted.length === 0) return null;
  const header = quoted
    .slice(0, headerLength)
    .map((line) => line.trim())
    .filter((line) => !SEPARATOR.test(line) && !FORWARD_HEADER.test(line) && !UNDERSCORE_LINE.test(line));
  const rest = quoted.slice(headerLength);
  const isQuotedStyle = rest.some((line) => quoteDepth(line) > 0);
  const lines = isQuotedStyle ? rest.map(stripQuoteLevel) : rest;
  const body: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const original = rest[i] ?? "";
    const line = lines[i] ?? "";
    if (isQuotedStyle && original.trim() !== "" && quoteDepth(original) === 0) break;
    if (quoteDepth(line) > 0) break;
    if (line.trim() && boundaryAt(lines, i) > 0) break;
    body.push(line);
  }
  const cleaned = removeSignature(body).lines;
  const text = collapseLines([...header, ...cleaned]);
  if (!text) return null;
  const limited = truncateText(text, maxChars);
  return limited.truncated ? `${limited.text} …` : limited.text;
}

/**
 * True for inline or bottom-posted replies: below a ">"-quoted block the author writes again.
 * Even a short "Ok" counts; only greeting, contact and signature blocks (or anything after a
 * signature delimiter or a further attribution) do not – unless nothing was written above.
 */
function continuesAfterQuote(lines: string[], boundary: Boundary): boolean {
  const start = boundary.index + boundary.headerLength;
  const firstQuote = lines.findIndex((line, index) => index >= start && quoteDepth(line) > 0);
  if (firstQuote < 0) return false;
  let inSignature = false;
  let trailing = false;
  for (let i = firstQuote + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (isDelimiter(lines, i)) break;
    if (!trimmed) continue;
    if (quoteDepth(line) > 0) {
      inSignature = false;
      continue;
    }
    if (boundaryAt(lines, i) > 0) break;
    if (MOBILE_SIGNATURE.test(line) || STRONG_GREETING.test(line) || WEAK_GREETING.test(line)) {
      inSignature = true;
      trailing = true;
      continue;
    }
    if (CONTACT_LINE.test(trimmed) || trimmed.includes("|") || (inSignature && isSignatureLine(line))) {
      trailing = true;
      continue;
    }
    return true;
  }
  return trailing && !hasOwnContent(lines.slice(0, boundary.index));
}

/** Splits trailing ">" lines (after the author's last own line) from the rest. */
function splitTrailingQuote(lines: string[]): { own: string[]; quoted: string[] } {
  let lastOwn = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() && quoteDepth(line) === 0) {
      lastOwn = i;
      break;
    }
  }
  return { own: lines.slice(0, lastOwn + 1), quoted: lines.slice(lastOwn + 1) };
}

/**
 * Reduces a mail body to what an analysis needs: own text without signature and quote history,
 * plus the beginning of the most recent quoted message as `quotedContext`.
 * Recognizes "Am … schrieb …:", "On … wrote:", "Le … a écrit :" (with date or time), ">" quotes
 * and Outlook "Von:/From:" header blocks. Inline and bottom-posted replies keep the quoted lines
 * they answer (quote level 1) as context; pure forwards keep the forwarded message as text.
 */
export function reduceForAnalysis(bodyText: string, options: ReduceOptions): ReducedText {
  const maxChars = Math.max(1, Math.floor(options.maxChars));
  const maxQuoted = Math.max(1, Math.floor(options.maxQuotedChars ?? Math.min(1500, Math.max(200, Math.floor(maxChars / 3)))));
  const lines = toLines(bodyText);
  const boundary = findBoundary(lines);
  let own: string[];
  let quoted: string[];
  let headerLength = 0;
  if (boundary && !continuesAfterQuote(lines, boundary)) {
    own = lines.slice(0, boundary.index);
    quoted = lines.slice(boundary.index);
    headerLength = boundary.headerLength;
  } else {
    ({ own, quoted } = splitTrailingQuote(lines));
  }
  own = own.filter((line) => quoteDepth(line) < 2);
  const ownText = collapseLines(own);
  if (!hasOwnContent(own)) {
    const forwarded = extractQuoted(quoted, headerLength, maxChars) ?? (ownText || null);
    const result = truncateText(forwarded ?? "", maxChars);
    return { text: result.text, quotedContext: null, signatureRemoved: false, truncated: result.truncated };
  }
  const signature = removeSignature(own);
  let text = collapseLines(signature.lines);
  let signatureRemoved = signature.removed;
  if (!text) {
    text = ownText;
    signatureRemoved = false;
  }
  const limited = truncateText(text, maxChars);
  return {
    text: limited.text,
    quotedContext: extractQuoted(quoted, headerLength, maxQuoted),
    signatureRemoved,
    truncated: limited.truncated,
  };
}
