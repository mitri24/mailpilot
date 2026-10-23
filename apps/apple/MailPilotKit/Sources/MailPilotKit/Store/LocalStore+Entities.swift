import Foundation
import GRDB

/// Zuletzt bekannter Serverstand (ohne lokale, noch nicht bestätigte Änderungen).
public struct ServerState: Sendable {
    public var tasks: [UUID: TaskItem] = [:]
    public var notes: [UUID: TaskNote] = [:]
    public var checklist: [UUID: ChecklistItem] = [:]
    public var clarifications: [UUID: Clarification] = [:]
    public var accounts: [UUID: Account] = [:]
    public var rules: [UUID: Rule] = [:]
    public var settings: UserSettings?

    public init() {}
}

extension LocalStore {
    // MARK: Schreiben

    static func upsert(task: TaskItem, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO tasks (id, version, status, priority, waiting, plannedFor, snoozedUntil, sortKey, mergedIntoTaskId, updatedAt, json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET version = excluded.version, status = excluded.status, priority = excluded.priority,
                waiting = excluded.waiting, plannedFor = excluded.plannedFor, snoozedUntil = excluded.snoozedUntil,
                sortKey = excluded.sortKey, mergedIntoTaskId = excluded.mergedIntoTaskId, updatedAt = excluded.updatedAt, json = excluded.json
            """, arguments: [task.id.lowercased, task.version, task.status.rawValue, task.priority.rawValue, task.waiting,
                             task.plannedFor?.description, task.snoozedUntil?.dbValue, task.sortKey, task.mergedIntoTaskId?.lowercased,
                             task.updatedAt.dbValue, try APIJSON.string(task)])
    }

    static func upsert(note: TaskNote, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO notes (id, taskId, version, json) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET taskId = excluded.taskId, version = excluded.version, json = excluded.json
            """, arguments: [note.id.lowercased, note.taskId.lowercased, note.version, try APIJSON.string(note)])
    }

    static func upsert(checklistItem item: ChecklistItem, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO checklist (id, taskId, version, position, json) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET taskId = excluded.taskId, version = excluded.version, position = excluded.position, json = excluded.json
            """, arguments: [item.id.lowercased, item.taskId.lowercased, item.version, item.position, try APIJSON.string(item)])
    }

    static func upsert(clarification: Clarification, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO clarifications (id, status, taskId, version, json) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, taskId = excluded.taskId, version = excluded.version, json = excluded.json
            """, arguments: [clarification.id.lowercased, clarification.status.rawValue, clarification.taskId?.lowercased,
                             clarification.version, try APIJSON.string(clarification)])
    }

    static func upsert(account: Account, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO accounts (id, status, version, json) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, version = excluded.version, json = excluded.json
            """, arguments: [account.id.lowercased, account.status.rawValue, account.version, try APIJSON.string(account)])
    }

    static func upsert(rule: Rule, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO rules (id, version, json) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json
            """, arguments: [rule.id.lowercased, rule.version, try APIJSON.string(rule)])
    }

    static func upsert(settings: UserSettings, id: UUID, _ db: Database) throws {
        // Es gibt nur einen Einstellungssatz pro Benutzer.
        try db.execute(sql: "DELETE FROM settings WHERE id <> ?", arguments: [id.lowercased])
        try db.execute(sql: """
            INSERT INTO settings (id, version, json) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json
            """, arguments: [id.lowercased, settings.version, try APIJSON.string(settings)])
    }

    /// Wendet eine Seite des Änderungsfeeds an. `replacingAll`: vollständiger Stand ohne Cursor, lokale Serverdaten werden ersetzt;
    /// die Outbox bleibt in jedem Fall erhalten. Auf der letzten Seite werden bestätigte Outbox-Einträge entfernt,
    /// die vor Beginn des Abrufs bestätigt wurden (ihr Ergebnis steckt jetzt im Serverstand).
    public func apply(changes: [Change], nextCursor: String, replacingAll: Bool, purgeAcknowledgedBefore: Date? = nil) throws {
        try writer.write { db in
            if replacingAll {
                for table in ["tasks", "notes", "checklist", "clarifications", "accounts", "rules", "settings"] {
                    try db.execute(sql: "DELETE FROM \(table)")
                }
            }
            for change in changes {
                try Self.apply(change, db)
            }
            try db.execute(sql: "UPDATE sync_state SET cursor = ? WHERE id = 1", arguments: [nextCursor])
            if let purgeAcknowledgedBefore {
                try db.execute(sql: "DELETE FROM outbox WHERE acknowledgedAt IS NOT NULL AND acknowledgedAt <= ?",
                               arguments: [purgeAcknowledgedBefore.dbValue])
            }
        }
    }

    static func apply(_ change: Change, _ db: Database) throws {
        let id = change.entityId.lowercased
        let tombstone = change.isTombstone
        switch change.data {
        case .task(let task):
            if let task, !tombstone {
                try upsert(task: task, db)
            } else {
                try db.execute(sql: "DELETE FROM tasks WHERE id = ?", arguments: [id])
                try db.execute(sql: "DELETE FROM notes WHERE taskId = ?", arguments: [id])
                try db.execute(sql: "DELETE FROM checklist WHERE taskId = ?", arguments: [id])
            }
        case .note(let note):
            if let note, !tombstone { try upsert(note: note, db) } else { try db.execute(sql: "DELETE FROM notes WHERE id = ?", arguments: [id]) }
        case .checklistItem(let item):
            if let item, !tombstone { try upsert(checklistItem: item, db) } else { try db.execute(sql: "DELETE FROM checklist WHERE id = ?", arguments: [id]) }
        case .clarification(let clarification):
            if let clarification, !tombstone { try upsert(clarification: clarification, db) } else {
                try db.execute(sql: "DELETE FROM clarifications WHERE id = ?", arguments: [id])
            }
        case .account(let account):
            if let account, !tombstone { try upsert(account: account, db) } else { try db.execute(sql: "DELETE FROM accounts WHERE id = ?", arguments: [id]) }
        case .rule(let rule):
            if let rule, !tombstone { try upsert(rule: rule, db) } else { try db.execute(sql: "DELETE FROM rules WHERE id = ?", arguments: [id]) }
        case .settings(let settings):
            if let settings, !tombstone { try upsert(settings: settings, id: change.entityId, db) } else {
                try db.execute(sql: "DELETE FROM settings WHERE id = ?", arguments: [id])
            }
        case .unknown:
            break
        }
    }

    /// Antworten direkter API-Aufrufe (z. B. Konto geändert) sofort übernehmen; der Feed liefert sie ohnehin nach.
    public func store(account: Account) throws { try writer.write { db in try Self.upsert(account: account, db) } }
    public func store(rule: Rule) throws { try writer.write { db in try Self.upsert(rule: rule, db) } }
    public func store(task: TaskItem) throws {
        try writer.write { db in
            let stored = try Int.fetchOne(db, sql: "SELECT version FROM tasks WHERE id = ?", arguments: [task.id.lowercased])
            if stored == nil || task.version >= stored! { try Self.upsert(task: task, db) }
        }
    }
    public func store(settings: UserSettings, userId: UUID) throws { try writer.write { db in try Self.upsert(settings: settings, id: userId, db) } }
    public func store(clarification: Clarification) throws { try writer.write { db in try Self.upsert(clarification: clarification, db) } }
    public func removeAccount(id: UUID) throws { try writer.write { db in try db.execute(sql: "DELETE FROM accounts WHERE id = ?", arguments: [id.lowercased]) } }
    public func removeRule(id: UUID) throws { try writer.write { db in try db.execute(sql: "DELETE FROM rules WHERE id = ?", arguments: [id.lowercased]) } }

    // MARK: Lesen

    public func serverState() throws -> ServerState {
        try writer.read { db in try Self.serverState(db) }
    }

    static func serverState(_ db: Database) throws -> ServerState {
        let decoder = APIJSON.decoder()
        func decodeAll<T: Decodable>(_ type: T.Type, _ sql: String) throws -> [T] {
            try String.fetchAll(db, sql: sql).compactMap { json in try? decoder.decode(T.self, from: Data(json.utf8)) }
        }
        var state = ServerState()
        for task in try decodeAll(TaskItem.self, "SELECT json FROM tasks") { state.tasks[task.id] = task }
        for note in try decodeAll(TaskNote.self, "SELECT json FROM notes") { state.notes[note.id] = note }
        for item in try decodeAll(ChecklistItem.self, "SELECT json FROM checklist") { state.checklist[item.id] = item }
        for clarification in try decodeAll(Clarification.self, "SELECT json FROM clarifications") { state.clarifications[clarification.id] = clarification }
        for account in try decodeAll(Account.self, "SELECT json FROM accounts") { state.accounts[account.id] = account }
        for rule in try decodeAll(Rule.self, "SELECT json FROM rules") { state.rules[rule.id] = rule }
        state.settings = try decodeAll(UserSettings.self, "SELECT json FROM settings").first
        return state
    }

    static func serverVersion(of type: SyncEntityType, id: UUID, _ db: Database) throws -> Int? {
        guard let table = table(for: type) else { return nil }
        return try Int.fetchOne(db, sql: "SELECT version FROM \(table) WHERE id = ?", arguments: [id.lowercased])
    }

    static func table(for type: SyncEntityType) -> String? {
        switch type {
        case .task: return "tasks"
        case .note: return "notes"
        case .checklistItem: return "checklist"
        case .clarification: return "clarifications"
        case .account: return "accounts"
        case .rule: return "rules"
        case .settings: return "settings"
        }
    }

    static func serverTask(_ id: UUID, _ db: Database) throws -> TaskItem? {
        try fetchJSON(TaskItem.self, "SELECT json FROM tasks WHERE id = ?", id, db)
    }

    static func serverNote(_ id: UUID, _ db: Database) throws -> TaskNote? {
        try fetchJSON(TaskNote.self, "SELECT json FROM notes WHERE id = ?", id, db)
    }

    static func serverChecklistItem(_ id: UUID, _ db: Database) throws -> ChecklistItem? {
        try fetchJSON(ChecklistItem.self, "SELECT json FROM checklist WHERE id = ?", id, db)
    }

    static func serverClarification(_ id: UUID, _ db: Database) throws -> Clarification? {
        try fetchJSON(Clarification.self, "SELECT json FROM clarifications WHERE id = ?", id, db)
    }

    static func fetchJSON<T: Decodable>(_ type: T.Type, _ sql: String, _ id: UUID, _ db: Database) throws -> T? {
        guard let json = try String.fetchOne(db, sql: sql, arguments: [id.lowercased]) else { return nil }
        return try APIJSON.decode(T.self, from: Data(json.utf8))
    }
}
