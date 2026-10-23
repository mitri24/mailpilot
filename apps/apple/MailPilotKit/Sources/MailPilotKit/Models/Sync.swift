import Foundation

// Modelle aus packages/contracts/src/sync.ts.

public enum ChangeOperation: String, Codable, Sendable, Hashable {
    case upsert, delete
}

public enum ChangeData: Sendable, Hashable {
    case task(TaskItem?)
    case note(TaskNote?)
    case checklistItem(ChecklistItem?)
    case clarification(Clarification?)
    case account(Account?)
    case rule(Rule?)
    case settings(UserSettings?)
    /// Unbekannter Entitätstyp eines neueren Servers: wird übersprungen.
    case unknown(String)

    public var hasPayload: Bool {
        switch self {
        case .task(let v): return v != nil
        case .note(let v): return v != nil
        case .checklistItem(let v): return v != nil
        case .clarification(let v): return v != nil
        case .account(let v): return v != nil
        case .rule(let v): return v != nil
        case .settings(let v): return v != nil
        case .unknown: return false
        }
    }
}

/// Ein Eintrag im Änderungsfeed. Löschungen tragen keine Daten (Tombstone).
public struct Change: Decodable, Sendable, Hashable {
    public var seq: String
    public var entityId: UUID
    public var op: ChangeOperation
    public var version: Int
    public var data: ChangeData

    public init(seq: String, entityId: UUID, op: ChangeOperation, version: Int, data: ChangeData) {
        self.seq = seq
        self.entityId = entityId
        self.op = op
        self.version = version
        self.data = data
    }

    /// `op=delete` oder `data=null`.
    public var isTombstone: Bool { op == .delete || !data.hasPayload }

    enum CodingKeys: String, CodingKey { case seq, entityType, entityId, op, version, data }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(String.self, forKey: .seq)
        entityId = try c.decode(UUID.self, forKey: .entityId)
        op = try c.decode(ChangeOperation.self, forKey: .op)
        version = try c.decode(Int.self, forKey: .version)
        let type = try c.decode(String.self, forKey: .entityType)
        switch SyncEntityType(rawValue: type) {
        case .task: data = .task(try c.decodeIfPresent(TaskItem.self, forKey: .data))
        case .note: data = .note(try c.decodeIfPresent(TaskNote.self, forKey: .data))
        case .checklistItem: data = .checklistItem(try c.decodeIfPresent(ChecklistItem.self, forKey: .data))
        case .clarification: data = .clarification(try c.decodeIfPresent(Clarification.self, forKey: .data))
        case .account: data = .account(try c.decodeIfPresent(Account.self, forKey: .data))
        case .rule: data = .rule(try c.decodeIfPresent(Rule.self, forKey: .data))
        case .settings: data = .settings(try c.decodeIfPresent(UserSettings.self, forKey: .data))
        case nil: data = .unknown(type)
        }
    }
}

public struct ChangesResponse: Decodable, Sendable, Hashable {
    public var changes: [Change]
    public var nextCursor: String
    public var hasMore: Bool
    /// Cursor ist älter als die vorgehaltene Historie: Vollabzug nötig.
    public var resetRequired: Bool
    public var serverTime: Date

    public init(changes: [Change], nextCursor: String, hasMore: Bool = false, resetRequired: Bool = false, serverTime: Date) {
        self.changes = changes
        self.nextCursor = nextCursor
        self.hasMore = hasMore
        self.resetRequired = resetRequired
        self.serverTime = serverTime
    }
}

/// Inhalt einer Mutation; Typen und Felder exakt wie `Mutation` im Vertrag.
public enum MutationKind: Sendable, Hashable {
    case taskCreate(title: String, nextStep: String?, priority: Priority?, deadline: ManualDeadline?)
    case taskUpdate(TaskPatch)
    case taskDismiss
    case taskRestore
    case noteCreate(taskId: UUID, body: String)
    case noteUpdate(body: String)
    case noteDelete
    case checklistCreate(taskId: UUID, title: String, position: Double?)
    case checklistUpdate(title: String?, done: Bool?, position: Double?)
    case checklistDelete
    case clarificationAnswer(optionId: String?, text: String?, scope: AnswerScope)

    public var type: String {
        switch self {
        case .taskCreate: return "task.create"
        case .taskUpdate: return "task.update"
        case .taskDismiss: return "task.dismiss"
        case .taskRestore: return "task.restore"
        case .noteCreate: return "note.create"
        case .noteUpdate: return "note.update"
        case .noteDelete: return "note.delete"
        case .checklistCreate: return "checklist.create"
        case .checklistUpdate: return "checklist.update"
        case .checklistDelete: return "checklist.delete"
        case .clarificationAnswer: return "clarification.answer"
        }
    }

    public var entityType: SyncEntityType {
        switch self {
        case .taskCreate, .taskUpdate, .taskDismiss, .taskRestore: return .task
        case .noteCreate, .noteUpdate, .noteDelete: return .note
        case .checklistCreate, .checklistUpdate, .checklistDelete: return .checklistItem
        case .clarificationAnswer: return .clarification
        }
    }

    public var requiresBaseVersion: Bool {
        switch self {
        case .taskCreate, .noteCreate, .checklistCreate, .clarificationAnswer: return false
        default: return true
        }
    }

    public var isCreate: Bool {
        switch self {
        case .taskCreate, .noteCreate, .checklistCreate: return true
        default: return false
        }
    }
}

public struct Mutation: Codable, Sendable, Hashable {
    public var idempotencyKey: UUID
    public var clientTimestamp: Date?
    public var entityId: UUID
    /// Nur für Typen mit `baseVersion` im Vertrag.
    public var baseVersion: Int?
    public var kind: MutationKind

    public init(idempotencyKey: UUID = UUID(), clientTimestamp: Date? = nil, entityId: UUID, baseVersion: Int? = nil, kind: MutationKind) {
        self.idempotencyKey = idempotencyKey
        self.clientTimestamp = clientTimestamp
        self.entityId = entityId
        self.baseVersion = kind.requiresBaseVersion ? (baseVersion ?? 0) : nil
        self.kind = kind
    }

    public var type: String { kind.type }
    public var entityType: SyncEntityType { kind.entityType }

    enum CodingKeys: String, CodingKey { case idempotencyKey, clientTimestamp, type, entityId, baseVersion, payload }
    enum PayloadKeys: String, CodingKey { case title, nextStep, priority, deadline, taskId, body, position, done, optionId, text, scope }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // Kleingeschriebene UUIDs: kanonische, stabile Bytes in der Outbox.
        try c.encode(idempotencyKey.lowercased, forKey: .idempotencyKey)
        try c.encodeIfPresent(clientTimestamp, forKey: .clientTimestamp)
        try c.encode(kind.type, forKey: .type)
        try c.encode(entityId.lowercased, forKey: .entityId)
        if kind.requiresBaseVersion {
            try c.encode(baseVersion ?? 0, forKey: .baseVersion)
        }
        switch kind {
        case let .taskCreate(title, nextStep, priority, deadline):
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encode(title, forKey: .title)
            try p.encodeIfPresent(nextStep, forKey: .nextStep)
            try p.encodeIfPresent(priority, forKey: .priority)
            try p.encodeIfPresent(deadline, forKey: .deadline)
        case .taskUpdate(let patch):
            try c.encode(patch, forKey: .payload)
        case .taskDismiss, .taskRestore, .noteDelete, .checklistDelete:
            break
        case let .noteCreate(taskId, body):
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encode(taskId.lowercased, forKey: .taskId)
            try p.encode(body, forKey: .body)
        case .noteUpdate(let body):
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encode(body, forKey: .body)
        case let .checklistCreate(taskId, title, position):
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encode(taskId.lowercased, forKey: .taskId)
            try p.encode(title, forKey: .title)
            try p.encodeIfPresent(position, forKey: .position)
        case let .checklistUpdate(title, done, position):
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encodeIfPresent(title, forKey: .title)
            try p.encodeIfPresent(done, forKey: .done)
            try p.encodeIfPresent(position, forKey: .position)
        case let .clarificationAnswer(optionId, text, scope):
            var p = c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
            try p.encodeNullable(optionId, forKey: .optionId)
            try p.encodeNullable(text, forKey: .text)
            try p.encode(scope, forKey: .scope)
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        idempotencyKey = try c.decode(UUID.self, forKey: .idempotencyKey)
        clientTimestamp = try c.decodeIfPresent(Date.self, forKey: .clientTimestamp)
        entityId = try c.decode(UUID.self, forKey: .entityId)
        baseVersion = try c.decodeIfPresent(Int.self, forKey: .baseVersion)
        let type = try c.decode(String.self, forKey: .type)
        func payload() throws -> KeyedDecodingContainer<PayloadKeys> {
            try c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload)
        }
        switch type {
        case "task.create":
            let p = try payload()
            kind = .taskCreate(
                title: try p.decode(String.self, forKey: .title),
                nextStep: try p.decodeIfPresent(String.self, forKey: .nextStep),
                priority: try p.decodeIfPresent(Priority.self, forKey: .priority),
                deadline: try p.decodeIfPresent(ManualDeadline.self, forKey: .deadline)
            )
        case "task.update": kind = .taskUpdate(try c.decode(TaskPatch.self, forKey: .payload))
        case "task.dismiss": kind = .taskDismiss
        case "task.restore": kind = .taskRestore
        case "note.create":
            let p = try payload()
            kind = .noteCreate(taskId: try p.decode(UUID.self, forKey: .taskId), body: try p.decode(String.self, forKey: .body))
        case "note.update": kind = .noteUpdate(body: try payload().decode(String.self, forKey: .body))
        case "note.delete": kind = .noteDelete
        case "checklist.create":
            let p = try payload()
            kind = .checklistCreate(taskId: try p.decode(UUID.self, forKey: .taskId), title: try p.decode(String.self, forKey: .title),
                                    position: try p.decodeIfPresent(Double.self, forKey: .position))
        case "checklist.update":
            let p = try payload()
            kind = .checklistUpdate(title: try p.decodeIfPresent(String.self, forKey: .title), done: try p.decodeIfPresent(Bool.self, forKey: .done),
                                    position: try p.decodeIfPresent(Double.self, forKey: .position))
        case "checklist.delete": kind = .checklistDelete
        case "clarification.answer":
            let p = try payload()
            kind = .clarificationAnswer(optionId: try p.decodeIfPresent(String.self, forKey: .optionId),
                                        text: try p.decodeIfPresent(String.self, forKey: .text),
                                        scope: try p.decode(AnswerScope.self, forKey: .scope))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "Unbekannter Mutationstyp \(type)")
        }
    }
}

public enum MutationResultStatus: String, Codable, Sendable, Hashable {
    case applied, conflict, rejected, duplicate
}

public struct MutationError: Codable, Sendable, Hashable {
    public var code: String
    public var message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct MutationResult: Codable, Sendable, Hashable {
    public var idempotencyKey: UUID
    public var status: MutationResultStatus
    public var entityType: SyncEntityType
    public var entityId: UUID
    public var version: Int?
    /// Felder, die nicht übernommen wurden, weil der Server sie nach `baseVersion` geändert hat.
    public var conflictingFields: [String]
    /// z. B. die Konfliktkopie einer Notiz.
    public var createdEntityId: UUID?
    public var error: MutationError?

    public init(idempotencyKey: UUID, status: MutationResultStatus, entityType: SyncEntityType, entityId: UUID, version: Int? = nil,
                conflictingFields: [String] = [], createdEntityId: UUID? = nil, error: MutationError? = nil) {
        self.idempotencyKey = idempotencyKey
        self.status = status
        self.entityType = entityType
        self.entityId = entityId
        self.version = version
        self.conflictingFields = conflictingFields
        self.createdEntityId = createdEntityId
        self.error = error
    }
}

public struct MutationBatchResult: Codable, Sendable {
    public var results: [MutationResult]
}

/// Antwort von `PATCH /v1/tasks/{id}`, `dismiss` und `restore`.
public struct TaskMutationResponse: Codable, Sendable {
    public var result: MutationResult
    public var task: TaskItem?
}

public struct NoteMutationResponse: Codable, Sendable {
    public var result: MutationResult
    public var note: TaskNote?
}

public struct ChecklistMutationResponse: Codable, Sendable {
    public var result: MutationResult
    public var item: ChecklistItem?
}

public struct ResultResponse: Codable, Sendable {
    public var result: MutationResult
}
