import Foundation
import GRDB

public enum OutboxOrigin: String, Codable, Sendable {
    case app, widget, share
}

/// Nur lokal gespeichert, nie gesendet.
public struct OutboxContext: Codable, Sendable, Hashable {
    /// Feldwerte, wie sie vor der Änderung zu sehen waren (für die Prüfung vor dem Senden).
    public var preimage: [String: JSONValue]?
    /// Status vor „Nicht relevant“, für die optimistische Anzeige von „Rückgängig“.
    public var restoreStatus: TaskStatus?

    public init(preimage: [String: JSONValue]? = nil, restoreStatus: TaskStatus? = nil) {
        self.preimage = preimage
        self.restoreStatus = restoreStatus
    }
}

/// Persistierte Mutation. Der Body wird nach dem ersten Sendeversuch nie mehr verändert,
/// damit Wiederholungen mit demselben Idempotency-Key exakt dieselbe Anfrage sind.
public struct OutboxEntry: Sendable, Hashable {
    public var seq: Int64
    public var mutation: Mutation
    public var body: Data
    public var taskId: UUID?
    public var context: OutboxContext
    public var origin: OutboxOrigin
    public var createdAt: Date
    public var attempts: Int
    public var lastAttemptAt: Date?
    public var lastError: String?
    /// Vom Server bestätigt (applied/duplicate), aber noch nicht durch einen Abruf abgedeckt.
    public var acknowledgedAt: Date?
    public var resultVersion: Int?

    public var isAcknowledged: Bool { acknowledgedAt != nil }
    public var isUnsent: Bool { attempts == 0 && acknowledgedAt == nil }
    public var idempotencyKey: UUID { mutation.idempotencyKey }
}

struct EntityKey: Hashable {
    let type: SyncEntityType
    let id: UUID
    init(_ entry: OutboxEntry) {
        type = entry.mutation.entityType
        id = entry.mutation.entityId
    }
}

public struct PreparedBatch: Sendable {
    public var entries: [OutboxEntry]
    /// Vor dem Senden verworfene Änderungen (Konflikt mit neuerem Serverstand).
    public var dropped: Int
}

public struct ResultCounts: Sendable, Hashable {
    public var acknowledged = 0
    public var conflicts = 0
    public var rejected = 0
    public var unanswered = 0
}

extension LocalStore {
    // MARK: Lesen

    public func outbox() throws -> [OutboxEntry] {
        try writer.read { db in try Self.outboxEntries(db) }
    }

    /// Noch nicht vom Server bestätigte Änderungen.
    public func pendingChangeCount() throws -> Int {
        try writer.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM outbox WHERE acknowledgedAt IS NULL") ?? 0 }
    }

    public func hasAcknowledgedEntries() throws -> Bool {
        try writer.read { db in try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM outbox WHERE acknowledgedAt IS NOT NULL)") ?? false }
    }

    static func outboxEntries(_ db: Database, where clause: String = "1 = 1", arguments: StatementArguments = []) throws -> [OutboxEntry] {
        let decoder = APIJSON.decoder()
        return try Row.fetchAll(db, sql: "SELECT * FROM outbox WHERE \(clause) ORDER BY seq", arguments: arguments).compactMap { row in
            let body = Data((row["body"] as String).utf8)
            guard let mutation = try? decoder.decode(Mutation.self, from: body),
                  let origin = OutboxOrigin(rawValue: row["origin"]) else { return nil }
            let context = (try? decoder.decode(OutboxContext.self, from: Data((row["context"] as String).utf8))) ?? OutboxContext()
            return OutboxEntry(
                seq: row["seq"],
                mutation: mutation,
                body: body,
                taskId: (row["taskId"] as String?).flatMap(UUID.init(uuidString:)),
                context: context,
                origin: origin,
                createdAt: Date(dbValue: row["createdAt"]),
                attempts: row["attempts"],
                lastAttemptAt: (row["lastAttemptAt"] as Double?).map(Date.init(dbValue:)),
                lastError: row["lastError"],
                acknowledgedAt: (row["acknowledgedAt"] as Double?).map(Date.init(dbValue:)),
                resultVersion: row["resultVersion"]
            )
        }
    }

    // MARK: Schreiben

    static func insertEntry(_ mutation: Mutation, taskId: UUID?, context: OutboxContext, origin: OutboxOrigin, now: Date, _ db: Database) throws {
        try db.execute(sql: """
            INSERT INTO outbox (idempotencyKey, type, entityType, entityId, taskId, baseVersion, body, context, origin, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, arguments: [mutation.idempotencyKey.lowercased, mutation.type, mutation.entityType.rawValue, mutation.entityId.lowercased,
                             taskId?.lowercased, mutation.baseVersion, try APIJSON.string(mutation), try APIJSON.string(context),
                             origin.rawValue, now.dbValue])
    }

    /// Nur für noch nie gesendete Einträge.
    static func replaceEntry(seq: Int64, with mutation: Mutation, context: OutboxContext, _ db: Database) throws {
        try db.execute(sql: "UPDATE outbox SET type = ?, baseVersion = ?, body = ?, context = ? WHERE seq = ? AND attempts = 0",
                       arguments: [mutation.type, mutation.baseVersion, try APIJSON.string(mutation), try APIJSON.string(context), seq])
    }

    static func deleteEntry(seq: Int64, _ db: Database) throws {
        try db.execute(sql: "DELETE FROM outbox WHERE seq = ?", arguments: [seq])
    }

    /// Neue lokale Änderung aufnehmen. Noch nie gesendete Änderungen derselben Entität werden zusammengefasst,
    /// sofern das am Ergebnis nichts ändert (z. B. zwei Statuswechsel, Notiz anlegen und gleich bearbeiten).
    static func enqueue(_ mutation: Mutation, taskId: UUID?, context: OutboxContext, origin: OutboxOrigin, now: Date, _ db: Database) throws {
        let unsent = try outboxEntries(db, where: "entityType = ? AND entityId = ? AND attempts = 0 AND acknowledgedAt IS NULL",
                                       arguments: [mutation.entityType.rawValue, mutation.entityId.lowercased])
        let last = unsent.last

        func replaceLast(_ kind: MutationKind, preimage: [String: JSONValue]? = nil) throws {
            guard let last else { return }
            var merged = last.mutation
            merged.kind = kind
            merged.clientTimestamp = mutation.clientTimestamp ?? merged.clientTimestamp
            var mergedContext = last.context
            if let preimage {
                // Der früheste Ausgangswert je Feld bleibt maßgeblich.
                mergedContext.preimage = (last.context.preimage ?? [:]).merging(preimage) { earlier, _ in earlier }
            }
            try replaceEntry(seq: last.seq, with: merged, context: mergedContext, db)
        }

        switch (mutation.kind, last?.mutation.kind) {
        case let (.taskUpdate(patch), .taskUpdate(earlier)?) where last?.mutation.baseVersion == mutation.baseVersion:
            try replaceLast(.taskUpdate(earlier.merged(with: patch)), preimage: context.preimage ?? [:])
            return
        case (.taskRestore, .taskDismiss?), (.taskDismiss, .taskRestore?):
            // „Nicht relevant“ und sofort „Rückgängig“: nichts zu senden.
            try deleteEntry(seq: last!.seq, db)
            return
        case let (.noteUpdate(body), .noteCreate(noteTaskId, _)?):
            try replaceLast(.noteCreate(taskId: noteTaskId, body: body))
            return
        case let (.noteUpdate(body), .noteUpdate?) where last?.mutation.baseVersion == mutation.baseVersion:
            try replaceLast(.noteUpdate(body: body), preimage: context.preimage ?? [:])
            return
        case let (.checklistUpdate(title, nil, position), .checklistCreate(itemTaskId, earlierTitle, earlierPosition)?):
            try replaceLast(.checklistCreate(taskId: itemTaskId, title: title ?? earlierTitle, position: position ?? earlierPosition))
            return
        case let (.checklistUpdate(title, done, position), .checklistUpdate(t0, d0, p0)?) where last?.mutation.baseVersion == mutation.baseVersion:
            try replaceLast(.checklistUpdate(title: title ?? t0, done: done ?? d0, position: position ?? p0), preimage: context.preimage ?? [:])
            return
        case (.clarificationAnswer, .clarificationAnswer?):
            try replaceLast(mutation.kind)
            return
        case (.noteDelete, _), (.checklistDelete, _):
            if unsent.contains(where: { $0.mutation.kind.isCreate }) {
                // Lokal angelegt und wieder gelöscht, bevor der Server es kannte.
                for entry in unsent { try deleteEntry(seq: entry.seq, db) }
                return
            }
            var deletion = mutation
            var deletionContext = context
            if let firstUpdate = unsent.first {
                deletion.baseVersion = firstUpdate.mutation.baseVersion
                deletionContext.preimage = firstUpdate.context.preimage ?? context.preimage
                for entry in unsent { try deleteEntry(seq: entry.seq, db) }
            }
            try insertEntry(deletion, taskId: taskId, context: deletionContext, origin: origin, now: now, db)
            return
        default:
            try insertEntry(mutation, taskId: taskId, context: context, origin: origin, now: now, db)
        }
    }

    // MARK: Senden

    /// Nächster Stapel (max. `limit`) in Reihenfolge. Pro Entität höchstens eine Änderung je Stapel;
    /// Entitäten mit bestätigten, aber noch nicht abgerufenen Änderungen warten auf den nächsten Abruf.
    /// Noch nie gesendete Änderungen werden vorher gegen den inzwischen abgerufenen Serverstand geprüft.
    public func prepareBatch(limit: Int = 100, now: Date) throws -> PreparedBatch {
        try writer.write { db in
            let all = try Self.outboxEntries(db)
            let blocked = Set(all.filter(\.isAcknowledged).map(EntityKey.init))
            var seen = Set<EntityKey>()
            var batch: [OutboxEntry] = []
            var dropped = 0
            for entry in all where !entry.isAcknowledged {
                let key = EntityKey(entry)
                if blocked.contains(key) || seen.contains(key) { break }
                var candidate = entry
                if entry.isUnsent {
                    switch try Self.revalidate(entry, now: now, db) {
                    case .unchanged: break
                    case .rebased(let updated): candidate = updated
                    case .dropped:
                        dropped += 1
                        continue
                    }
                }
                seen.insert(key)
                batch.append(candidate)
                if batch.count >= limit { break }
            }
            for entry in batch {
                try db.execute(sql: "UPDATE outbox SET attempts = attempts + 1, lastAttemptAt = ? WHERE seq = ?", arguments: [now.dbValue, entry.seq])
            }
            return PreparedBatch(entries: batch, dropped: dropped)
        }
    }

    enum Revalidation {
        case unchanged
        case rebased(OutboxEntry)
        case dropped
    }

    /// Hat der Server die Entität seit `baseVersion` geändert, wird mit den Ausgangswerten verglichen:
    /// unverändert → auf die neue Version setzen; vom anderen Gerät geändert → Feld nicht senden und Konflikt zeigen.
    static func revalidate(_ entry: OutboxEntry, now: Date, _ db: Database) throws -> Revalidation {
        let mutation = entry.mutation
        guard mutation.kind.requiresBaseVersion, let base = mutation.baseVersion,
              let serverVersion = try serverVersion(of: mutation.entityType, id: mutation.entityId, db), serverVersion > base else {
            return .unchanged
        }
        let preimage = entry.context.preimage ?? [:]

        func rebase(_ kind: MutationKind, preimage newPreimage: [String: JSONValue]? = nil) throws -> Revalidation {
            var updated = entry
            updated.mutation.baseVersion = serverVersion
            updated.mutation.kind = kind
            if let newPreimage { updated.context.preimage = newPreimage }
            updated.body = try APIJSON.encode(updated.mutation)
            try replaceEntry(seq: entry.seq, with: updated.mutation, context: updated.context, db)
            return .rebased(updated)
        }

        func drop(conflicting fields: [String]) throws -> Revalidation {
            try deleteEntry(seq: entry.seq, db)
            if !fields.isEmpty {
                try insert(conflictNotice(for: entry, fields: fields, now: now), db)
            }
            return .dropped
        }

        switch mutation.kind {
        case .taskUpdate(let patch):
            guard let server = try serverTask(mutation.entityId, db) else { return .unchanged }
            let current = TaskEffects.comparableFields(of: server)
            let target = TaskEffects.comparableFields(of: TaskEffects.apply(patch, to: server, now: now))
            var conflicting: [String] = []
            var alreadyDone: [String] = []
            for field in patch.fieldNames where preimage[field] != current[field] {
                if current[field] == target[field] { alreadyDone.append(field) } else { conflicting.append(field) }
            }
            let remaining = patch.removing(fields: Set(conflicting + alreadyDone))
            if remaining.isEmpty { return try drop(conflicting: conflicting) }
            if !conflicting.isEmpty {
                try insert(conflictNotice(for: entry, fields: conflicting, now: now), db)
            }
            return try rebase(.taskUpdate(remaining), preimage: preimage.filter { remaining.fieldNames.contains($0.key) })
        case .taskDismiss, .taskRestore:
            guard let server = try serverTask(mutation.entityId, db) else { return .unchanged }
            let current = TaskEffects.comparableFields(of: server)["status"]
            if preimage["status"] == current { return try rebase(mutation.kind) }
            let wantsDismissed = { if case .taskDismiss = mutation.kind { return true } else { return false } }()
            let alreadyThere = (server.status == .dismissed) == wantsDismissed
            return try drop(conflicting: alreadyThere ? [] : ["status"])
        case .noteUpdate, .noteDelete:
            // Bei Abweichung entscheidet der Server: Konkurrierende Fassungen bleiben dort als eigene Notiz erhalten.
            guard let note = try serverNote(mutation.entityId, db), preimage["body"] == .string(note.body) else { return .unchanged }
            return try rebase(mutation.kind)
        case let .checklistUpdate(title, _, position):
            guard let item = try serverChecklistItem(mutation.entityId, db) else { return .unchanged }
            let current = TaskEffects.comparableFields(of: item)
            var changed: [String] = []
            if title != nil { changed.append("title") }
            if position != nil { changed.append("position") }
            // Häkchen setzt der Server unabhängig von der Version (wie dort).
            let conflicting = changed.filter { preimage[$0] != current[$0] }
            if !conflicting.isEmpty { return try drop(conflicting: conflicting) }
            return try rebase(mutation.kind)
        case .checklistDelete:
            return try rebase(mutation.kind)
        default:
            return .unchanged
        }
    }

    public func recordSendFailure(_ batch: [OutboxEntry], message: String) throws {
        try writer.write { db in
            for entry in batch {
                try db.execute(sql: "UPDATE outbox SET lastError = ? WHERE seq = ?", arguments: [message, entry.seq])
            }
        }
    }

    /// `applied`/`duplicate` → bestätigt (Anzeige bleibt, bis der Abruf den Serverstand bringt);
    /// `conflict` → entfernen, Serverwert gilt, Hinweis; `rejected` → entfernen, Fehler sichtbar.
    public func applyResults(_ results: [MutationResult], for batch: [OutboxEntry], now: Date) throws -> ResultCounts {
        try writer.write { db in
            var counts = ResultCounts()
            let byKey = Dictionary(results.map { ($0.idempotencyKey, $0) }, uniquingKeysWith: { first, _ in first })
            for entry in batch {
                guard let result = byKey[entry.idempotencyKey] else {
                    counts.unanswered += 1
                    continue
                }
                switch result.status {
                case .applied, .duplicate:
                    try db.execute(sql: "UPDATE outbox SET acknowledgedAt = ?, resultVersion = ?, lastError = NULL WHERE seq = ?",
                                   arguments: [now.dbValue, result.version, entry.seq])
                    counts.acknowledged += 1
                case .conflict:
                    try Self.deleteEntry(seq: entry.seq, db)
                    try Self.insert(Self.conflictNotice(for: entry, fields: result.conflictingFields, now: now), db)
                    counts.conflicts += 1
                case .rejected:
                    try Self.deleteEntry(seq: entry.seq, db)
                    let reason = result.error?.message ?? "Unbekannter Fehler"
                    try Self.insert(SyncNotice(kind: .rejected, entityType: entry.mutation.entityType, entityId: entry.mutation.entityId,
                                               taskId: entry.taskId, message: "Änderung nicht übernommen: \(reason)", createdAt: now), db)
                    counts.rejected += 1
                }
            }
            return counts
        }
    }

    static func conflictNotice(for entry: OutboxEntry, fields: [String], now: Date) -> SyncNotice {
        let message: String
        switch entry.mutation.kind {
        case .noteUpdate:
            message = "Diese Notiz wurde gleichzeitig auf einem anderen Gerät bearbeitet. Beide Fassungen bleiben erhalten."
        case .noteDelete:
            message = "Die Notiz wurde auf einem anderen Gerät geändert und deshalb nicht gelöscht."
        case .checklistUpdate, .checklistDelete, .checklistCreate:
            message = "Der Checklisten-Eintrag wurde auf einem anderen Gerät geändert. Der neuere Stand gilt."
        case .clarificationAnswer:
            message = "Diese Rückfrage wurde bereits anders beantwortet."
        default:
            message = fields.isEmpty
                ? "Auf einem anderen Gerät geändert. Der neuere Stand wurde übernommen."
                : "Auf einem anderen Gerät geändert (\(GermanText.fields(fields))). Der neuere Stand wurde übernommen."
        }
        return SyncNotice(kind: .conflict, entityType: entry.mutation.entityType, entityId: entry.mutation.entityId,
                          taskId: entry.taskId, fields: fields, message: message, createdAt: now)
    }
}
