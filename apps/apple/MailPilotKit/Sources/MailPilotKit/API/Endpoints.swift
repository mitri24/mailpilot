import Foundation

// Alle Client-Aufrufe aus docs/openapi.json. Pfade mit kleingeschriebenen UUIDs.
// `GET /v1/oauth/callback/{provider}` ruft nur der Browser des Anbieters auf.

public struct TaskQuery: Sendable, Hashable {
    public var statuses: [TaskStatus]?
    public var accountId: UUID?
    public var priority: Priority?
    public var due: BoardFilter.Due?
    public var waiting: Bool?
    public var search: String?
    public var limit: Int?

    public init(statuses: [TaskStatus]? = nil, accountId: UUID? = nil, priority: Priority? = nil, due: BoardFilter.Due? = nil,
                waiting: Bool? = nil, search: String? = nil, limit: Int? = nil) {
        self.statuses = statuses
        self.accountId = accountId
        self.priority = priority
        self.due = due
        self.waiting = waiting
        self.search = search
        self.limit = limit
    }
}

struct PatchTaskBody: Encodable, Sendable { var baseVersion: Int; var patch: TaskPatch }
struct BaseVersionBody: Encodable, Sendable { var baseVersion: Int }
struct MergeBody: Encodable, Sendable { var intoTaskId: UUID }
struct LinkSourceBody: Encodable, Sendable { var messageId: UUID }
struct NoteCreateBody: Encodable, Sendable { var id: UUID?; var body: String }
struct NoteUpdateBody: Encodable, Sendable { var baseVersion: Int; var body: String }
struct ChecklistCreateBody: Encodable, Sendable { var id: UUID?; var title: String }
struct ChecklistUpdateBody: Encodable, Sendable { var baseVersion: Int; var title: String?; var done: Bool?; var position: Double? }

extension UUID {
    /// Kanonische Schreibweise für Pfade und lokale Schlüssel.
    public var lowercased: String { uuidString.lowercased() }
}

public enum API {
    // MARK: Anmeldung

    public static func signInWithApple(_ body: AppleSignIn) -> Endpoint<SessionResponse> {
        Endpoint(.post, "/v1/auth/apple", body: .json(body), requiresAuth: false)
    }

    public static func devSignIn(_ body: DevSignIn) -> Endpoint<SessionResponse> {
        Endpoint(.post, "/v1/auth/dev", body: .json(body), requiresAuth: false)
    }

    public static func logout() -> Endpoint<OKResponse> { Endpoint(.post, "/v1/me/logout") }
    public static func me() -> Endpoint<UserProfile> { Endpoint(.get, "/v1/me") }

    // MARK: Aufgaben

    public static func tasks(_ q: TaskQuery = TaskQuery()) -> Endpoint<TaskList> {
        var query: [(String, String)] = []
        if let statuses = q.statuses { query.append(("status", statuses.map(\.rawValue).joined(separator: ","))) }
        if let accountId = q.accountId { query.append(("accountId", accountId.lowercased)) }
        if let priority = q.priority { query.append(("priority", priority.rawValue)) }
        if let due = q.due, due != .any { query.append(("due", due.rawValue)) }
        if let waiting = q.waiting { query.append(("waiting", waiting ? "true" : "false")) }
        if let search = q.search, !search.isEmpty { query.append(("search", search)) }
        if let limit = q.limit { query.append(("limit", String(limit))) }
        return Endpoint(.get, "/v1/tasks", query: query)
    }

    public static func createTask(_ body: TaskCreate, idempotencyKey: UUID) -> Endpoint<TaskItem> {
        Endpoint(.post, "/v1/tasks", body: .json(body), idempotencyKey: idempotencyKey)
    }

    public static func taskDetail(_ id: UUID) -> Endpoint<TaskDetail> { Endpoint(.get, "/v1/tasks/\(id.lowercased)") }

    public static func patchTask(_ id: UUID, baseVersion: Int, patch: TaskPatch, idempotencyKey: UUID) -> Endpoint<TaskMutationResponse> {
        Endpoint(.patch, "/v1/tasks/\(id.lowercased)", body: .json(PatchTaskBody(baseVersion: baseVersion, patch: patch)), idempotencyKey: idempotencyKey)
    }

    public static func dismissTask(_ id: UUID, baseVersion: Int, idempotencyKey: UUID) -> Endpoint<TaskMutationResponse> {
        Endpoint(.post, "/v1/tasks/\(id.lowercased)/dismiss", body: .json(BaseVersionBody(baseVersion: baseVersion)), idempotencyKey: idempotencyKey)
    }

    public static func restoreTask(_ id: UUID, baseVersion: Int, idempotencyKey: UUID) -> Endpoint<TaskMutationResponse> {
        Endpoint(.post, "/v1/tasks/\(id.lowercased)/restore", body: .json(BaseVersionBody(baseVersion: baseVersion)), idempotencyKey: idempotencyKey)
    }

    public static func mergeTask(_ id: UUID, into target: UUID, idempotencyKey: UUID) -> Endpoint<MergeResult> {
        Endpoint(.post, "/v1/tasks/\(id.lowercased)/merge", body: .json(MergeBody(intoTaskId: target)), idempotencyKey: idempotencyKey)
    }

    public static func undoMerge(_ mergeId: UUID) -> Endpoint<TaskItem> { Endpoint(.post, "/v1/merges/\(mergeId.lowercased)/undo") }

    public static func correctTask(_ id: UUID, _ correction: Correction, idempotencyKey: UUID) -> Endpoint<CorrectionResult> {
        Endpoint(.post, "/v1/tasks/\(id.lowercased)/corrections", body: .json(correction), idempotencyKey: idempotencyKey)
    }

    public static func linkSource(_ id: UUID, messageId: UUID) -> Endpoint<TaskItem> {
        Endpoint(.post, "/v1/tasks/\(id.lowercased)/sources", body: .json(LinkSourceBody(messageId: messageId)))
    }

    public static func unlinkSource(_ id: UUID, messageId: UUID) -> Endpoint<TaskItem> {
        Endpoint(.delete, "/v1/tasks/\(id.lowercased)/sources/\(messageId.lowercased)")
    }

    // MARK: Notizen und Checkliste (direkt; der Normalweg ist die Outbox)

    public static func createNote(taskId: UUID, noteId: UUID?, body: String, idempotencyKey: UUID) -> Endpoint<NoteMutationResponse> {
        Endpoint(.post, "/v1/tasks/\(taskId.lowercased)/notes", body: .json(NoteCreateBody(id: noteId, body: body)), idempotencyKey: idempotencyKey)
    }

    public static func updateNote(_ id: UUID, baseVersion: Int, body: String, idempotencyKey: UUID) -> Endpoint<ResultResponse> {
        Endpoint(.patch, "/v1/notes/\(id.lowercased)", body: .json(NoteUpdateBody(baseVersion: baseVersion, body: body)), idempotencyKey: idempotencyKey)
    }

    public static func deleteNote(_ id: UUID, baseVersion: Int, idempotencyKey: UUID) -> Endpoint<ResultResponse> {
        Endpoint(.delete, "/v1/notes/\(id.lowercased)", query: [("baseVersion", String(baseVersion))], idempotencyKey: idempotencyKey)
    }

    public static func createChecklistItem(taskId: UUID, itemId: UUID?, title: String, idempotencyKey: UUID) -> Endpoint<ChecklistMutationResponse> {
        Endpoint(.post, "/v1/tasks/\(taskId.lowercased)/checklist", body: .json(ChecklistCreateBody(id: itemId, title: title)), idempotencyKey: idempotencyKey)
    }

    public static func updateChecklistItem(_ id: UUID, baseVersion: Int, title: String? = nil, done: Bool? = nil, position: Double? = nil,
                                           idempotencyKey: UUID) -> Endpoint<ResultResponse> {
        Endpoint(.patch, "/v1/checklist/\(id.lowercased)",
                 body: .json(ChecklistUpdateBody(baseVersion: baseVersion, title: title, done: done, position: position)), idempotencyKey: idempotencyKey)
    }

    public static func deleteChecklistItem(_ id: UUID, baseVersion: Int, idempotencyKey: UUID) -> Endpoint<ResultResponse> {
        Endpoint(.delete, "/v1/checklist/\(id.lowercased)", query: [("baseVersion", String(baseVersion))], idempotencyKey: idempotencyKey)
    }

    // MARK: Synchronisierung

    public static func changes(cursor: String?, limit: Int = 500) -> Endpoint<ChangesResponse> {
        var query: [(String, String)] = []
        if let cursor { query.append(("cursor", cursor)) }
        query.append(("limit", String(limit)))
        return Endpoint(.get, "/v1/sync/changes", query: query)
    }

    /// Bytes der Outbox unverändert senden: gleiche Idempotency-Keys, gleicher Inhalt.
    public static func mutations(raw: [Data]) -> Endpoint<MutationBatchResult> {
        var body = Data("{\"mutations\":[".utf8)
        for (index, item) in raw.enumerated() {
            if index > 0 { body.append(UInt8(ascii: ",")) }
            body.append(item)
        }
        body.append(contentsOf: Array("]}".utf8))
        return Endpoint(.post, "/v1/sync/mutations", body: .raw(body))
    }

    // MARK: Mails

    public static func messages(_ q: MessageQuery = MessageQuery()) -> Endpoint<MessageList> {
        var query: [(String, String)] = []
        if let search = q.search, !search.isEmpty { query.append(("search", search)) }
        if let accountId = q.accountId { query.append(("accountId", accountId.lowercased)) }
        if let withoutTask = q.withoutTask { query.append(("withoutTask", withoutTask ? "true" : "false")) }
        query.append(("limit", String(q.limit)))
        if let before = q.before { query.append(("before", ISOTimestamp.format(before))) }
        return Endpoint(.get, "/v1/messages", query: query)
    }

    public static func message(_ id: UUID) -> Endpoint<MessageDetail> { Endpoint(.get, "/v1/messages/\(id.lowercased)") }

    public static func messageToTask(_ id: UUID, _ body: MessageToTask, idempotencyKey: UUID) -> Endpoint<TaskItem> {
        Endpoint(.post, "/v1/messages/\(id.lowercased)/task", body: .json(body), idempotencyKey: idempotencyKey)
    }

    // MARK: Heute, Rückfragen, Regeln

    public static func today() -> Endpoint<Today> { Endpoint(.get, "/v1/today") }

    public static func clarifications(status: ClarificationStatus = .open) -> Endpoint<ClarificationList> {
        Endpoint(.get, "/v1/clarifications", query: [("status", status.rawValue)])
    }

    public static func answerClarification(_ id: UUID, _ answer: ClarificationAnswer, idempotencyKey: UUID) -> Endpoint<ClarificationAnswerResponse> {
        Endpoint(.post, "/v1/clarifications/\(id.lowercased)/answer", body: .json(answer), idempotencyKey: idempotencyKey)
    }

    public static func rules() -> Endpoint<RuleList> { Endpoint(.get, "/v1/rules") }

    public static func patchRule(_ id: UUID, _ patch: RulePatch) -> Endpoint<Rule> {
        Endpoint(.patch, "/v1/rules/\(id.lowercased)", body: .json(patch))
    }

    public static func deleteRule(_ id: UUID) -> Endpoint<OKResponse> { Endpoint(.delete, "/v1/rules/\(id.lowercased)") }

    // MARK: Einstellungen, Verbrauch, Scans, Push

    public static func settings() -> Endpoint<UserSettings> { Endpoint(.get, "/v1/settings") }
    public static func patchSettings(_ patch: SettingsPatch) -> Endpoint<UserSettings> { Endpoint(.patch, "/v1/settings", body: .json(patch)) }
    public static func usage() -> Endpoint<Usage> { Endpoint(.get, "/v1/usage") }

    public static func startScan(accountId: UUID? = nil) -> Endpoint<ScanList> {
        Endpoint(.post, "/v1/scans", body: .json(ScanRequest(accountId: accountId)))
    }

    public static func scans(limit: Int = 20) -> Endpoint<ScanList> { Endpoint(.get, "/v1/scans", query: [("limit", String(limit))]) }
    public static func scan(_ id: UUID) -> Endpoint<ScanRun> { Endpoint(.get, "/v1/scans/\(id.lowercased)") }

    public static func registerPush(_ body: PushRegistration) -> Endpoint<OKResponse> {
        Endpoint(.post, "/v1/devices/push", body: .json(body))
    }

    // MARK: Konten

    public static func accounts() -> Endpoint<AccountList> { Endpoint(.get, "/v1/accounts") }

    public static func setupSuggestion(email: String) -> Endpoint<SetupSuggestion> {
        Endpoint(.get, "/v1/accounts/setup-suggestion", query: [("email", email)])
    }

    public static func connectImap(_ body: ImapAccountCreate) -> Endpoint<Account> {
        Endpoint(.post, "/v1/accounts/imap", body: .json(body), timeout: 60)
    }

    public static func startOAuth(_ provider: OAuthProvider, _ body: OAuthStartRequest) -> Endpoint<OAuthStart> {
        Endpoint(.post, "/v1/accounts/oauth/\(provider.rawValue)/start", body: .json(body))
    }

    public static func checkAccount(_ id: UUID) -> Endpoint<AccountCheck> {
        Endpoint(.post, "/v1/accounts/\(id.lowercased)/check", timeout: 60)
    }

    public static func patchAccount(_ id: UUID, _ patch: AccountPatch) -> Endpoint<Account> {
        Endpoint(.patch, "/v1/accounts/\(id.lowercased)", body: .json(patch))
    }

    public static func removeAccount(_ id: UUID) -> Endpoint<OKResponse> { Endpoint(.delete, "/v1/accounts/\(id.lowercased)") }
    public static func folders(_ id: UUID) -> Endpoint<FolderList> { Endpoint(.get, "/v1/accounts/\(id.lowercased)/folders") }

    public static func selectFolders(_ id: UUID, _ selection: FolderSelection) -> Endpoint<FolderList> {
        Endpoint(.put, "/v1/accounts/\(id.lowercased)/folders", body: .json(selection))
    }
}
