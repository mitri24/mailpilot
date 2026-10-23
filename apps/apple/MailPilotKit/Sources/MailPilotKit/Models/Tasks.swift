import Foundation

// Modelle aus packages/contracts/src/tasks.ts. `Task` heißt hier `TaskItem`,
// damit `Task { … }` aus Swift Concurrency nicht verdeckt wird.

/// Entweder reines Datum oder Zeitpunkt, nie eine erfundene Uhrzeit.
public struct Deadline: Codable, Sendable, Hashable {
    public var date: LocalDate?
    public var dateTime: Date?
    public var precision: DeadlinePrecision
    public var kind: DeadlineKind
    public var sourceQuote: String?

    public init(date: LocalDate? = nil, dateTime: Date? = nil, precision: DeadlinePrecision, kind: DeadlineKind, sourceQuote: String? = nil) {
        self.date = date
        self.dateTime = dateTime
        self.precision = precision
        self.kind = kind
        self.sourceQuote = sourceQuote
    }

    public static func onDate(_ date: LocalDate, kind: DeadlineKind = .explicit, quote: String? = nil) -> Deadline {
        Deadline(date: date, precision: .date, kind: kind, sourceQuote: quote)
    }

    public static func at(_ instant: Date, kind: DeadlineKind = .explicit, quote: String? = nil) -> Deadline {
        Deadline(dateTime: instant, precision: .datetime, kind: kind, sourceQuote: quote)
    }
}

public struct ManualDeadline: Codable, Sendable, Hashable {
    public var date: LocalDate?
    public var dateTime: Date?
    public var precision: DeadlinePrecision

    public init(date: LocalDate? = nil, dateTime: Date? = nil, precision: DeadlinePrecision) {
        self.date = date
        self.dateTime = dateTime
        self.precision = precision
    }

    public static func onDate(_ date: LocalDate) -> ManualDeadline { ManualDeadline(date: date, precision: .date) }
    public static func at(_ instant: Date) -> ManualDeadline { ManualDeadline(dateTime: instant, precision: .datetime) }

    enum CodingKeys: String, CodingKey { case date, dateTime, precision }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decodeIfPresent(LocalDate.self, forKey: .date)
        dateTime = try c.decodeIfPresent(Date.self, forKey: .dateTime)
        precision = try c.decode(DeadlinePrecision.self, forKey: .precision)
    }

    // `date` und `dateTime` sind Pflichtfelder, die `null` sein dürfen.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeNullable(date, forKey: .date)
        try c.encodeNullable(dateTime, forKey: .dateTime)
        try c.encode(precision, forKey: .precision)
    }

    /// Wie der Server die Eingabe speichert: nur das zur Genauigkeit passende Feld zählt.
    public var normalized: ManualDeadline? {
        switch precision {
        case .date: return date.map { ManualDeadline(date: $0, precision: .date) }
        case .datetime: return dateTime.map { ManualDeadline(dateTime: $0, precision: .datetime) }
        }
    }

    public var asDeadline: Deadline? {
        guard let n = normalized else { return nil }
        return Deadline(date: n.date, dateTime: n.dateTime, precision: n.precision, kind: .explicit, sourceQuote: nil)
    }
}

public struct AiSuggestion: Codable, Sendable, Hashable {
    public var title: String?
    public var nextStep: String?
    public var summary: String?
    public var priority: Priority?
    public var priorityReason: String?
    public var deadline: Deadline?
    public var why: String?

    public init(title: String? = nil, nextStep: String? = nil, summary: String? = nil, priority: Priority? = nil,
                priorityReason: String? = nil, deadline: Deadline? = nil, why: String? = nil) {
        self.title = title
        self.nextStep = nextStep
        self.summary = summary
        self.priority = priority
        self.priorityReason = priorityReason
        self.deadline = deadline
        self.why = why
    }
}

public struct ManualOverrides: Codable, Sendable, Hashable {
    public var title: String?
    public var nextStep: String?
    public var priority: Priority?
    public var deadline: ManualDeadline?
    public var deadlineCleared: Bool

    public init(title: String? = nil, nextStep: String? = nil, priority: Priority? = nil, deadline: ManualDeadline? = nil, deadlineCleared: Bool = false) {
        self.title = title
        self.nextStep = nextStep
        self.priority = priority
        self.deadline = deadline
        self.deadlineCleared = deadlineCleared
    }
}

public struct SourceRef: Codable, Sendable, Hashable {
    public var messageId: UUID
    public var accountId: UUID
    public var subject: String?
    public var fromName: String?
    public var fromAddress: String?
    public var sentAt: Date?

    public init(messageId: UUID, accountId: UUID, subject: String? = nil, fromName: String? = nil, fromAddress: String? = nil, sentAt: Date? = nil) {
        self.messageId = messageId
        self.accountId = accountId
        self.subject = subject
        self.fromName = fromName
        self.fromAddress = fromAddress
        self.sentAt = sentAt
    }
}

/// Wirksame Werte (manuell vor KI) plus beide Rohschichten.
public struct TaskItem: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var version: Int
    public var origin: TaskOrigin
    public var status: TaskStatus
    public var waiting: Bool
    public var waitingCheckAt: LocalDate?
    public var snoozedUntil: Date?
    public var plannedFor: LocalDate?
    public var sortKey: Double?
    public var title: String
    public var nextStep: String?
    public var summary: String?
    public var priority: Priority
    public var priorityReason: String?
    public var priorityIsManual: Bool
    public var deadline: Deadline?
    public var deadlineIsManual: Bool
    public var why: String?
    public var requiresAttachmentReading: Bool
    public var estimatedMinutes: Int?
    public var estimateSource: EstimateSource?
    public var ai: AiSuggestion
    public var manual: ManualOverrides
    public var accountIds: [UUID]
    public var primarySource: SourceRef?
    public var sourceCount: Int
    public var openClarifications: Int
    public var latestChange: String?
    public var doneAt: Date?
    public var dismissedAt: Date?
    public var mergedIntoTaskId: UUID?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        version: Int = 1,
        origin: TaskOrigin = .ai,
        status: TaskStatus = .todo,
        waiting: Bool = false,
        waitingCheckAt: LocalDate? = nil,
        snoozedUntil: Date? = nil,
        plannedFor: LocalDate? = nil,
        sortKey: Double? = nil,
        title: String,
        nextStep: String? = nil,
        summary: String? = nil,
        priority: Priority = .important,
        priorityReason: String? = nil,
        priorityIsManual: Bool = false,
        deadline: Deadline? = nil,
        deadlineIsManual: Bool = false,
        why: String? = nil,
        requiresAttachmentReading: Bool = false,
        estimatedMinutes: Int? = nil,
        estimateSource: EstimateSource? = nil,
        ai: AiSuggestion = AiSuggestion(),
        manual: ManualOverrides = ManualOverrides(),
        accountIds: [UUID] = [],
        primarySource: SourceRef? = nil,
        sourceCount: Int = 0,
        openClarifications: Int = 0,
        latestChange: String? = nil,
        doneAt: Date? = nil,
        dismissedAt: Date? = nil,
        mergedIntoTaskId: UUID? = nil,
        createdAt: Date,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.version = version
        self.origin = origin
        self.status = status
        self.waiting = waiting
        self.waitingCheckAt = waitingCheckAt
        self.snoozedUntil = snoozedUntil
        self.plannedFor = plannedFor
        self.sortKey = sortKey
        self.title = title
        self.nextStep = nextStep
        self.summary = summary
        self.priority = priority
        self.priorityReason = priorityReason
        self.priorityIsManual = priorityIsManual
        self.deadline = deadline
        self.deadlineIsManual = deadlineIsManual
        self.why = why
        self.requiresAttachmentReading = requiresAttachmentReading
        self.estimatedMinutes = estimatedMinutes
        self.estimateSource = estimateSource
        self.ai = ai
        self.manual = manual
        self.accountIds = accountIds
        self.primarySource = primarySource
        self.sourceCount = sourceCount
        self.openClarifications = openClarifications
        self.latestChange = latestChange
        self.doneAt = doneAt
        self.dismissedAt = dismissedAt
        self.mergedIntoTaskId = mergedIntoTaskId
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    public var isOpen: Bool { status == .todo || status == .doing }
    public var isMerged: Bool { mergedIntoTaskId != nil }
    public var hasMailSource: Bool { sourceCount > 0 || primarySource != nil }
}

public struct SourceAttachment: Codable, Sendable, Hashable {
    public var filename: String?
    public var contentType: String?
    public var size: Int?
}

public enum TaskSourceRole: String, Codable, Sendable, Hashable {
    case origin, update, reference
}

public enum AddedBy: String, Codable, Sendable, Hashable {
    case ai, user
}

public struct TaskSource: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskId: UUID
    public var messageId: UUID
    public var accountId: UUID
    public var role: TaskSourceRole
    public var addedBy: AddedBy
    public var subject: String?
    public var fromName: String?
    public var fromAddress: String?
    public var sentAt: Date?
    public var evidenceQuotes: [String]
    public var attachments: [SourceAttachment]
    public var changeSummary: String?
    public var createdAt: Date
}

public struct TaskNote: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskId: UUID
    public var version: Int
    public var body: String
    /// Gesetzt, wenn diese Notiz eine gleichzeitige Bearbeitung einer anderen Notiz bewahrt.
    public var conflictOfNoteId: UUID?
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: UUID = UUID(), taskId: UUID, version: Int = 1, body: String, conflictOfNoteId: UUID? = nil, createdAt: Date, updatedAt: Date? = nil) {
        self.id = id
        self.taskId = taskId
        self.version = version
        self.body = body
        self.conflictOfNoteId = conflictOfNoteId
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

public struct ChecklistItem: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskId: UUID
    public var version: Int
    public var title: String
    public var done: Bool
    public var position: Double
    public var source: AddedBy
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: UUID = UUID(), taskId: UUID, version: Int = 1, title: String, done: Bool = false, position: Double, source: AddedBy = .user, createdAt: Date, updatedAt: Date? = nil) {
        self.id = id
        self.taskId = taskId
        self.version = version
        self.title = title
        self.done = done
        self.position = position
        self.source = source
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

public struct TaskEvent: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var taskId: UUID
    public var kind: TaskEventKind
    public var actor: EventActor
    public var messageId: UUID?
    public var summary: String
    public var oldValue: JSONValue?
    public var newValue: JSONValue?
    public var createdAt: Date
}

public struct TaskDetail: Codable, Sendable, Hashable {
    public var task: TaskItem
    public var sources: [TaskSource]
    public var notes: [TaskNote]
    public var checklist: [ChecklistItem]
    public var events: [TaskEvent]
}

/// Änderbare Felder. Jedes Feld wird serverseitig gegen seine eigene letzte Änderungsversion geprüft.
public struct TaskPatch: Codable, Sendable, Hashable {
    public var status: TaskStatus?
    public var waiting: Bool?
    public var waitingCheckAt: FieldUpdate<LocalDate>
    public var snoozedUntil: FieldUpdate<Date>
    public var plannedFor: FieldUpdate<LocalDate>
    public var sortKey: FieldUpdate<Double>
    /// `.clear` entfernt den manuellen Titel.
    public var title: FieldUpdate<String>
    public var nextStep: FieldUpdate<String>
    /// `.clear` kehrt zur KI-Priorität zurück.
    public var priority: FieldUpdate<Priority>
    /// `.clear` kehrt zur KI-Frist zurück; „keine Frist“ ist `deadlineCleared = true`.
    public var deadline: FieldUpdate<ManualDeadline>
    public var deadlineCleared: Bool?
    public var estimatedMinutes: FieldUpdate<Int>

    public init(
        status: TaskStatus? = nil,
        waiting: Bool? = nil,
        waitingCheckAt: FieldUpdate<LocalDate> = .unchanged,
        snoozedUntil: FieldUpdate<Date> = .unchanged,
        plannedFor: FieldUpdate<LocalDate> = .unchanged,
        sortKey: FieldUpdate<Double> = .unchanged,
        title: FieldUpdate<String> = .unchanged,
        nextStep: FieldUpdate<String> = .unchanged,
        priority: FieldUpdate<Priority> = .unchanged,
        deadline: FieldUpdate<ManualDeadline> = .unchanged,
        deadlineCleared: Bool? = nil,
        estimatedMinutes: FieldUpdate<Int> = .unchanged
    ) {
        self.status = status
        self.waiting = waiting
        self.waitingCheckAt = waitingCheckAt
        self.snoozedUntil = snoozedUntil
        self.plannedFor = plannedFor
        self.sortKey = sortKey
        self.title = title
        self.nextStep = nextStep
        self.priority = priority
        self.deadline = deadline
        self.deadlineCleared = deadlineCleared
        self.estimatedMinutes = estimatedMinutes
    }

    enum CodingKeys: String, CodingKey {
        case status, waiting, waitingCheckAt, snoozedUntil, plannedFor, sortKey, title, nextStep, priority, deadline, deadlineCleared, estimatedMinutes
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(TaskStatus.self, forKey: .status)
        waiting = try c.decodeIfPresent(Bool.self, forKey: .waiting)
        waitingCheckAt = try c.decodeUpdate(LocalDate.self, forKey: .waitingCheckAt)
        snoozedUntil = try c.decodeUpdate(Date.self, forKey: .snoozedUntil)
        plannedFor = try c.decodeUpdate(LocalDate.self, forKey: .plannedFor)
        sortKey = try c.decodeUpdate(Double.self, forKey: .sortKey)
        title = try c.decodeUpdate(String.self, forKey: .title)
        nextStep = try c.decodeUpdate(String.self, forKey: .nextStep)
        priority = try c.decodeUpdate(Priority.self, forKey: .priority)
        deadline = try c.decodeUpdate(ManualDeadline.self, forKey: .deadline)
        deadlineCleared = try c.decodeIfPresent(Bool.self, forKey: .deadlineCleared)
        estimatedMinutes = try c.decodeUpdate(Int.self, forKey: .estimatedMinutes)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encodeIfPresent(waiting, forKey: .waiting)
        try c.encodeUpdate(waitingCheckAt, forKey: .waitingCheckAt)
        try c.encodeUpdate(snoozedUntil, forKey: .snoozedUntil)
        try c.encodeUpdate(plannedFor, forKey: .plannedFor)
        try c.encodeUpdate(sortKey, forKey: .sortKey)
        try c.encodeUpdate(title, forKey: .title)
        try c.encodeUpdate(nextStep, forKey: .nextStep)
        try c.encodeUpdate(priority, forKey: .priority)
        try c.encodeUpdate(deadline, forKey: .deadline)
        try c.encodeIfPresent(deadlineCleared, forKey: .deadlineCleared)
        try c.encodeUpdate(estimatedMinutes, forKey: .estimatedMinutes)
    }

    /// Feldnamen, wie der Server sie in `conflictingFields` meldet (`deadline` umfasst `deadlineCleared`).
    public var fieldNames: [String] {
        var names: [String] = []
        if status != nil { names.append("status") }
        if waiting != nil { names.append("waiting") }
        if !waitingCheckAt.isUnchanged { names.append("waitingCheckAt") }
        if !snoozedUntil.isUnchanged { names.append("snoozedUntil") }
        if !plannedFor.isUnchanged { names.append("plannedFor") }
        if !sortKey.isUnchanged { names.append("sortKey") }
        if !title.isUnchanged { names.append("title") }
        if !nextStep.isUnchanged { names.append("nextStep") }
        if !priority.isUnchanged { names.append("priority") }
        if !deadline.isUnchanged || deadlineCleared != nil { names.append("deadline") }
        if !estimatedMinutes.isUnchanged { names.append("estimatedMinutes") }
        return names
    }

    public var isEmpty: Bool { fieldNames.isEmpty }

    /// Spätere Änderungen gewinnen feldweise; Frist und „keine Frist“ gelten als ein Feld.
    public func merged(with later: TaskPatch) -> TaskPatch {
        var result = self
        if let status = later.status { result.status = status }
        if let waiting = later.waiting { result.waiting = waiting }
        result.waitingCheckAt = waitingCheckAt.overridden(by: later.waitingCheckAt)
        result.snoozedUntil = snoozedUntil.overridden(by: later.snoozedUntil)
        result.plannedFor = plannedFor.overridden(by: later.plannedFor)
        result.sortKey = sortKey.overridden(by: later.sortKey)
        result.title = title.overridden(by: later.title)
        result.nextStep = nextStep.overridden(by: later.nextStep)
        result.priority = priority.overridden(by: later.priority)
        if !later.deadline.isUnchanged || later.deadlineCleared != nil {
            result.deadline = later.deadline
            result.deadlineCleared = later.deadlineCleared
        }
        result.estimatedMinutes = estimatedMinutes.overridden(by: later.estimatedMinutes)
        return result
    }

    public func removing(fields: Set<String>) -> TaskPatch {
        var result = self
        if fields.contains("status") { result.status = nil }
        if fields.contains("waiting") { result.waiting = nil }
        if fields.contains("waitingCheckAt") { result.waitingCheckAt = .unchanged }
        if fields.contains("snoozedUntil") { result.snoozedUntil = .unchanged }
        if fields.contains("plannedFor") { result.plannedFor = .unchanged }
        if fields.contains("sortKey") { result.sortKey = .unchanged }
        if fields.contains("title") { result.title = .unchanged }
        if fields.contains("nextStep") { result.nextStep = .unchanged }
        if fields.contains("priority") { result.priority = .unchanged }
        if fields.contains("deadline") {
            result.deadline = .unchanged
            result.deadlineCleared = nil
        }
        if fields.contains("estimatedMinutes") { result.estimatedMinutes = .unchanged }
        return result
    }
}

/// `POST /v1/tasks` (direkter Aufruf; offline wird `task.create` über die Outbox verwendet).
public struct TaskCreate: Encodable, Sendable, Hashable {
    public var id: UUID?
    public var title: String
    public var nextStep: String?
    public var priority: Priority?
    public var deadline: ManualDeadline?
    public var note: String?
    public var sourceMessageIds: [UUID]?
    public var estimatedMinutes: Int?

    public init(id: UUID? = nil, title: String, nextStep: String? = nil, priority: Priority? = nil, deadline: ManualDeadline? = nil,
                note: String? = nil, sourceMessageIds: [UUID]? = nil, estimatedMinutes: Int? = nil) {
        self.id = id
        self.title = title
        self.nextStep = nextStep
        self.priority = priority
        self.deadline = deadline
        self.note = note
        self.sourceMessageIds = sourceMessageIds
        self.estimatedMinutes = estimatedMinutes
    }
}

public struct TaskList: Codable, Sendable {
    public var tasks: [TaskItem]
}

/// Korrekturen ändern nie Mailinhalte.
public enum Correction: Encodable, Sendable, Hashable {
    case notATask
    case wrongPriority(Priority)
    case wrongDeadline(ManualDeadline?)
    case belongsTo(taskId: UUID)

    enum CodingKeys: String, CodingKey { case kind, priority, deadline, taskId }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .notATask:
            try c.encode("not_a_task", forKey: .kind)
        case .wrongPriority(let priority):
            try c.encode("wrong_priority", forKey: .kind)
            try c.encode(priority, forKey: .priority)
        case .wrongDeadline(let deadline):
            try c.encode("wrong_deadline", forKey: .kind)
            try c.encodeNullable(deadline, forKey: .deadline)
        case .belongsTo(let taskId):
            try c.encode("belongs_to", forKey: .kind)
            try c.encode(taskId, forKey: .taskId)
        }
    }
}

public struct MergeResult: Codable, Sendable {
    public var mergeId: UUID
    public var task: TaskItem
}

public struct CorrectionResult: Codable, Sendable {
    public var task: TaskItem
    public var mergeId: UUID?
}

public struct AccountAttention: Codable, Sendable, Hashable, Identifiable {
    public var accountId: UUID
    public var displayName: String
    public var problem: String
    public var action: String

    public var id: UUID { accountId }

    public init(accountId: UUID, displayName: String, problem: String, action: String) {
        self.accountId = accountId
        self.displayName = displayName
        self.problem = problem
        self.action = action
    }
}

public struct Today: Codable, Sendable, Hashable {
    /// Die drei nächsten sinnvollen Aufgaben.
    public var next: [TaskItem]
    /// Weitere kritische oder überfällige Aufgaben, nie abgeschnitten.
    public var moreUrgent: [TaskItem]
    public var waitingCount: Int
    public var canWaitCount: Int
    public var openClarifications: Int
    public var lastSuccessfulUpdateAt: Date?
    public var pendingAnalysisCount: Int
    public var accountsNeedingAttention: [AccountAttention]
    public var generatedAt: Date

    public init(next: [TaskItem], moreUrgent: [TaskItem], waitingCount: Int, canWaitCount: Int, openClarifications: Int,
                lastSuccessfulUpdateAt: Date?, pendingAnalysisCount: Int, accountsNeedingAttention: [AccountAttention], generatedAt: Date) {
        self.next = next
        self.moreUrgent = moreUrgent
        self.waitingCount = waitingCount
        self.canWaitCount = canWaitCount
        self.openClarifications = openClarifications
        self.lastSuccessfulUpdateAt = lastSuccessfulUpdateAt
        self.pendingAnalysisCount = pendingAnalysisCount
        self.accountsNeedingAttention = accountsNeedingAttention
        self.generatedAt = generatedAt
    }
}
