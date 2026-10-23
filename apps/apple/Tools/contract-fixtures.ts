/**
 * Schreibt Beispielantworten und erwartete Request-Bodies für die Swift-Tests nach
 * MailPilotKit/Tests/MailPilotKitTests/Fixtures/ und prüft jede Datei mit den Zod-Schemas aus packages/contracts
 * (aus denen docs/openapi.json exportiert wird). Bricht ab, wenn ein Beispiel nicht dem Vertrag entspricht.
 * Antworten mit Inline-Schema in den Routen (z. B. `{ runs: ScanRun[] }`) werden über ihre exportierten Teilschemas geprüft.
 *
 *   node_modules/.bin/tsx apps/apple/Tools/contract-fixtures.ts   (im Repository-Wurzelverzeichnis)
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "../../../packages/contracts/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../MailPilotKit/Tests/MailPilotKitTests/Fixtures");


type Issue = { path: PropertyKey[]; message: string };
type Validator = { safeParse(value: unknown): { success: true } | { success: false; error: { issues: Issue[] } } };
const fail = (message: string, path: PropertyKey[] = []) => ({ success: false as const, error: { issues: [{ path, message }] } });
/** `{ key: Schema[] }` wie in den Routen (services/api/src/routes/*.ts). */
const listOf = (key: string, item: Validator): Validator => ({
  safeParse(value) {
    const list = (value as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(list)) return fail("Liste fehlt", [key]);
    for (const [index, entry] of list.entries()) {
      const r = item.safeParse(entry);
      if (!r.success) return fail(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), [key, index]);
    }
    return { success: true };
  },
});
/** Objekt mit Teilschemas je Feld; `null` erlaubt, wenn `nullable`. */
const shape = (fields: Record<string, { schema: Validator; nullable?: boolean }>): Validator => ({
  safeParse(value) {
    if (typeof value !== "object" || value === null) return fail("Objekt erwartet");
    for (const [key, { schema, nullable }] of Object.entries(fields)) {
      const v = (value as Record<string, unknown>)[key];
      if (v === null && nullable) continue;
      const r = schema.safeParse(v);
      if (!r.success) return fail(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), [key]);
    }
    return { success: true };
  },
});
const uuid: Validator = { safeParse: (v) => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? { success: true } : fail("UUID erwartet")) };
/** SetupSuggestion ist nur in services/api/src/routes/accounts.ts definiert (nicht exportiert); gleiche Regeln hier. */
const setupSuggestion: Validator = {
  safeParse(value) {
    const v = value as Record<string, unknown>;
    if (!["gmail", "microsoft", "imap", "unknown"].includes(v?.provider as string)) return fail("provider", ["provider"]);
    if (!["known", "probable", "unknown"].includes(v.confidence as string)) return fail("confidence", ["confidence"]);
    if (!Array.isArray(v.notes) || !v.notes.every((n) => typeof n === "string")) return fail("notes", ["notes"]);
    const imap = v.imap as Record<string, unknown> | null;
    if (imap !== null && (typeof imap?.host !== "string" || !Number.isInteger(imap.port) || typeof imap.secure !== "boolean")) return fail("imap", ["imap"]);
    return { success: true };
  },
};

const userId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const accountA = "11111111-1111-4111-8111-111111111111";
const accountB = "11111111-1111-4111-8111-222222222222";
const message1 = "22222222-2222-4222-8222-222222222221";
const message2 = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333331";
const task2 = "33333333-3333-4333-8333-333333333332";
const note1 = "44444444-4444-4444-8444-444444444441";
const note2 = "44444444-4444-4444-8444-444444444442";
const item1 = "55555555-5555-4555-8555-555555555551";
const item2 = "55555555-5555-4555-8555-555555555552";
const clar1 = "66666666-6666-4666-8666-666666666661";
const rule1 = "77777777-7777-4777-8777-777777777771";
const event = (n: number) => `88888888-8888-4888-8888-88888888888${n}`;
const source = (n: number) => `99999999-9999-4999-8999-99999999999${n}`;

const deadline = { date: "2026-11-02", dateTime: null, precision: "date", kind: "explicit", sourceQuote: "jusqu'à lundi 2 novembre" } as const;

const task = {
  id: taskId,
  version: 7,
  origin: "ai",
  status: "doing",
  waiting: true,
  waitingCheckAt: "2026-10-30",
  snoozedUntil: "2026-10-24T08:00:00+02:00",
  plannedFor: "2026-10-26",
  sortKey: 1.5,
  title: "Studienbescheinigung an Claire schicken",
  nextStep: "PDF im Studierendenportal laden und an Claire senden",
  summary: "Die Hochschule bittet um eine aktuelle Studienbescheinigung für das Austauschprogramm.",
  priority: "critical",
  priorityReason: "Belegte Frist; ohne Bescheinigung verfällt der Platz.",
  priorityIsManual: false,
  deadline,
  deadlineIsManual: false,
  why: "Du bist direkt adressiert. Im zweiten Absatz wirst du gebeten, die Bescheinigung zu schicken.",
  requiresAttachmentReading: true,
  estimatedMinutes: 15,
  estimateSource: "estimate",
  ai: {
    title: "Studienbescheinigung an Claire schicken",
    nextStep: "PDF im Studierendenportal laden und an Claire senden",
    summary: "Die Hochschule bittet um eine aktuelle Studienbescheinigung für das Austauschprogramm.",
    priority: "critical",
    priorityReason: "Belegte Frist; ohne Bescheinigung verfällt der Platz.",
    deadline,
    why: "Du bist direkt adressiert. Im zweiten Absatz wirst du gebeten, die Bescheinigung zu schicken.",
  },
  manual: { title: null, nextStep: null, priority: null, deadline: null, deadlineCleared: false },
  accountIds: [accountA],
  primarySource: {
    messageId: message1,
    accountId: accountA,
    subject: "Attestation de scolarité",
    fromName: "Claire Dubois",
    fromAddress: "claire.dubois@univ.example",
    sentAt: "2026-10-20T11:15:00+02:00",
  },
  sourceCount: 2,
  openClarifications: 1,
  latestChange: "Die Frist wurde von Freitag auf Montag verschoben.",
  doneAt: null,
  dismissedAt: null,
  mergedIntoTaskId: null,
  createdAt: "2026-10-20T09:20:00.000Z",
  updatedAt: "2026-10-22T16:05:12.345Z",
};

const manualTask = {
  ...task,
  id: task2,
  version: 1,
  origin: "manual",
  status: "todo",
  waiting: false,
  waitingCheckAt: null,
  snoozedUntil: null,
  plannedFor: null,
  sortKey: null,
  title: "Fahrradschloss kaufen",
  nextStep: null,
  summary: null,
  priority: "can_wait",
  priorityReason: "Von dir festgelegt",
  priorityIsManual: true,
  deadline: { date: null, dateTime: "2026-10-30T17:00:00.000Z", precision: "datetime", kind: "explicit", sourceQuote: null },
  deadlineIsManual: true,
  why: null,
  requiresAttachmentReading: false,
  estimatedMinutes: 30,
  estimateSource: "user",
  ai: { title: null, nextStep: null, summary: null, priority: null, priorityReason: null, deadline: null, why: null },
  manual: { title: "Fahrradschloss kaufen", nextStep: null, priority: "can_wait", deadline: { date: null, dateTime: "2026-10-30T17:00:00.000Z", precision: "datetime" }, deadlineCleared: false },
  accountIds: [],
  primarySource: null,
  sourceCount: 0,
  openClarifications: 0,
  latestChange: null,
  createdAt: "2026-10-21T18:00:00Z",
  updatedAt: "2026-10-21T18:00:00Z",
};

const noteA = { id: note1, taskId, version: 2, body: "Bescheinigung im Portal angefragt.", conflictOfNoteId: null, createdAt: "2026-10-21T07:00:00.000Z", updatedAt: "2026-10-22T07:30:00.000Z" };
const noteB = { id: note2, taskId, version: 1, body: "Bescheinigung angefragt, kommt per Post.", conflictOfNoteId: note1, createdAt: "2026-10-22T07:31:00.000Z", updatedAt: "2026-10-22T07:31:00.000Z" };
const itemA = { id: item1, taskId, version: 2, title: "PDF herunterladen", done: true, position: 1, source: "ai", createdAt: "2026-10-20T09:20:00.000Z", updatedAt: "2026-10-21T08:00:00.000Z" };
const itemB = { id: item2, taskId, version: 1, title: "An Claire senden", done: false, position: 2, source: "user", createdAt: "2026-10-21T08:01:00.000Z", updatedAt: "2026-10-21T08:01:00.000Z" };

const clarification = {
  id: clar1,
  version: 1,
  kind: "membership",
  status: "open",
  question: "Diese Mail betrifft die Gruppe B2. Gehörst du dazu?",
  reason: "Nur Mitglieder der Gruppe müssen das Formular abgeben.",
  excerpt: "Les étudiants du groupe B2 doivent rendre le formulaire.",
  options: [
    { id: "yes", label: "Ja", scope: "permanent" },
    { id: "no", label: "Nein", scope: "permanent" },
    { id: "not_this_time", label: "Diesmal nicht", scope: "once" },
    { id: "later", label: "Weiß ich noch nicht", scope: "once" },
  ],
  allowFreeText: true,
  taskId,
  messageId: message2,
  answer: null,
  createdAt: "2026-10-22T06:00:00.000Z",
  updatedAt: "2026-10-22T06:00:00.000Z",
};

const capabilities = {
  incrementalSync: "imap_condstore",
  customKeywords: true,
  flagged: true,
  labels: false,
  categories: false,
  copyToFolder: true,
  webLinks: false,
  immutableIds: false,
  supportedMarkers: ["none", "imap_keyword", "imap_flagged", "imap_copy_folder"],
  notes: ["Eigene Schlüsselwörter zeigt Apple Mail nicht an."],
};

const account = {
  id: accountA,
  version: 3,
  provider: "imap",
  displayName: "Hochschule",
  emailAddress: "student@univ.example",
  aliases: ["student@univ.example"],
  status: "error",
  capabilities,
  marker: { strategy: "imap_keyword", keyword: "MailPilot", folder: null, acknowledgedLimitations: true },
  markerReliable: false,
  initialImportDays: 14,
  includeSent: true,
  lastSuccessfulFetchAt: "2026-10-22T05:00:03.000Z",
  lastSuccessfulAnalysisAt: "2026-10-22T05:01:10.000Z",
  pendingAnalysisCount: 4,
  markerFailures: 1,
  lastError: { code: "auth_failed", message: "Anmeldung beim Mailserver fehlgeschlagen", at: "2026-10-23T05:00:01.000Z", action: "Passwort prüfen" },
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-23T05:00:01.000Z",
};

const gmailAccount = {
  ...account,
  id: accountB,
  version: 1,
  provider: "gmail",
  displayName: "Privat",
  emailAddress: "privat@gmail.example",
  aliases: [],
  status: "active",
  capabilities: null,
  marker: { strategy: "none", keyword: null, folder: null, acknowledgedLimitations: false },
  markerReliable: true,
  lastError: null,
  pendingAnalysisCount: 0,
  markerFailures: 0,
};

const settings = {
  version: 2,
  timezone: "Europe/Paris",
  scanEnabled: true,
  scanTime: "07:00",
  extraScanIntervalMinutes: null,
  aiMonthlyBudgetCents: 500,
  maxMessageChars: 20000,
  maxAttachmentBytes: 5000000,
  notifyDailyDigest: true,
  notifyUrgentDeadlines: false,
  notifyClarifications: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
};

const rule = {
  id: rule1,
  version: 1,
  kind: "membership",
  subject: "B2",
  value: { applies: true, note: null },
  description: "Du gehörst zu „B2“",
  sourceClarificationId: clar1,
  createdAt: "2026-10-22T06:10:00.000Z",
  updatedAt: "2026-10-22T06:10:00.000Z",
};

const messageSummary = {
  id: message1,
  accountId: accountA,
  subject: "Attestation de scolarité",
  from: { name: "Claire Dubois", address: "claire.dubois@univ.example" },
  sentAt: "2026-10-20T11:15:00+02:00",
  snippet: "Bonjour, merci de nous envoyer votre attestation…",
  language: "fr",
  hasAttachments: true,
  analysisStatus: "analyzed",
  taskIds: [taskId],
  folders: ["INBOX"],
  deleted: false,
};

const responses: Array<[string, Validator, unknown]> = [
  ["task-detail.json", C.TaskDetail, {
    task,
    sources: [
      {
        id: source(1), taskId, messageId: message1, accountId: accountA, role: "origin", addedBy: "ai",
        subject: "Attestation de scolarité", fromName: "Claire Dubois", fromAddress: "claire.dubois@univ.example", sentAt: "2026-10-20T11:15:00+02:00",
        evidenceQuotes: ["Merci de nous envoyer votre attestation de scolarité avant vendredi."],
        attachments: [{ filename: "formulaire.pdf", contentType: "application/pdf", size: 183204 }],
        changeSummary: null, createdAt: "2026-10-20T09:20:00.000Z",
      },
      {
        id: source(2), taskId, messageId: message2, accountId: accountA, role: "update", addedBy: "ai",
        subject: "RE: Attestation de scolarité", fromName: "Claire Dubois", fromAddress: "claire.dubois@univ.example", sentAt: "2026-10-22T08:00:00Z",
        evidenceQuotes: ["Vous pouvez l'envoyer jusqu'à lundi 2 novembre."],
        attachments: [{ filename: null, contentType: "image/png", size: null }],
        changeSummary: "Frist von Freitag auf Montag verschoben", createdAt: "2026-10-22T08:05:00.000Z",
      },
    ],
    notes: [noteA, noteB],
    checklist: [itemA, itemB],
    events: [
      { id: event(1), taskId, kind: "created_auto", actor: "ai", messageId: message1, summary: "Automatisch angelegt", oldValue: null, newValue: null, createdAt: "2026-10-20T09:20:00.000Z" },
      { id: event(2), taskId, kind: "deadline_changed", actor: "ai", messageId: message2, summary: "Frist geändert", oldValue: "2026-10-30", newValue: { date: "2026-11-02", dateTime: null, precision: "date" }, createdAt: "2026-10-22T08:05:00.000Z" },
      { id: event(3), taskId, kind: "status_changed", actor: "user", messageId: null, summary: "Status: To Do → Doing", oldValue: "todo", newValue: "doing", createdAt: "2026-10-22T09:00:00.000Z" },
      { id: event(4), taskId, kind: "waiting_changed", actor: "user", messageId: null, summary: "Warte auf Antwort", oldValue: false, newValue: true, createdAt: "2026-10-22T09:01:00.000Z" },
      { id: event(5), taskId, kind: "correction", actor: "system", messageId: null, summary: "Korrektur", oldValue: 1, newValue: [2.5, "x", null], createdAt: "2026-10-22T09:02:00.000Z" },
    ],
  }],
  ["changes-snapshot.json", C.ChangesResponse, {
    changes: [
      { seq: "1042", entityType: "settings", entityId: userId, op: "upsert", version: 2, data: settings },
      { seq: "1042", entityType: "account", entityId: accountA, op: "upsert", version: 3, data: account },
      { seq: "1042", entityType: "account", entityId: accountB, op: "upsert", version: 1, data: gmailAccount },
      { seq: "1042", entityType: "task", entityId: taskId, op: "upsert", version: 7, data: task },
      { seq: "1042", entityType: "task", entityId: task2, op: "upsert", version: 1, data: manualTask },
      { seq: "1042", entityType: "note", entityId: note1, op: "upsert", version: 2, data: noteA },
      { seq: "1042", entityType: "note", entityId: note2, op: "upsert", version: 1, data: noteB },
      { seq: "1042", entityType: "checklist_item", entityId: item1, op: "upsert", version: 2, data: itemA },
      { seq: "1042", entityType: "checklist_item", entityId: item2, op: "upsert", version: 1, data: itemB },
      { seq: "1042", entityType: "clarification", entityId: clar1, op: "upsert", version: 1, data: clarification },
      { seq: "1042", entityType: "rule", entityId: rule1, op: "upsert", version: 1, data: rule },
    ],
    nextCursor: "1042",
    hasMore: false,
    resetRequired: false,
    serverTime: "2026-10-23T08:00:00.000Z",
  }],
  ["changes-delta.json", C.ChangesResponse, {
    changes: [
      { seq: "1043", entityType: "task", entityId: taskId, op: "upsert", version: 8, data: { ...task, version: 8, status: "done", doneAt: "2026-10-23T08:10:00.000Z", updatedAt: "2026-10-23T08:10:00.000Z" } },
      { seq: "1044", entityType: "note", entityId: note2, op: "delete", version: 2, data: null },
      { seq: "1045", entityType: "checklist_item", entityId: item2, op: "delete", version: 2, data: null },
      { seq: "1046", entityType: "task", entityId: task2, op: "delete", version: 2, data: null },
      { seq: "1047", entityType: "account", entityId: accountB, op: "delete", version: 2, data: null },
      { seq: "1048", entityType: "rule", entityId: rule1, op: "upsert", version: 2, data: { ...rule, version: 2, value: { applies: false, note: "Seit dem Wechsel in 3SN" }, description: "Du gehörst nicht zu „B2“" } },
      { seq: "1049", entityType: "clarification", entityId: clar1, op: "upsert", version: 2, data: { ...clarification, version: 2, status: "answered", answer: { optionId: "yes", text: null, scope: "permanent", answeredAt: "2026-10-23T08:11:00+02:00" } } },
    ],
    nextCursor: "1049",
    hasMore: true,
    resetRequired: false,
    serverTime: "2026-10-23T08:12:00.000Z",
  }],
  ["mutation-batch-result.json", C.MutationBatchResult, {
    results: [
      { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", status: "applied", entityType: "task", entityId: taskId, version: 8, conflictingFields: [], createdEntityId: null, error: null },
      { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", status: "duplicate", entityType: "task", entityId: task2, version: 1, conflictingFields: [], createdEntityId: null, error: null },
      { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", status: "conflict", entityType: "task", entityId: taskId, version: 9, conflictingFields: ["status"], createdEntityId: null, error: null },
      { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", status: "conflict", entityType: "note", entityId: note1, version: 3, conflictingFields: [], createdEntityId: note2, error: null },
      { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", status: "rejected", entityType: "checklist_item", entityId: item1, version: null, conflictingFields: [], createdEntityId: null, error: { code: "not_found", message: "Eintrag nicht gefunden" } },
    ],
  }],
  ["today.json", C.Today, {
    next: [task],
    moreUrgent: [],
    waitingCount: 1,
    canWaitCount: 3,
    openClarifications: 1,
    lastSuccessfulUpdateAt: "2026-10-23T07:00:04+02:00",
    pendingAnalysisCount: 12,
    accountsNeedingAttention: [{ accountId: accountA, displayName: "Hochschule", problem: "Anmeldung beim Mailserver fehlgeschlagen", action: "Passwort prüfen" }],
    generatedAt: "2026-10-23T08:00:00.000Z",
  }],
  ["message-detail.json", C.MessageDetail, {
    message: messageSummary,
    to: [{ name: null, address: "student@univ.example" }],
    cc: [{ name: "Scolarité", address: "scolarite@univ.example" }],
    bodyText: "Bonjour,\n\nmerci de nous envoyer votre attestation de scolarité avant vendredi.\n\nCordialement,\nClaire",
    bodyHtml: "<p>Bonjour,</p><p>merci de nous envoyer votre attestation de scolarité avant vendredi.</p>",
    remoteContentBlocked: 2,
    attachments: [{ filename: "formulaire.pdf", contentType: "application/pdf", size: 183204, inline: false }],
    open: {
      webLink: null,
      appleMailUrl: "message://%3C20261020091500.abc%40univ.example%3E",
      appleMailNote: "Öffnet Apple Mail nur, wenn die Mail dort mit derselben Message-ID vorliegt. Nicht garantiert.",
      searchHints: { from: "claire.dubois@univ.example", subject: "Attestation de scolarité", date: "20.10.2026", messageIdHeader: "<20261020091500.abc@univ.example>" },
    },
    markerStatus: "applied",
  }],
  ["message-list.json", C.MessageList, { messages: [messageSummary, { ...messageSummary, id: message2, subject: null, from: null, sentAt: null, snippet: null, language: null, hasAttachments: false, analysisStatus: "budget_paused", taskIds: [], folders: [], deleted: true }] }],
  ["session.json", C.SessionResponse, { token: "mp_dev_session_token_example", expiresAt: "2027-01-21T08:00:00.000Z", user: { id: userId, displayName: "Alex", email: null, devLogin: true, createdAt: "2026-10-01T10:00:00.000Z" } }],
  ["usage.json", C.Usage, { month: "2026-10", spentCents: 123.45, budgetCents: 500, budgetReached: false, pendingAnalysisCount: 12, analyzedThisMonth: 87, inputTokens: 512000, outputTokens: 64000 }],
  ["settings.json", C.Settings, settings],
  ["scan-list.json", listOf("runs", C.ScanRun), {
    runs: [
      { id: "abababab-abab-4bab-8bab-abababababa1", accountId: accountA, kind: "scan", trigger: "onboarding", status: "running", startedAt: "2026-10-23T08:00:01.000Z", finishedAt: null, stats: { fetched: 10, newMessages: 8, updatedMessages: 0, analyzed: 3, tasksCreated: 1, tasksUpdated: 0, clarifications: 1, skipped: 0, budgetPaused: 0, errors: 0 }, error: null, createdAt: "2026-10-23T08:00:00.000Z" },
      { id: "abababab-abab-4bab-8bab-abababababa2", accountId: null, kind: "analysis", trigger: "schedule", status: "failed", startedAt: null, finishedAt: "2026-10-22T05:10:00.000Z", stats: { fetched: 0, newMessages: 0, updatedMessages: 0, analyzed: 0, tasksCreated: 0, tasksUpdated: 0, clarifications: 0, skipped: 0, budgetPaused: 5, errors: 1 }, error: "KI-Budget erreicht", createdAt: "2026-10-22T05:00:00.000Z" },
    ],
  }],
  ["setup-suggestion.json", setupSuggestion, {
    provider: "imap", imap: { host: "imap.univ.example", port: 993, secure: true }, confidence: "probable", notes: ["Hochschulkonten erlauben IMAP nicht immer; ggf. bei der IT nachfragen."],
  }],
  ["oauth-start.json", C.OAuthStart, { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=abc&code_challenge=xyz", state: "abc" }],
  ["account-check.json", C.AccountCheck, { ok: false, capabilities: null, problem: "Anmeldung beim Mailserver fehlgeschlagen", action: "Konto erneut verbinden" }],
  ["accounts.json", listOf("accounts", C.Account), { accounts: [account, gmailAccount] }],
  ["folders.json", listOf("folders", C.Folder), { folders: [
    { id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc1", accountId: accountA, name: "INBOX", path: "INBOX", role: "inbox", selected: true },
    { id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc2", accountId: accountA, name: "Gesendet", path: "Sent", role: "sent", selected: true },
    { id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc3", accountId: accountA, name: "Junk", path: "Junk", role: "spam", selected: false },
  ] }],
  ["rules.json", listOf("rules", C.Rule), { rules: [rule] }],
  ["clarifications.json", listOf("clarifications", C.Clarification), { clarifications: [clarification] }],
  ["task-mutation-response.json", shape({ result: { schema: C.MutationResult }, task: { schema: C.Task, nullable: true } }), {
    result: { idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", status: "applied", entityType: "task", entityId: taskId, version: 8, conflictingFields: [], createdEntityId: null, error: null },
    task: { ...task, version: 8 },
  }],
  ["correction-result.json", shape({ task: { schema: C.Task }, mergeId: { schema: uuid, nullable: true } }), { task: manualTask, mergeId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcb1" }],
  ["error.json", C.ErrorBody, { error: { code: "idempotency_key_reused", message: "Idempotency-Key wurde für eine andere Änderung verwendet", details: { reason: "hash" } } }],
];

// Was die Swift-Typen erzeugen müssen (MailPilotKitTests/RequestEncodingTests.swift vergleicht 1:1).
const mutations = {
  mutations: [
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", clientTimestamp: "2026-10-23T08:00:00.000Z", type: "task.create", entityId: task2,
      payload: { title: "Formular abgeben", nextStep: "Unterschreiben und einscannen", priority: "important", deadline: { date: "2026-10-30", dateTime: null, precision: "date" } } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2", type: "task.update", entityId: taskId, baseVersion: 4,
      payload: { status: "doing", waiting: true, waitingCheckAt: "2026-10-28", snoozedUntil: "2026-10-24T06:00:00.000Z", plannedFor: null, sortKey: 2.5,
                 title: null, priority: null, deadline: { date: null, dateTime: "2026-10-30T11:00:00.000Z", precision: "datetime" }, estimatedMinutes: null } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd3", type: "task.update", entityId: taskId, baseVersion: 5, payload: { deadlineCleared: true } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4", type: "task.dismiss", entityId: taskId, baseVersion: 5 },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd5", type: "task.restore", entityId: taskId, baseVersion: 6 },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd6", clientTimestamp: "2026-10-23T08:01:00.000Z", type: "note.create", entityId: note1, payload: { taskId, body: "Unterlagen liegen im Ordner „Uni“." } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd7", type: "note.update", entityId: note1, baseVersion: 2, payload: { body: "Unterlagen liegen im Ordner „Uni/2026“." } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd8", type: "note.delete", entityId: note2, baseVersion: 3 },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-ddddddddddd9", type: "checklist.create", entityId: item1, payload: { taskId, title: "PDF herunterladen", position: 3 } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddd10", type: "checklist.update", entityId: item1, baseVersion: 1, payload: { done: true } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddd11", type: "checklist.delete", entityId: item2, baseVersion: 2 },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddd12", type: "clarification.answer", entityId: clar1, payload: { optionId: "yes", text: null, scope: "permanent" } },
    { idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddd13", type: "clarification.answer", entityId: clar1, payload: { optionId: null, text: "Nur für Gruppe B2", scope: "once" } },
  ],
};

const requestBodies: Array<{ name: string; schema: string; value: unknown }> = [
  { name: "taskCreate", schema: "TaskCreate", value: { id: task2, title: "Fahrradschloss kaufen", priority: "can_wait", deadline: { date: "2026-10-30", dateTime: null, precision: "date" }, note: "Im Laden am Bahnhof" } },
  { name: "accountPatchMarker", schema: "AccountPatch", value: { marker: { strategy: "imap_flagged", keyword: null, folder: null, acknowledgedLimitations: true } } },
  { name: "accountPatchPause", schema: "AccountPatch", value: { status: "paused", aliases: ["student@univ.example"], initialImportDays: 30, includeSent: false } },
  { name: "correctionNotATask", schema: "Correction", value: { kind: "not_a_task" } },
  { name: "correctionPriority", schema: "Correction", value: { kind: "wrong_priority", priority: "can_wait" } },
  { name: "correctionDeadlineNone", schema: "Correction", value: { kind: "wrong_deadline", deadline: null } },
  { name: "correctionBelongsTo", schema: "Correction", value: { kind: "belongs_to", taskId } },
  { name: "clarificationAnswer", schema: "ClarificationAnswer", value: { optionId: "not_this_time", text: null, scope: "once" } },
  { name: "settingsPatch", schema: "SettingsPatch", value: { scanTime: "06:30", extraScanIntervalMinutes: null, notifyUrgentDeadlines: true, quietHoursStart: "22:00", quietHoursEnd: null } },
  { name: "appleSignIn", schema: "AppleSignIn", value: { identityToken: "eyJraWQiOiJleGFtcGxlIiwiYWxnIjoiUlMyNTYifQ.payload.signature", nonce: "raw-nonce-1234567890", deviceName: "MacBook", platform: "macos", fullName: "Alex Muster" } },
  { name: "devSignIn", schema: "DevSignIn", value: { email: "dev@example.com", deviceName: "iPhone", platform: "ios" } },
  { name: "pushRegistration", schema: "PushRegistration", value: { token: "a1b2c3d4e5f60718", environment: "sandbox", platform: "ios" } },
  { name: "imapCreate", schema: "ImapAccountCreate", value: { displayName: "Hochschule", emailAddress: "student@univ.example", host: "imap.univ.example", port: 993, secure: true, username: "student", password: "app-spezifisches-passwort", initialImportDays: 14 } },
  { name: "messageToTask", schema: "MessageToTask", value: { title: "Formular abgeben" } },
  { name: "messageLink", schema: "MessageToTask", value: { linkToTaskId: taskId } },
  { name: "rulePatch", schema: "RulePatch", value: { applies: false, note: null } },
  { name: "folderSelection", schema: "FolderSelection", value: { selectedFolderIds: ["cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc1"] } },
  { name: "scanRequestAll", schema: "ScanRequest", value: {} },
];

const schemas: Record<string, Validator> = {
  TaskCreate: C.TaskCreate, AccountPatch: C.AccountPatch, Correction: C.Correction, ClarificationAnswer: C.ClarificationAnswer,
  SettingsPatch: C.SettingsPatch, AppleSignIn: C.AppleSignIn, DevSignIn: C.DevSignIn, PushRegistration: C.PushRegistration,
  ImapAccountCreate: C.ImapAccountCreate, MessageToTask: C.MessageToTask, RulePatch: C.RulePatch, FolderSelection: C.FolderSelection, ScanRequest: C.ScanRequest,
};

let failures = 0;
function check(name: string, schema: Validator, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    failures += 1;
    console.error(`✗ ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

for (const [file, schema, value] of responses) {
  check(file, schema, value);
  writeFileSync(join(dir, file), JSON.stringify(value, null, 2) + "\n");
}
check("mutations-expected.json (MutationBatch)", C.MutationBatch, mutations);
writeFileSync(join(dir, "mutations-expected.json"), JSON.stringify(mutations, null, 2) + "\n");
for (const body of requestBodies) check(`request-bodies.json#${body.name} (${body.schema})`, schemas[body.schema]!, body.value);
writeFileSync(join(dir, "request-bodies.json"), JSON.stringify(requestBodies, null, 2) + "\n");

if (failures > 0) {
  console.error(`${failures} Beispiel(e) verletzen den Vertrag.`);
  process.exit(1);
}
console.log(`Alle ${responses.length + 1 + requestBodies.length} Beispiele entsprechen den Zod-Schemas.`);
