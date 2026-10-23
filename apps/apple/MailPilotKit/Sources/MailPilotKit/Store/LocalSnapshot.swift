import Foundation
import GRDB

/// Was App und Widget anzeigen: zuletzt bekannter Serverstand plus alle lokalen Änderungen aus der Outbox (optimistisch).
public struct LocalSnapshot: Sendable {
    public var tasks: [UUID: TaskItem]
    public var notes: [UUID: TaskNote]
    public var checklist: [UUID: ChecklistItem]
    public var clarifications: [UUID: Clarification]
    public var accounts: [UUID: Account]
    public var rules: [UUID: Rule]
    public var settings: UserSettings?
    /// Aufgaben mit noch nicht synchronisierten Änderungen (auch an Notizen oder Checkliste).
    public var pendingTaskIds: Set<UUID>
    public var pendingEntityIds: Set<UUID>
    public var pendingCount: Int
    public var notices: [SyncNotice]
    public var syncState: SyncStateRecord

    public init(server: ServerState, outbox: [OutboxEntry], notices: [SyncNotice] = [], syncState: SyncStateRecord = SyncStateRecord()) {
        tasks = server.tasks
        notes = server.notes
        checklist = server.checklist
        clarifications = server.clarifications
        accounts = server.accounts
        rules = server.rules
        settings = server.settings
        pendingTaskIds = []
        pendingEntityIds = []
        pendingCount = 0
        self.notices = notices
        self.syncState = syncState
        for entry in outbox {
            apply(entry, server: server)
        }
    }

    public static let empty = LocalSnapshot(server: ServerState(), outbox: [])

    // MARK: Überlagerung

    private mutating func apply(_ entry: OutboxEntry, server: ServerState) {
        let mutation = entry.mutation
        let id = mutation.entityId
        if entry.isAcknowledged {
            // Bereits im abgerufenen Serverstand enthalten?
            if let resultVersion = entry.resultVersion, let stored = Self.version(of: mutation.entityType, id: id, in: server), stored >= resultVersion {
                return
            }
        } else {
            pendingCount += 1
            pendingEntityIds.insert(id)
            if let taskId = entry.taskId { pendingTaskIds.insert(taskId) }
        }
        let now = mutation.clientTimestamp ?? entry.createdAt
        switch mutation.kind {
        case let .taskCreate(title, nextStep, priority, deadline):
            if tasks[id] == nil {
                tasks[id] = TaskEffects.created(id: id, title: title, nextStep: nextStep, priority: priority, deadline: deadline, at: now)
            }
        case .taskUpdate(let patch):
            if let task = tasks[id] { tasks[id] = TaskEffects.apply(patch, to: task, now: now) }
        case .taskDismiss:
            if let task = tasks[id] { tasks[id] = TaskEffects.apply(TaskPatch(status: .dismissed), to: task, now: now) }
        case .taskRestore:
            if let task = tasks[id], task.status == .dismissed {
                tasks[id] = TaskEffects.apply(TaskPatch(status: entry.context.restoreStatus ?? .todo), to: task, now: now)
            }
        case let .noteCreate(taskId, body):
            if notes[id] == nil {
                notes[id] = TaskNote(id: id, taskId: taskId, version: 0, body: body, createdAt: now)
            }
        case .noteUpdate(let body):
            if var note = notes[id] {
                note.body = body
                note.updatedAt = now
                notes[id] = note
            }
        case .noteDelete:
            notes[id] = nil
        case let .checklistCreate(taskId, title, position):
            if checklist[id] == nil {
                let fallback = (checklist.values.filter { $0.taskId == taskId }.map(\.position).max() ?? 0) + 1
                checklist[id] = ChecklistItem(id: id, taskId: taskId, version: 0, title: title, position: position ?? fallback, createdAt: now)
            }
        case let .checklistUpdate(title, done, position):
            if var item = checklist[id] {
                if let title { item.title = title }
                if let done { item.done = done }
                if let position { item.position = position }
                item.updatedAt = now
                checklist[id] = item
            }
        case .checklistDelete:
            checklist[id] = nil
        case let .clarificationAnswer(optionId, text, scope):
            if let clarification = clarifications[id] {
                clarifications[id] = TaskEffects.answered(clarification, optionId: optionId, text: text, scope: scope, at: now)
            }
        }
    }

    static func version(of type: SyncEntityType, id: UUID, in server: ServerState) -> Int? {
        switch type {
        case .task: return server.tasks[id]?.version
        case .note: return server.notes[id]?.version
        case .checklistItem: return server.checklist[id]?.version
        case .clarification: return server.clarifications[id]?.version
        case .account: return server.accounts[id]?.version
        case .rule: return server.rules[id]?.version
        case .settings: return server.settings?.version
        }
    }

    // MARK: Abfragen

    /// Ohne zusammengeführte Aufgaben.
    public var visibleTasks: [TaskItem] {
        tasks.values.filter { $0.mergedIntoTaskId == nil }
    }

    public var timeZone: TimeZone {
        settings?.timeZone ?? TimeZone(identifier: "Europe/Paris") ?? .current
    }

    public func notes(for taskId: UUID) -> [TaskNote] {
        notes.values.filter { $0.taskId == taskId }.sorted { $0.createdAt < $1.createdAt }
    }

    public func checklist(for taskId: UUID) -> [ChecklistItem] {
        checklist.values.filter { $0.taskId == taskId }.sorted { ($0.position, $0.createdAt) < ($1.position, $1.createdAt) }
    }

    public var openClarifications: [Clarification] {
        clarifications.values.filter { $0.status == .open }.sorted { $0.createdAt > $1.createdAt }
    }

    public var sortedAccounts: [Account] {
        accounts.values.sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }

    public var sortedRules: [Rule] {
        rules.values.sorted { $0.updatedAt > $1.updatedAt }
    }

    public func notices(forTask taskId: UUID) -> [SyncNotice] {
        notices.filter { $0.taskId == taskId || $0.entityId == taskId }
    }

    public func today(now: Date) -> Today {
        TodayRanking.computeToday(
            tasks: visibleTasks,
            openClarifications: openClarifications.count,
            accounts: Array(accounts.values),
            pendingAnalysisCount: syncState.serverPendingAnalysisCount,
            timeZone: timeZone,
            now: now
        )
    }

    public func board(filter: BoardFilter, now: Date) -> BoardColumns {
        BoardColumns.build(from: visibleTasks, filter: filter, now: now, timeZone: timeZone)
    }

    public var dismissedTasks: [TaskItem] {
        visibleTasks.filter { $0.status == .dismissed }.sorted { ($0.dismissedAt ?? $0.updatedAt) > ($1.dismissedAt ?? $1.updatedAt) }
    }

    public var canWaitTasks: [TaskItem] {
        visibleTasks.filter { $0.isOpen && $0.priority == .canWait }.sorted { $0.createdAt < $1.createdAt }
    }

    public var waitingTasks: [TaskItem] {
        visibleTasks.filter { $0.isOpen && $0.waiting }.sorted { ($0.waitingCheckAt ?? LocalDate(year: 9999, month: 12, day: 31)!) < ($1.waitingCheckAt ?? LocalDate(year: 9999, month: 12, day: 31)!) }
    }
}

extension LocalStore {
    /// Gesamter wirksamer Stand in einer konsistenten Lesetransaktion.
    public func snapshot() throws -> LocalSnapshot {
        try writer.read { db in
            LocalSnapshot(server: try Self.serverState(db), outbox: try Self.outboxEntries(db),
                          notices: try Self.notices(db), syncState: try Self.syncState(db))
        }
    }

    static func entityState(type: SyncEntityType, id: UUID, _ db: Database) throws -> LocalSnapshot {
        var server = ServerState()
        switch type {
        case .task: server.tasks[id] = try serverTask(id, db)
        case .note: server.notes[id] = try serverNote(id, db)
        case .checklistItem: server.checklist[id] = try serverChecklistItem(id, db)
        case .clarification: server.clarifications[id] = try serverClarification(id, db)
        default: break
        }
        let entries = try outboxEntries(db, where: "entityType = ? AND entityId = ?", arguments: [type.rawValue, id.lowercased])
        return LocalSnapshot(server: server, outbox: entries)
    }

    static func effectiveTask(_ id: UUID, _ db: Database) throws -> TaskItem? { try entityState(type: .task, id: id, db).tasks[id] }
    static func effectiveNote(_ id: UUID, _ db: Database) throws -> TaskNote? { try entityState(type: .note, id: id, db).notes[id] }
    static func effectiveChecklistItem(_ id: UUID, _ db: Database) throws -> ChecklistItem? { try entityState(type: .checklistItem, id: id, db).checklist[id] }
    static func effectiveClarification(_ id: UUID, _ db: Database) throws -> Clarification? { try entityState(type: .clarification, id: id, db).clarifications[id] }
}
