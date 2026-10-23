import Foundation
import GRDB

/// Lokaler Cache und Outbox (GRDB/SQLite). Im App-Group-Container teilen App, Widget und Share Extension dieselbe Datei.
/// Das Backend bleibt die Quelle; hier liegen der zuletzt bekannte Serverstand und die noch nicht bestätigten Änderungen.
public final class LocalStore: Sendable {
    public let writer: any DatabaseWriter
    /// `true`, wenn die Datei im App-Group-Container liegt (Widget und Share Extension sehen denselben Stand).
    public let isShared: Bool

    public init(writer: any DatabaseWriter, isShared: Bool = false) throws {
        self.writer = writer
        self.isShared = isShared
        try Self.migrator().migrate(writer)
    }

    /// Für Tests und Vorschauen.
    public static func inMemory() throws -> LocalStore {
        try LocalStore(writer: DatabaseQueue())
    }

    /// Öffnet (oder erstellt) die Datenbankdatei. WAL-Modus über `DatabasePool`, damit mehrere Prozesse lesen und schreiben können.
    public static func open(at url: URL, isShared: Bool = false) throws -> LocalStore {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var configuration = Configuration()
        configuration.busyMode = .timeout(5)
        #if os(iOS)
        // Die App sendet beim Wechsel in den Hintergrund `Database.suspendNotification` (Sperren im App-Group-Container).
        configuration.observesSuspensionNotifications = true
        #endif
        // Öffnen und Migrieren koordiniert, falls App und Erweiterung gleichzeitig starten.
        var coordinationError: NSError?
        var outcome: Result<DatabasePool, any Error> = .failure(CocoaError(.fileReadUnknown))
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forMerging, error: &coordinationError) { coordinatedURL in
            outcome = Result {
                let pool = try DatabasePool(path: coordinatedURL.path, configuration: configuration)
                try Self.migrator().migrate(pool)
                return pool
            }
        }
        if let coordinationError { throw coordinationError }
        let pool = try outcome.get()
        return try LocalStore(writer: pool, isShared: isShared)
    }

    /// Datei im App-Group-Container; ohne Container (fehlendes Entitlement) im eigenen Application-Support-Ordner.
    public static func databaseURL(appGroup: String?) -> (url: URL, isShared: Bool) {
        let fileManager = FileManager.default
        if let appGroup, !appGroup.isEmpty,
           let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            return (container.appendingPathComponent("Library/Application Support/MailPilot/cache.sqlite"), true)
        }
        let base = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fileManager.temporaryDirectory
        return (base.appendingPathComponent("MailPilot/cache.sqlite"), false)
    }

    static func migrator() -> DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY NOT NULL,
                    version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    waiting INTEGER NOT NULL,
                    plannedFor TEXT,
                    snoozedUntil REAL,
                    sortKey REAL,
                    mergedIntoTaskId TEXT,
                    updatedAt REAL NOT NULL,
                    json TEXT NOT NULL,
                    detailJson TEXT,
                    detailFetchedAt REAL
                );
                CREATE INDEX tasks_status ON tasks(status);
                CREATE TABLE notes (
                    id TEXT PRIMARY KEY NOT NULL,
                    taskId TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE INDEX notes_task ON notes(taskId);
                CREATE TABLE checklist (
                    id TEXT PRIMARY KEY NOT NULL,
                    taskId TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    position REAL NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE INDEX checklist_task ON checklist(taskId);
                CREATE TABLE clarifications (
                    id TEXT PRIMARY KEY NOT NULL,
                    status TEXT NOT NULL,
                    taskId TEXT,
                    version INTEGER NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE TABLE accounts (
                    id TEXT PRIMARY KEY NOT NULL,
                    status TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE TABLE rules (
                    id TEXT PRIMARY KEY NOT NULL,
                    version INTEGER NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE TABLE settings (
                    id TEXT PRIMARY KEY NOT NULL,
                    version INTEGER NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE TABLE outbox (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    idempotencyKey TEXT NOT NULL UNIQUE,
                    type TEXT NOT NULL,
                    entityType TEXT NOT NULL,
                    entityId TEXT NOT NULL,
                    taskId TEXT,
                    baseVersion INTEGER,
                    body TEXT NOT NULL,
                    context TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    createdAt REAL NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    lastAttemptAt REAL,
                    lastError TEXT,
                    acknowledgedAt REAL,
                    resultVersion INTEGER
                );
                CREATE INDEX outbox_entity ON outbox(entityType, entityId);
                CREATE TABLE sync_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    userId TEXT,
                    cursor TEXT,
                    lastSuccessfulSyncAt REAL,
                    lastAttemptAt REAL,
                    lastErrorMessage TEXT,
                    lastErrorWasOffline INTEGER NOT NULL DEFAULT 0,
                    consecutiveFailures INTEGER NOT NULL DEFAULT 0,
                    serverPendingAnalysisCount INTEGER,
                    serverTodayAt REAL
                );
                INSERT INTO sync_state (id) VALUES (1);
                CREATE TABLE widget_snapshot (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    json TEXT NOT NULL,
                    updatedAt REAL NOT NULL
                );
                CREATE TABLE sync_notices (
                    id TEXT PRIMARY KEY NOT NULL,
                    kind TEXT NOT NULL,
                    entityType TEXT NOT NULL,
                    entityId TEXT NOT NULL,
                    taskId TEXT,
                    fields TEXT NOT NULL,
                    message TEXT NOT NULL,
                    createdAt REAL NOT NULL,
                    dismissedAt REAL
                );
                """)
        }
        return migrator
    }
}

// MARK: - Synchronisierungsstand

public struct SyncStateRecord: Sendable, Hashable {
    public var userId: UUID?
    public var cursor: String?
    public var lastSuccessfulSyncAt: Date?
    public var lastAttemptAt: Date?
    public var lastErrorMessage: String?
    public var lastErrorWasOffline: Bool
    public var consecutiveFailures: Int
    public var serverPendingAnalysisCount: Int?
    public var serverTodayAt: Date?

    public init(userId: UUID? = nil, cursor: String? = nil, lastSuccessfulSyncAt: Date? = nil, lastAttemptAt: Date? = nil, lastErrorMessage: String? = nil,
                lastErrorWasOffline: Bool = false, consecutiveFailures: Int = 0, serverPendingAnalysisCount: Int? = nil, serverTodayAt: Date? = nil) {
        self.userId = userId
        self.cursor = cursor
        self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
        self.lastAttemptAt = lastAttemptAt
        self.lastErrorMessage = lastErrorMessage
        self.lastErrorWasOffline = lastErrorWasOffline
        self.consecutiveFailures = consecutiveFailures
        self.serverPendingAnalysisCount = serverPendingAnalysisCount
        self.serverTodayAt = serverTodayAt
    }
}

/// Sichtbar zu machende Ergebnisse der Synchronisierung (Konflikt, abgelehnt).
public struct SyncNotice: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable { case conflict, rejected }

    public var id: UUID
    public var kind: Kind
    public var entityType: SyncEntityType
    public var entityId: UUID
    public var taskId: UUID?
    public var fields: [String]
    public var message: String
    public var createdAt: Date

    public init(id: UUID = UUID(), kind: Kind, entityType: SyncEntityType, entityId: UUID, taskId: UUID?, fields: [String] = [], message: String, createdAt: Date) {
        self.id = id
        self.kind = kind
        self.entityType = entityType
        self.entityId = entityId
        self.taskId = taskId
        self.fields = fields
        self.message = message
        self.createdAt = createdAt
    }
}

extension Date {
    var dbValue: Double { timeIntervalSince1970 }
    init(dbValue: Double) { self.init(timeIntervalSince1970: dbValue) }
}

extension LocalStore {
    public func syncState() throws -> SyncStateRecord {
        try writer.read { db in try Self.syncState(db) }
    }

    static func syncState(_ db: Database) throws -> SyncStateRecord {
        guard let row = try Row.fetchOne(db, sql: "SELECT * FROM sync_state WHERE id = 1") else { return SyncStateRecord() }
        return SyncStateRecord(
            userId: (row["userId"] as String?).flatMap(UUID.init(uuidString:)),
            cursor: row["cursor"],
            lastSuccessfulSyncAt: (row["lastSuccessfulSyncAt"] as Double?).map(Date.init(dbValue:)),
            lastAttemptAt: (row["lastAttemptAt"] as Double?).map(Date.init(dbValue:)),
            lastErrorMessage: row["lastErrorMessage"],
            lastErrorWasOffline: row["lastErrorWasOffline"] as Bool? ?? false,
            consecutiveFailures: row["consecutiveFailures"] as Int? ?? 0,
            serverPendingAnalysisCount: row["serverPendingAnalysisCount"],
            serverTodayAt: (row["serverTodayAt"] as Double?).map(Date.init(dbValue:))
        )
    }

    public func setCursor(_ cursor: String?) throws {
        try writer.write { db in try db.execute(sql: "UPDATE sync_state SET cursor = ? WHERE id = 1", arguments: [cursor]) }
    }

    public func recordSyncSuccess(at now: Date) throws {
        try writer.write { db in
            try db.execute(sql: """
                UPDATE sync_state SET lastSuccessfulSyncAt = ?, lastAttemptAt = ?, lastErrorMessage = NULL,
                    lastErrorWasOffline = 0, consecutiveFailures = 0 WHERE id = 1
                """, arguments: [now.dbValue, now.dbValue])
        }
    }

    public func recordSyncFailure(message: String, offline: Bool, at now: Date) throws {
        try writer.write { db in
            try db.execute(sql: """
                UPDATE sync_state SET lastAttemptAt = ?, lastErrorMessage = ?, lastErrorWasOffline = ?,
                    consecutiveFailures = consecutiveFailures + 1 WHERE id = 1
                """, arguments: [now.dbValue, message, offline])
        }
    }

    public func recordServerToday(pendingAnalysisCount: Int, at date: Date) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE sync_state SET serverPendingAnalysisCount = ?, serverTodayAt = ? WHERE id = 1",
                           arguments: [pendingAnalysisCount, date.dbValue])
        }
    }

    /// Bei einem anderen Benutzer als zuletzt: alles verwerfen (auch die Outbox, sie gehört dem anderen Konto).
    public func prepare(forUser userId: UUID) throws {
        try writer.write { db in
            let current = try String.fetchOne(db, sql: "SELECT userId FROM sync_state WHERE id = 1")
            if let current, current != userId.lowercased {
                try Self.wipe(db)
            }
            try db.execute(sql: "UPDATE sync_state SET userId = ? WHERE id = 1", arguments: [userId.lowercased])
        }
    }

    /// Abmelden: lokale Daten, Outbox und Snapshot löschen.
    public func wipeAll() throws {
        try writer.write { db in try Self.wipe(db) }
    }

    static func wipe(_ db: Database) throws {
        for table in ["tasks", "notes", "checklist", "clarifications", "accounts", "rules", "settings", "outbox", "widget_snapshot", "sync_notices"] {
            try db.execute(sql: "DELETE FROM \(table)")
        }
        try db.execute(sql: """
            UPDATE sync_state SET userId = NULL, cursor = NULL, lastSuccessfulSyncAt = NULL, lastAttemptAt = NULL, lastErrorMessage = NULL,
                lastErrorWasOffline = 0, consecutiveFailures = 0, serverPendingAnalysisCount = NULL, serverTodayAt = NULL WHERE id = 1
            """)
    }

    // MARK: Hinweise

    public func notices(includeDismissed: Bool = false) throws -> [SyncNotice] {
        try writer.read { db in try Self.notices(db, includeDismissed: includeDismissed) }
    }

    static func notices(_ db: Database, includeDismissed: Bool = false) throws -> [SyncNotice] {
        let sql = includeDismissed
            ? "SELECT * FROM sync_notices ORDER BY createdAt DESC"
            : "SELECT * FROM sync_notices WHERE dismissedAt IS NULL ORDER BY createdAt DESC"
        return try Row.fetchAll(db, sql: sql).compactMap { row in
            guard let id = UUID(uuidString: row["id"]),
                  let kind = SyncNotice.Kind(rawValue: row["kind"]),
                  let entityType = SyncEntityType(rawValue: row["entityType"]),
                  let entityId = UUID(uuidString: row["entityId"]) else { return nil }
            let fields = (try? APIJSON.decode([String].self, from: Data((row["fields"] as String).utf8))) ?? []
            return SyncNotice(id: id, kind: kind, entityType: entityType, entityId: entityId,
                              taskId: (row["taskId"] as String?).flatMap(UUID.init(uuidString:)),
                              fields: fields, message: row["message"], createdAt: Date(dbValue: row["createdAt"]))
        }
    }

    static func insert(_ notice: SyncNotice, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO sync_notices (id, kind, entityType, entityId, taskId, fields, message, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, arguments: [notice.id.lowercased, notice.kind.rawValue, notice.entityType.rawValue, notice.entityId.lowercased,
                             notice.taskId?.lowercased, try APIJSON.string(notice.fields), notice.message, notice.createdAt.dbValue])
    }

    public func dismissNotice(_ id: UUID, at now: Date = Date()) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE sync_notices SET dismissedAt = ? WHERE id = ?", arguments: [now.dbValue, id.lowercased])
        }
    }

    public func dismissNotices(forTask taskId: UUID, at now: Date = Date()) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE sync_notices SET dismissedAt = ? WHERE taskId = ? AND dismissedAt IS NULL", arguments: [now.dbValue, taskId.lowercased])
        }
    }

    public func dismissAllNotices(at now: Date = Date()) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE sync_notices SET dismissedAt = ? WHERE dismissedAt IS NULL", arguments: [now.dbValue])
        }
    }

    // MARK: Widget-Snapshot

    public func saveWidgetSnapshot(_ snapshot: WidgetSnapshot) throws {
        let json = try APIJSON.string(snapshot)
        try writer.write { db in
            try db.execute(sql: """
                INSERT INTO widget_snapshot (id, json, updatedAt) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET json = excluded.json, updatedAt = excluded.updatedAt
                """, arguments: [json, snapshot.generatedAt.dbValue])
        }
    }

    public func widgetSnapshot() throws -> WidgetSnapshot? {
        try writer.read { db in
            guard let json = try String.fetchOne(db, sql: "SELECT json FROM widget_snapshot WHERE id = 1") else { return nil }
            return try APIJSON.decode(WidgetSnapshot.self, from: Data(json.utf8))
        }
    }

    // MARK: Aufgabendetail (Quellen und Verlauf kommen nicht über den Änderungsfeed)

    public func saveDetail(_ detail: TaskDetail, at now: Date) throws {
        let detailJson = try APIJSON.string(detail)
        try writer.write { db in
            let stored = try Int.fetchOne(db, sql: "SELECT version FROM tasks WHERE id = ?", arguments: [detail.task.id.lowercased])
            if stored == nil || detail.task.version > stored! {
                try Self.upsert(task: detail.task, db)
            }
            try db.execute(sql: "UPDATE tasks SET detailJson = ?, detailFetchedAt = ? WHERE id = ?",
                           arguments: [detailJson, now.dbValue, detail.task.id.lowercased])
        }
    }

    public func cachedDetail(taskId: UUID) throws -> (detail: TaskDetail, fetchedAt: Date)? {
        try writer.read { db in
            guard let row = try Row.fetchOne(db, sql: "SELECT detailJson, detailFetchedAt FROM tasks WHERE id = ?", arguments: [taskId.lowercased]),
                  let json = row["detailJson"] as String?, let fetched = row["detailFetchedAt"] as Double? else { return nil }
            return (try APIJSON.decode(TaskDetail.self, from: Data(json.utf8)), Date(dbValue: fetched))
        }
    }
}
