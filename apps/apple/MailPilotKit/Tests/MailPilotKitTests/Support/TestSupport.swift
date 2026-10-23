import Foundation
import Testing
@testable import MailPilotKit

enum Fixture {
    static func data(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"), "Fixture \(name).json fehlt")
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try APIJSON.decode(type, from: data(name))
    }

    static func json(_ name: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data(name))
    }
}

func date(_ iso: String) -> Date {
    guard let value = ISOTimestamp.parse(iso) else { fatalError("Ungültiger Zeitstempel im Test: \(iso)") }
    return value
}

func day(_ string: String) -> LocalDate {
    guard let value = LocalDate(string) else { fatalError("Ungültiges Datum im Test: \(string)") }
    return value
}

let paris = TimeZone(identifier: "Europe/Paris")!

func makeTask(_ title: String = "Aufgabe", id: UUID = UUID(), version: Int = 1, status: TaskStatus = .todo, priority: Priority = .important,
              deadline: Deadline? = nil, plannedFor: LocalDate? = nil, createdAt: Date = date("2026-10-01T08:00:00Z")) -> TaskItem {
    var task = TaskItem(id: id, version: version, origin: .ai, status: status, plannedFor: plannedFor, title: title,
                        ai: AiSuggestion(title: title, priority: priority, deadline: deadline), createdAt: createdAt)
    TaskEffects.recomputeEffective(&task)
    return task
}

func encodeJSON<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: APIJSON.encode(value))
}

/// Gemeinsame Testuhr.
final class TestClock: @unchecked Sendable {
    private let value: Locked<Date>
    init(_ start: Date) { value = Locked(start) }
    var now: Date { value.current }
    func advance(_ seconds: TimeInterval) { value.withLock { $0 = $0.addingTimeInterval(seconds) } }
    var closure: @Sendable () -> Date { { [value] in value.current } }
}

// MARK: - URLProtocol-Mock (je Test eigener Host, damit parallele Tests sich nicht stören)

struct RecordedRequest: Sendable {
    var method: String
    var url: URL
    var headers: [String: String]
    var body: Data?
}

final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (RecordedRequest) throws -> (status: Int, body: Data)

    private static let handlers = Locked<[String: Handler]>([:])
    private static let requests = Locked<[String: [RecordedRequest]]>([:])

    static func session(host: String, handler: @escaping Handler) -> URLSession {
        handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    static func recorded(host: String) -> [RecordedRequest] {
        requests.current[host] ?? []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        guard let url = request.url, let host = url.host, let handler = Self.handlers.current[host] else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let recorded = RecordedRequest(method: request.httpMethod ?? "GET", url: url, headers: request.allHTTPHeaderFields ?? [:],
                                       body: request.httpBody ?? request.httpBodyStream.map(Self.readAll))
        Self.requests.withLock { $0[host, default: []].append(recorded) }
        do {
            let (status, body) = try handler(recorded)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func readAll(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

// MARK: - Fake-Server für Sync-Tests (Feldversionen und Notizkonflikte wie services/api/src/domain/mutations.ts)

final class FakeSyncServer: SyncTransport, @unchecked Sendable {
    struct StoredTask {
        var task: TaskItem
        var fieldVersions: [String: Int]
    }

    struct State {
        var tasks: [UUID: StoredTask] = [:]
        var notes: [UUID: TaskNote] = [:]
        var log: [(seq: Int, type: SyncEntityType, id: UUID)] = []
        var receipts: [UUID: MutationResult] = [:]
        var pushes: [[Mutation]] = []
        var pushedBodies: [[Data]] = []
        var cursors: [String?] = []
        var failNextPushes = 0
        var failNextPulls = 0
        var pageLimit = 500
    }

    let state = Locked(State())
    let now: @Sendable () -> Date

    init(now: @escaping @Sendable () -> Date) {
        self.now = now
    }

    var pushes: [[Mutation]] { state.current.pushes }
    var cursors: [String?] { state.current.cursors }
    var pushedBodies: [[Data]] { state.current.pushedBodies }

    func task(_ id: UUID) -> TaskItem? { state.current.tasks[id]?.task }
    func note(_ id: UUID) -> TaskNote? { state.current.notes[id] }
    var notes: [TaskNote] { Array(state.current.notes.values) }

    /// Aufgabe direkt auf dem Server anlegen (z. B. durch die KI).
    func seed(_ task: TaskItem) {
        state.withLock { s in
            s.tasks[task.id] = StoredTask(task: task, fieldVersions: [:])
            Self.log(&s, .task, task.id)
        }
    }

    func seed(_ note: TaskNote) {
        state.withLock { s in
            s.notes[note.id] = note
            Self.log(&s, .note, note.id)
        }
    }

    /// Änderung durch ein anderes Gerät.
    func otherDeviceUpdates(_ id: UUID, _ patch: TaskPatch) {
        state.withLock { s in
            guard var stored = s.tasks[id] else { return }
            let newVersion = stored.task.version + 1
            stored.task = TaskEffects.apply(patch, to: stored.task, now: now())
            stored.task.version = newVersion
            for field in patch.fieldNames { stored.fieldVersions[field] = newVersion }
            s.tasks[id] = stored
            Self.log(&s, .task, id)
        }
    }

    func otherDeviceEditsNote(_ id: UUID, body: String) {
        state.withLock { s in
            guard var note = s.notes[id] else { return }
            note.body = body
            note.version += 1
            s.notes[id] = note
            Self.log(&s, .note, id)
        }
    }

    private static func log(_ s: inout State, _ type: SyncEntityType, _ id: UUID) {
        s.log.append((seq: (s.log.last?.seq ?? 100) + 1, type: type, id: id))
    }

    // MARK: SyncTransport

    func pushMutations(_ raw: [Data]) async throws -> [MutationResult] {
        let decoder = APIJSON.decoder()
        let mutations = try raw.map { try decoder.decode(Mutation.self, from: $0) }
        return try state.withLock { s in
            s.pushes.append(mutations)
            s.pushedBodies.append(raw)
            if s.failNextPushes > 0 {
                s.failNextPushes -= 1
                throw APIError.transport(.notConnectedToInternet)
            }
            return mutations.map { m in
                if let receipt = s.receipts[m.idempotencyKey] { return receipt }
                let result = Self.apply(m, &s, now: now())
                s.receipts[m.idempotencyKey] = result
                return result
            }
        }
    }

    func fetchChanges(cursor: String?, limit: Int) async throws -> ChangesResponse {
        try state.withLock { s in
            s.cursors.append(cursor)
            if s.failNextPulls > 0 {
                s.failNextPulls -= 1
                throw APIError.transport(.timedOut)
            }
            let head = s.log.last?.seq ?? 0
            let limit = min(limit, s.pageLimit)
            if let cursor, let value = Int(cursor) {
                let after = s.log.filter { $0.seq > value }
                let page = Array(after.prefix(limit))
                var latest: [String: (seq: Int, type: SyncEntityType, id: UUID)] = [:]
                for entry in page { latest["\(entry.type.rawValue):\(entry.id)"] = entry }
                let changes = latest.values.sorted { $0.seq < $1.seq }.map { Self.change(for: $0.type, id: $0.id, seq: $0.seq, s) }
                let next = page.last.map { String($0.seq) } ?? cursor
                return ChangesResponse(changes: changes, nextCursor: next, hasMore: after.count > limit, serverTime: now())
            }
            let changes = s.tasks.keys.map { Self.change(for: .task, id: $0, seq: head, s) } + s.notes.keys.map { Self.change(for: .note, id: $0, seq: head, s) }
            return ChangesResponse(changes: changes, nextCursor: String(head), hasMore: false, serverTime: now())
        }
    }

    func fetchToday() async throws -> Today {
        Today(next: [], moreUrgent: [], waitingCount: 0, canWaitCount: 0, openClarifications: 0, lastSuccessfulUpdateAt: nil,
              pendingAnalysisCount: 7, accountsNeedingAttention: [], generatedAt: now())
    }

    private static func change(for type: SyncEntityType, id: UUID, seq: Int, _ s: State) -> Change {
        switch type {
        case .task:
            let task = s.tasks[id]?.task
            return Change(seq: String(seq), entityId: id, op: task == nil ? .delete : .upsert, version: task?.version ?? 0, data: .task(task))
        default:
            let note = s.notes[id]
            return Change(seq: String(seq), entityId: id, op: note == nil ? .delete : .upsert, version: note?.version ?? 0, data: .note(note))
        }
    }

    private static func apply(_ m: Mutation, _ s: inout State, now: Date) -> MutationResult {
        func result(_ status: MutationResultStatus, version: Int? = nil, fields: [String] = [], created: UUID? = nil, error: MutationError? = nil) -> MutationResult {
            MutationResult(idempotencyKey: m.idempotencyKey, status: status, entityType: m.entityType, entityId: m.entityId, version: version,
                           conflictingFields: fields, createdEntityId: created, error: error)
        }
        switch m.kind {
        case let .taskCreate(title, nextStep, priority, deadline):
            if let existing = s.tasks[m.entityId] { return result(.duplicate, version: existing.task.version) }
            var task = TaskEffects.created(id: m.entityId, title: title, nextStep: nextStep, priority: priority, deadline: deadline, at: now)
            task.version = 1
            s.tasks[m.entityId] = StoredTask(task: task, fieldVersions: [:])
            log(&s, .task, m.entityId)
            return result(.applied, version: 1)
        case .taskUpdate, .taskDismiss, .taskRestore:
            guard var stored = s.tasks[m.entityId] else { return result(.rejected, error: MutationError(code: "not_found", message: "Aufgabe nicht gefunden")) }
            let patch: TaskPatch
            switch m.kind {
            case .taskUpdate(let p): patch = p
            case .taskDismiss: patch = TaskPatch(status: .dismissed)
            default: patch = TaskPatch(status: stored.task.status == .dismissed ? .todo : stored.task.status)
            }
            let base = m.baseVersion ?? 0
            let newVersion = stored.task.version + 1
            let before = TaskEffects.comparableFields(of: stored.task)
            let target = TaskEffects.comparableFields(of: TaskEffects.apply(patch, to: stored.task, now: now))
            var applied: [String] = []
            var conflicts: [String] = []
            for field in patch.fieldNames where before[field] != target[field] {
                if (stored.fieldVersions[field] ?? 0) > base { conflicts.append(field) } else { applied.append(field) }
            }
            if applied.isEmpty {
                return conflicts.isEmpty ? result(.applied, version: stored.task.version) : result(.conflict, version: stored.task.version, fields: conflicts)
            }
            stored.task = TaskEffects.apply(patch.removing(fields: Set(conflicts)), to: stored.task, now: now)
            stored.task.version = newVersion
            for field in applied { stored.fieldVersions[field] = newVersion }
            s.tasks[m.entityId] = stored
            log(&s, .task, m.entityId)
            return result(conflicts.isEmpty ? .applied : .conflict, version: newVersion, fields: conflicts)
        case let .noteCreate(taskId, body):
            if let existing = s.notes[m.entityId] { return result(.duplicate, version: existing.version) }
            guard s.tasks[taskId] != nil else { return result(.rejected, error: MutationError(code: "not_found", message: "Aufgabe nicht gefunden")) }
            s.notes[m.entityId] = TaskNote(id: m.entityId, taskId: taskId, version: 1, body: body, createdAt: now)
            log(&s, .note, m.entityId)
            return result(.applied, version: 1)
        case .noteUpdate(let body):
            guard var note = s.notes[m.entityId] else { return result(.rejected, error: MutationError(code: "not_found", message: "Notiz nicht gefunden")) }
            if note.body == body { return result(.applied, version: note.version) }
            if note.version == m.baseVersion {
                note.body = body
                note.version += 1
                s.notes[m.entityId] = note
                log(&s, .note, m.entityId)
                return result(.applied, version: note.version)
            }
            let copy = TaskNote(id: UUID(), taskId: note.taskId, version: 1, body: body, conflictOfNoteId: note.id, createdAt: now)
            s.notes[copy.id] = copy
            log(&s, .note, copy.id)
            return result(.conflict, version: note.version, created: copy.id)
        case .noteDelete:
            guard let note = s.notes[m.entityId] else { return result(.applied) }
            if note.version != m.baseVersion { return result(.conflict, version: note.version, fields: ["body"]) }
            s.notes[m.entityId] = nil
            log(&s, .note, m.entityId)
            return result(.applied, version: note.version + 1)
        default:
            return result(.applied, version: 1)
        }
    }
}

/// Fester Ablauf für Protokolltests (Paging, Reset, Tombstones, Fehler).
final class ScriptedTransport: SyncTransport, @unchecked Sendable {
    struct State {
        var pages: [String?: [ChangesResponse]] = [:]
        var pushResults: [[MutationResult]] = []
        var pushErrors: [APIError?] = []
        var requestedCursors: [String?] = []
        var pushedBodies: [[Data]] = []
    }

    let state = Locked(State())

    func addPage(for cursor: String?, _ page: ChangesResponse) {
        state.withLock { $0.pages[cursor, default: []].append(page) }
    }

    func pushMutations(_ raw: [Data]) async throws -> [MutationResult] {
        try state.withLock { s in
            s.pushedBodies.append(raw)
            if !s.pushErrors.isEmpty, let error = s.pushErrors.removeFirst() { throw error }
            if !s.pushResults.isEmpty { return s.pushResults.removeFirst() }
            let decoder = APIJSON.decoder()
            return try raw.map { body in
                let m = try decoder.decode(Mutation.self, from: body)
                return MutationResult(idempotencyKey: m.idempotencyKey, status: .applied, entityType: m.entityType, entityId: m.entityId, version: (m.baseVersion ?? 0) + 1)
            }
        }
    }

    func fetchChanges(cursor: String?, limit: Int) async throws -> ChangesResponse {
        state.withLock { s in
            s.requestedCursors.append(cursor)
            guard var queue = s.pages[cursor], !queue.isEmpty else {
                return ChangesResponse(changes: [], nextCursor: cursor ?? "0", serverTime: Date())
            }
            let page = queue.removeFirst()
            s.pages[cursor] = queue
            return page
        }
    }

    func fetchToday() async throws -> Today {
        throw APIError.http(status: 503, body: nil)
    }
}

func signedInEnvironment(store: LocalStore, transport: any SyncTransport, clock: TestClock) -> (engine: SyncEngine, actions: LocalActions) {
    let engine = SyncEngine(store: store, transport: transport, clock: clock.closure, isSignedIn: { true })
    return (engine, LocalActions(store: store, clock: clock.closure))
}
