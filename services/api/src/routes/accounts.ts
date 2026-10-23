import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  Account,
  AccountCheck,
  AccountPatch,
  ErrorBody,
  Folder,
  FolderSelection,
  ImapAccountCreate,
  OAuthStart,
  type AccountCapabilities,
  type FolderRole,
} from "@mailpilot/contracts";
import { recordChange, schema, userTransaction, type CredentialCipher, type Database, type StoredCredentials, type Tx } from "@mailpilot/database";
import type { Config } from "../config.js";
import { ApiError, badRequest, notFound } from "../errors.js";
import type { JobQueue } from "../queue.js";
import { loadAccountDtos } from "../domain/accounts-query.js";
import { authOf, type Router } from "./types.js";

const { mailAccounts, mailFolders, oauthStates } = schema;
type AccountRow = typeof mailAccounts.$inferSelect;

export interface ProbedFolder {
  providerFolderId: string;
  path: string;
  name: string;
  role: FolderRole;
  uidValidity: bigint | null;
}

export interface ProbeResult {
  capabilities: AccountCapabilities;
  folders: ProbedFolder[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  email: string;
  displayName: string | null;
}

export interface OAuthProvider {
  /** Builds the provider URL with PKCE (S256) from the verifier; `withMarker` requests write access for markers. */
  authorizationUrl(input: { state: string; codeVerifier: string; redirectUri: string; loginHint?: string | undefined; withMarker: boolean }): string;
  exchange(input: { code: string; codeVerifier: string; redirectUri: string; withMarker: boolean }): Promise<OAuthTokens>;
}

export interface SetupSuggestion {
  provider: "gmail" | "microsoft" | "imap" | "unknown";
  imap: { host: string; port: number; secure: boolean } | null;
  confidence: "known" | "probable" | "unknown";
  notes: string[];
}

/** Mail access is injected so routes stay testable and providers stay in @mailpilot/mail-connectors. */
export interface AccountServices {
  probeImap(input: { emailAddress: string; host: string; port: number; secure: boolean; username: string; password: string }): Promise<ProbeResult>;
  probeAccount(account: AccountRow): Promise<ProbeResult>;
  suggest(email: string): Promise<SetupSuggestion>;
  oauth: Partial<Record<"gmail" | "microsoft", OAuthProvider>>;
  /** Best effort: revoke the provider grant when an account is removed. */
  revoke?(account: AccountRow, credentials: StoredCredentials): Promise<void>;
}

const notConfigured = (): never => {
  throw new ApiError(503, "mail_not_configured", "Mail-Anbindung ist auf dem Server nicht eingerichtet");
};

/** A failed connection test is the user's to fix: message plus concrete action, never a 500. */
function connectionProblem(error: unknown): ApiError {
  const e = error as { code?: string; message?: string; userAction?: string };
  if (e && typeof e.userAction === "string") {
    return new ApiError(422, "connection_failed", e.message ?? "Verbindung fehlgeschlagen", { reason: e.code ?? null, action: e.userAction });
  }
  return new ApiError(502, "connection_failed", "Verbindung zum Mailserver fehlgeschlagen", { reason: null, action: "Angaben prüfen und erneut versuchen" });
}

const IdParam = z.object({ id: z.uuid() });
const WRITE_MARKERS = new Set(["gmail_label", "graph_category", "graph_flag"]);
const ProviderParam = z.object({ provider: z.enum(["gmail", "microsoft"]) });

const SetupSuggestionSchema = z
  .object({
    provider: z.enum(["gmail", "microsoft", "imap", "unknown"]),
    imap: z.object({ host: z.string(), port: z.number().int(), secure: z.boolean() }).nullable(),
    confidence: z.enum(["known", "probable", "unknown"]),
    notes: z.array(z.string()),
  })
  .meta({ id: "SetupSuggestion" });

/** Default selection: inbox, plus sent mail to recognize own replies. Spam and trash stay excluded. */
export const defaultSelected = (role: FolderRole, includeSent: boolean) => role === "inbox" || (includeSent && role === "sent");

async function storeFolders(tx: Tx, accountId: string, folders: ProbedFolder[], includeSent: boolean) {
  for (const f of folders) {
    await tx
      .insert(mailFolders)
      .values({
        accountId,
        providerFolderId: f.providerFolderId,
        path: f.path,
        name: f.name,
        role: f.role,
        selected: defaultSelected(f.role, includeSent),
        imapUidValidity: f.uidValidity,
      })
      .onConflictDoUpdate({
        target: [mailFolders.accountId, mailFolders.providerFolderId],
        set: { path: f.path, name: f.name, role: f.role, updatedAt: new Date() },
      });
  }
}

const folderDto = (f: typeof mailFolders.$inferSelect): Folder => ({
  id: f.id,
  accountId: f.accountId,
  name: f.name,
  path: f.path,
  role: f.role as FolderRole,
  selected: f.selected,
});

export function registerAccountRoutes(
  r: Router,
  deps: { config: Config; db: Database; queue: JobQueue; cipher: CredentialCipher; services: Partial<AccountServices> },
) {
  const { config, db, cipher } = deps;
  const svc = deps.services;
  const redirectUri = (provider: string) => `${config.PUBLIC_BASE_URL}/v1/oauth/callback/${provider}`;

  async function ownAccount(userId: string, id: string) {
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, id), eq(mailAccounts.userId, userId), isNull(mailAccounts.removedAt)));
    if (!row) throw notFound("Konto");
    return row;
  }

  async function accountDto(userId: string, id: string) {
    const [dto] = await loadAccountDtos(db, userId, [id]);
    if (!dto) throw notFound("Konto");
    return dto;
  }

  r.get("/v1/accounts", { schema: { tags: ["accounts"], summary: "Verbundene Postfächer", response: { 200: z.object({ accounts: z.array(Account) }) } } }, async (request) => ({
    accounts: await loadAccountDtos(db, authOf(request).userId),
  }));

  r.get(
    "/v1/accounts/setup-suggestion",
    {
      schema: {
        tags: ["accounts"],
        summary: "Anbieter und Zugangsweg zu einer Adresse vorschlagen (ohne Garantie, dass IMAP erlaubt ist)",
        querystring: z.object({ email: z.email() }),
        response: { 200: SetupSuggestionSchema },
      },
    },
    async (request) => (svc.suggest ?? notConfigured)(request.query.email),
  );

  r.post(
    "/v1/accounts/imap",
    {
      schema: {
        tags: ["accounts"],
        summary: "IMAP-Konto verbinden (Verbindung wird geprüft, Fähigkeiten erkannt)",
        body: ImapAccountCreate,
        response: { 200: Account, 400: ErrorBody, 409: ErrorBody, 422: ErrorBody, 502: ErrorBody },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const b = request.body;
      if (!svc.probeImap) notConfigured();
      const probe = await svc
        .probeImap!({ emailAddress: b.emailAddress, host: b.host, port: b.port, secure: b.secure, username: b.username, password: b.password })
        .catch((error: unknown) => {
          throw connectionProblem(error);
        });
      const id = await userTransaction(db, userId, async (tx) => {
        const existing = await tx
          .select({ id: mailAccounts.id })
          .from(mailAccounts)
          .where(and(eq(mailAccounts.userId, userId), eq(mailAccounts.provider, "imap"), eq(mailAccounts.emailAddress, b.emailAddress), isNull(mailAccounts.removedAt)));
        if (existing[0]) throw new ApiError(409, "account_exists", "Dieses Postfach ist bereits verbunden");
        const credentials: StoredCredentials = { kind: "imap", password: b.password };
        const [row] = await tx
          .insert(mailAccounts)
          .values({
            userId,
            provider: "imap",
            displayName: b.displayName,
            emailAddress: b.emailAddress,
            credentialsEnc: cipher.encrypt(credentials),
            imapHost: b.host,
            imapPort: b.port,
            imapSecure: b.secure,
            imapUsername: b.username,
            capabilities: probe.capabilities,
            initialImportDays: b.initialImportDays,
          })
          .returning();
        await storeFolders(tx, row!.id, probe.folders, true);
        await recordChange(tx, { userId, entityType: "account", entityId: row!.id, op: "upsert", version: row!.version });
        return row!.id;
      });
      return accountDto(userId, id);
    },
  );

  r.post(
    "/v1/accounts/oauth/:provider/start",
    {
      schema: {
        tags: ["accounts"],
        summary: "OAuth-Verbindung beginnen; die App öffnet die zurückgegebene URL",
        params: ProviderParam,
        body: z.object({ loginHint: z.email().optional(), accountId: z.uuid().optional(), withMarker: z.boolean().default(false) }),
        response: { 200: OAuthStart, 503: ErrorBody },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const provider = svc.oauth?.[request.params.provider];
      if (!provider) notConfigured();
      if (request.body.accountId) await ownAccount(userId, request.body.accountId);
      const state = randomBytes(24).toString("base64url");
      const codeVerifier = randomBytes(48).toString("base64url");
      await db.insert(oauthStates).values({
        userId,
        provider: request.params.provider,
        state,
        codeVerifier,
        access: request.body.withMarker ? "mark" : "read",
        accountId: request.body.accountId ?? null,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      return {
        state,
        authorizationUrl: provider!.authorizationUrl({
          state,
          codeVerifier,
          redirectUri: redirectUri(request.params.provider),
          loginHint: request.body.loginHint,
          withMarker: request.body.withMarker,
        }),
      };
    },
  );

  r.get(
    "/v1/oauth/callback/:provider",
    {
      schema: {
        tags: ["accounts"],
        summary: "OAuth-Rückruf des Anbieters; leitet in die App weiter",
        security: [],
        params: ProviderParam,
        querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const appUrl = (path: string, params: Record<string, string>) =>
        `${config.APP_URL_SCHEME}://${path}?${new URLSearchParams(params).toString()}`;
      const { code, state, error } = request.query;
      if (error || !code || !state) return reply.redirect(appUrl("accounts/error", { code: error ?? "missing_code" }));
      const provider = svc.oauth?.[request.params.provider];
      if (!provider) return reply.redirect(appUrl("accounts/error", { code: "not_configured" }));
      const [st] = await db.select().from(oauthStates).where(eq(oauthStates.state, state));
      if (!st || st.usedAt || st.expiresAt < new Date() || st.provider !== request.params.provider) {
        return reply.redirect(appUrl("accounts/error", { code: "state_invalid" }));
      }
      await db.update(oauthStates).set({ usedAt: new Date() }).where(eq(oauthStates.id, st.id));
      let tokens: OAuthTokens;
      try {
        tokens = await provider.exchange({
          code,
          codeVerifier: st.codeVerifier,
          redirectUri: redirectUri(request.params.provider),
          withMarker: st.access === "mark",
        });
      } catch (e) {
        request.log.warn({ err: e }, "oauth exchange failed");
        return reply.redirect(appUrl("accounts/error", { code: "exchange_failed" }));
      }
      const credentials: StoredCredentials = {
        kind: "oauth",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt?.toISOString() ?? null,
        scope: tokens.scope,
      };
      const accountId = await userTransaction(db, st.userId, async (tx) => {
        const existing = st.accountId
          ? (await tx.select().from(mailAccounts).where(and(eq(mailAccounts.id, st.accountId), eq(mailAccounts.userId, st.userId))))[0]
          : (
              await tx
                .select()
                .from(mailAccounts)
                .where(
                  and(
                    eq(mailAccounts.userId, st.userId),
                    eq(mailAccounts.provider, request.params.provider),
                    eq(mailAccounts.emailAddress, tokens.email),
                    isNull(mailAccounts.removedAt),
                  ),
                )
            )[0];
        if (existing) {
          const version = existing.version + 1;
          await tx
            .update(mailAccounts)
            .set({
              credentialsEnc: cipher.encrypt(credentials),
              status: existing.status === "paused" ? "paused" : "active",
              lastErrorCode: null,
              lastErrorMessage: null,
              lastErrorAction: null,
              lastErrorAt: null,
              version,
              updatedAt: new Date(),
            })
            .where(eq(mailAccounts.id, existing.id));
          await recordChange(tx, { userId: st.userId, entityType: "account", entityId: existing.id, op: "upsert", version });
          return existing.id;
        }
        const [row] = await tx
          .insert(mailAccounts)
          .values({
            userId: st.userId,
            provider: request.params.provider,
            displayName: tokens.displayName ?? tokens.email,
            emailAddress: tokens.email,
            credentialsEnc: cipher.encrypt(credentials),
          })
          .returning();
        await recordChange(tx, { userId: st.userId, entityType: "account", entityId: row!.id, op: "upsert", version: row!.version });
        return row!.id;
      });
      // Capabilities and folders are detected right away; failure here is shown on the account.
      try {
        const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
        if (row && svc.probeAccount) {
          const probe = await svc.probeAccount(row);
          await userTransaction(db, st.userId, async (tx) => {
            await storeFolders(tx, accountId, probe.folders, row.includeSent);
            const [updated] = await tx
              .update(mailAccounts)
              .set({ capabilities: probe.capabilities, version: sql`${mailAccounts.version} + 1`, updatedAt: new Date() })
              .where(eq(mailAccounts.id, accountId))
              .returning({ version: mailAccounts.version });
            await recordChange(tx, { userId: st.userId, entityType: "account", entityId: accountId, op: "upsert", version: updated!.version });
          });
        }
      } catch (e) {
        request.log.warn({ err: e }, "probe after oauth failed");
      }
      return reply.redirect(appUrl("accounts/connected", { accountId }));
    },
  );

  r.post(
    "/v1/accounts/:id/check",
    { schema: { tags: ["accounts"], summary: "Verbindung prüfen und Fähigkeiten neu erkennen", params: IdParam, response: { 200: AccountCheck } } },
    async (request) => {
      const { userId } = authOf(request);
      const row = await ownAccount(userId, request.params.id);
      if (!svc.probeAccount) notConfigured();
      try {
        const probe = await svc.probeAccount!(row);
        await userTransaction(db, userId, async (tx) => {
          await storeFolders(tx, row.id, probe.folders, row.includeSent);
          const version = row.version + 1;
          await tx
            .update(mailAccounts)
            .set({
              capabilities: probe.capabilities,
              status: row.status === "paused" ? "paused" : "active",
              lastErrorCode: null,
              lastErrorMessage: null,
              lastErrorAction: null,
              lastErrorAt: null,
              version,
              updatedAt: new Date(),
            })
            .where(eq(mailAccounts.id, row.id));
          await recordChange(tx, { userId, entityType: "account", entityId: row.id, op: "upsert", version });
        });
        return { ok: true, capabilities: probe.capabilities, problem: null, action: null };
      } catch (e) {
        const err = e as { code?: string; message?: string; userAction?: string };
        const needsReauth = err.code === "needs_reauth" || err.code === "auth_failed";
        await userTransaction(db, userId, async (tx) => {
          const version = row.version + 1;
          await tx
            .update(mailAccounts)
            .set({
              status: needsReauth ? "needs_reauth" : "error",
              lastErrorCode: err.code ?? "unknown",
              lastErrorMessage: err.message ?? "Verbindung fehlgeschlagen",
              lastErrorAction: err.userAction ?? null,
              lastErrorAt: new Date(),
              version,
              updatedAt: new Date(),
            })
            .where(eq(mailAccounts.id, row.id));
          await recordChange(tx, { userId, entityType: "account", entityId: row.id, op: "upsert", version });
        });
        return { ok: false, capabilities: null, problem: err.message ?? "Verbindung fehlgeschlagen", action: err.userAction ?? null };
      }
    },
  );

  r.patch(
    "/v1/accounts/:id",
    {
      schema: {
        tags: ["accounts"],
        summary: "Konto pausieren/fortsetzen, Aliasse, Importzeitraum, Mailmarkierung",
        params: IdParam,
        body: AccountPatch,
        response: { 200: Account, 400: ErrorBody },
      },
    },
    async (request) => {
      const { userId } = authOf(request);
      const row = await ownAccount(userId, request.params.id);
      const p = request.body;
      if (p.marker && p.marker.strategy !== "none") {
        const caps = row.capabilities as AccountCapabilities | null;
        if (!caps || !caps.supportedMarkers.includes(p.marker.strategy)) {
          throw badRequest("Dieses Konto unterstützt die gewählte Markierung nicht");
        }
        if (!p.marker.acknowledgedLimitations) {
          throw badRequest("Bitte zuerst die Einschränkungen der Markierung bestätigen");
        }
        if (WRITE_MARKERS.has(p.marker.strategy)) {
          // Labels and categories need write access, which a read-only connection did not grant.
          const creds = row.credentialsEnc ? cipher.decrypt<StoredCredentials>(row.credentialsEnc) : null;
          const scope = creds?.kind === "oauth" ? (creds.scope ?? "") : "";
          if (!/gmail\.modify|Mail\.ReadWrite/i.test(scope)) {
            throw new ApiError(409, "marker_needs_write_access", "Für diese Markierung das Konto erneut mit Schreibrecht für Markierungen verbinden");
          }
        }
      }
      await userTransaction(db, userId, async (tx) => {
        const version = row.version + 1;
        await tx
          .update(mailAccounts)
          .set({
            ...(p.displayName ? { displayName: p.displayName } : {}),
            ...(p.status ? { status: p.status } : {}),
            ...(p.aliases ? { aliases: p.aliases } : {}),
            ...(p.initialImportDays ? { initialImportDays: p.initialImportDays } : {}),
            ...(p.includeSent !== undefined ? { includeSent: p.includeSent } : {}),
            ...(p.marker
              ? {
                  markerStrategy: p.marker.strategy,
                  markerKeyword: p.marker.keyword,
                  markerFolder: p.marker.folder,
                  markerAcknowledged: p.marker.acknowledgedLimitations,
                }
              : {}),
            version,
            updatedAt: new Date(),
          })
          .where(eq(mailAccounts.id, row.id));
        await recordChange(tx, { userId, entityType: "account", entityId: row.id, op: "upsert", version });
      });
      return accountDto(userId, row.id);
    },
  );

  r.get(
    "/v1/accounts/:id/folders",
    { schema: { tags: ["accounts"], summary: "Ordner des Kontos", params: IdParam, response: { 200: z.object({ folders: z.array(Folder) }) } } },
    async (request) => {
      const row = await ownAccount(authOf(request).userId, request.params.id);
      const folders = await db.select().from(mailFolders).where(eq(mailFolders.accountId, row.id));
      return { folders: folders.map(folderDto) };
    },
  );

  r.put(
    "/v1/accounts/:id/folders",
    { schema: { tags: ["accounts"], summary: "Synchronisierte Ordner wählen", params: IdParam, body: FolderSelection, response: { 200: z.object({ folders: z.array(Folder) }) } } },
    async (request) => {
      const { userId } = authOf(request);
      const row = await ownAccount(userId, request.params.id);
      const selected = new Set(request.body.selectedFolderIds);
      const folders = await userTransaction(db, userId, async (tx) => {
        const all = await tx.select().from(mailFolders).where(eq(mailFolders.accountId, row.id));
        for (const f of all) {
          const want = selected.has(f.id);
          if (want !== f.selected) await tx.update(mailFolders).set({ selected: want, updatedAt: new Date() }).where(eq(mailFolders.id, f.id));
        }
        return tx.select().from(mailFolders).where(eq(mailFolders.accountId, row.id));
      });
      return { folders: folders.map(folderDto) };
    },
  );

  r.delete(
    "/v1/accounts/:id",
    { schema: { tags: ["accounts"], summary: "Konto entfernen: Zugang wird widerrufen, Aufgaben bleiben", params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } } },
    async (request) => {
      const { userId } = authOf(request);
      const row = await ownAccount(userId, request.params.id);
      const credentials = row.credentialsEnc ? cipher.decrypt<StoredCredentials>(row.credentialsEnc) : null;
      await userTransaction(db, userId, async (tx) => {
        const version = row.version + 1;
        await tx
          .update(mailAccounts)
          .set({ status: "removed", removedAt: new Date(), credentialsEnc: null, version, updatedAt: new Date() })
          .where(eq(mailAccounts.id, row.id));
        await recordChange(tx, { userId, entityType: "account", entityId: row.id, op: "delete", version });
      });
      if (credentials && svc.revoke) {
        await svc.revoke(row, credentials).catch((error: unknown) => request.log.warn({ err: error }, "revoking provider access failed"));
      }
      return { ok: true };
    },
  );
}
