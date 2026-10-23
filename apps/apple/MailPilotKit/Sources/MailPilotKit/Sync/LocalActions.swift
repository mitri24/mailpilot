import Foundation
import GRDB

public enum LocalActionError: Error, Sendable, Equatable, LocalizedError {
    case notFound
    case invalid(String)

    public var errorDescription: String? {
        switch self {
        case .notFound: return "Nicht gefunden. Bitte aktualisieren."
        case .invalid(let message): return message
        }
    }
}

/// Lokale Änderungen: sofort sichtbar (Outbox-Überlagerung) und als Mutation mit eigenem Idempotency-Key gespeichert.
/// Von App, Widget-Intents und Share Extension gemeinsam genutzt.
public struct LocalActions: Sendable {
    public let store: LocalStore
    public let origin: OutboxOrigin
    private let clock: @Sendable () -> Date

    public init(store: LocalStore, origin: OutboxOrigin = .app, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.origin = origin
        self.clock = clock
    }

    // MARK: Aufgaben

    /// Ändert nur Felder, die sich tatsächlich ändern. Gibt `false` zurück, wenn nichts zu tun war.
    @discardableResult
    public func updateTask(_ id: UUID, _ patch: TaskPatch) throws -> Bool {
        try Validation.check(patch)
        let now = clock()
        let origin = origin
        return try store.writer.write { db in
            guard let current = try LocalStore.effectiveTask(id, db) else { throw LocalActionError.notFound }
            let before = TaskEffects.comparableFields(of: current)
            let after = TaskEffects.comparableFields(of: TaskEffects.apply(patch, to: current, now: now))
            let unchanged = Set(patch.fieldNames.filter { before[$0] == after[$0] })
            let effective = patch.removing(fields: unchanged)
            guard !effective.isEmpty else { return false }
            let base = try LocalStore.serverVersion(of: .task, id: id, db) ?? 0
            let preimage = before.filter { effective.fieldNames.contains($0.key) }
            let mutation = Mutation(clientTimestamp: now, entityId: id, baseVersion: base, kind: .taskUpdate(effective))
            try LocalStore.enqueue(mutation, taskId: id, context: OutboxContext(preimage: preimage), origin: origin, now: now, db)
            return true
        }
    }

    @discardableResult
    public func setStatus(_ status: TaskStatus, taskId: UUID) throws -> Bool {
        if status == .dismissed {
            try dismissTask(taskId)
            return true
        }
        return try updateTask(taskId, TaskPatch(status: status))
    }

    /// Eigene Aufgabe ohne Mail; optional mit erster Notiz (getrennt vom KI-Inhalt).
    public func createTask(id: UUID = UUID(), title: String, nextStep: String? = nil, priority: Priority? = nil,
                           deadline: ManualDeadline? = nil, note: String? = nil) throws -> UUID {
        let title = try Validation.title(title)
        let nextStep = try Validation.optionalText(nextStep, max: 1000, field: "Der nächste Schritt")
        let note = try Validation.optionalText(note, max: 20_000, field: "Die Notiz")
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            let create = Mutation(clientTimestamp: now, entityId: id,
                                  kind: .taskCreate(title: title, nextStep: nextStep, priority: priority, deadline: deadline?.normalized))
            try LocalStore.insertEntry(create, taskId: id, context: OutboxContext(), origin: origin, now: now, db)
            if let note {
                let noteMutation = Mutation(clientTimestamp: now, entityId: UUID(), kind: .noteCreate(taskId: id, body: note))
                try LocalStore.insertEntry(noteMutation, taskId: id, context: OutboxContext(), origin: origin, now: now, db)
            }
        }
        return id
    }

    /// „Nicht relevant“ (rückgängig machbar).
    public func dismissTask(_ id: UUID) throws {
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let current = try LocalStore.effectiveTask(id, db) else { throw LocalActionError.notFound }
            guard current.status != .dismissed else { return }
            let base = try LocalStore.serverVersion(of: .task, id: id, db) ?? 0
            let context = OutboxContext(preimage: ["status": .string(current.status.rawValue)], restoreStatus: current.status)
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, baseVersion: base, kind: .taskDismiss),
                                   taskId: id, context: context, origin: origin, now: now, db)
        }
    }

    public func restoreTask(_ id: UUID) throws {
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let current = try LocalStore.effectiveTask(id, db) else { throw LocalActionError.notFound }
            guard current.status == .dismissed else { return }
            let base = try LocalStore.serverVersion(of: .task, id: id, db) ?? 0
            let previous = try LocalStore.outboxEntries(db, where: "entityType = 'task' AND entityId = ? AND type = 'task.dismiss'", arguments: [id.lowercased])
                .last?.context.restoreStatus
            let context = OutboxContext(preimage: ["status": .string(TaskStatus.dismissed.rawValue)], restoreStatus: previous)
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, baseVersion: base, kind: .taskRestore),
                                   taskId: id, context: context, origin: origin, now: now, db)
        }
    }

    /// Mehrere Sortierschlüssel auf einmal (manuelle Reihenfolge).
    public func setSortKeys(_ keys: [UUID: Double]) throws {
        for (id, key) in keys.sorted(by: { $0.value < $1.value }) {
            try updateTask(id, TaskPatch(sortKey: .set(key)))
        }
    }

    // MARK: Notizen

    public func addNote(taskId: UUID, body: String) throws -> UUID {
        let body = try Validation.body(body)
        let id = UUID()
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard try LocalStore.effectiveTask(taskId, db) != nil else { throw LocalActionError.notFound }
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, kind: .noteCreate(taskId: taskId, body: body)),
                                   taskId: taskId, context: OutboxContext(), origin: origin, now: now, db)
        }
        return id
    }

    public func updateNote(_ id: UUID, body: String) throws {
        let body = try Validation.body(body)
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let note = try LocalStore.effectiveNote(id, db) else { throw LocalActionError.notFound }
            guard note.body != body else { return }
            let base = try LocalStore.serverVersion(of: .note, id: id, db) ?? 0
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, baseVersion: base, kind: .noteUpdate(body: body)),
                                   taskId: note.taskId, context: OutboxContext(preimage: TaskEffects.comparableFields(of: note)), origin: origin, now: now, db)
        }
    }

    public func deleteNote(_ id: UUID) throws {
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let note = try LocalStore.effectiveNote(id, db) else { return }
            let base = try LocalStore.serverVersion(of: .note, id: id, db) ?? 0
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, baseVersion: base, kind: .noteDelete),
                                   taskId: note.taskId, context: OutboxContext(preimage: TaskEffects.comparableFields(of: note)), origin: origin, now: now, db)
        }
    }

    // MARK: Checkliste

    public func addChecklistItem(taskId: UUID, title: String) throws -> UUID {
        let title = try Validation.title(title)
        let id = UUID()
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard try LocalStore.effectiveTask(taskId, db) != nil else { throw LocalActionError.notFound }
            // Position explizit senden, damit lokale Anzeige und Server übereinstimmen.
            let stored = try Double.fetchOne(db, sql: "SELECT MAX(position) FROM checklist WHERE taskId = ?", arguments: [taskId.lowercased]) ?? 0
            let pending = try LocalStore.outboxEntries(db, where: "type = 'checklist.create' AND taskId = ?", arguments: [taskId.lowercased])
                .compactMap { entry -> Double? in
                    if case let .checklistCreate(_, _, position) = entry.mutation.kind { return position }
                    return nil
                }.max() ?? 0
            let position = max(stored, pending) + 1
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, kind: .checklistCreate(taskId: taskId, title: title, position: position)),
                                   taskId: taskId, context: OutboxContext(), origin: origin, now: now, db)
        }
        return id
    }

    public func updateChecklistItem(_ id: UUID, title: String? = nil, done: Bool? = nil, position: Double? = nil) throws {
        let title = try title.map(Validation.title)
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let item = try LocalStore.effectiveChecklistItem(id, db) else { throw LocalActionError.notFound }
            let newTitle = title == item.title ? nil : title
            let newDone = done == item.done ? nil : done
            let newPosition = position == item.position ? nil : position
            guard newTitle != nil || newDone != nil || newPosition != nil else { return }
            let base = try LocalStore.serverVersion(of: .checklistItem, id: id, db) ?? 0
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, baseVersion: base,
                                            kind: .checklistUpdate(title: newTitle, done: newDone, position: newPosition)),
                                   taskId: item.taskId, context: OutboxContext(preimage: TaskEffects.comparableFields(of: item)), origin: origin, now: now, db)
        }
    }

    public func deleteChecklistItem(_ id: UUID) throws {
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let item = try LocalStore.effectiveChecklistItem(id, db) else { return }
            let base = try LocalStore.serverVersion(of: .checklistItem, id: id, db) ?? 0
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, baseVersion: base, kind: .checklistDelete),
                                   taskId: item.taskId, context: OutboxContext(preimage: TaskEffects.comparableFields(of: item)), origin: origin, now: now, db)
        }
    }

    // MARK: Rückfragen

    /// `later` lässt die Rückfrage offen. „Dauerhaft“ nur, wenn die gewählte Option es erlaubt (prüft auch der Server).
    public func answerClarification(_ id: UUID, optionId: String?, text: String?, scope: AnswerScope) throws {
        let text = try Validation.optionalText(text, max: 2000, field: "Die Antwort")
        let now = clock()
        let origin = origin
        try store.writer.write { db in
            guard let clarification = try LocalStore.effectiveClarification(id, db) else { throw LocalActionError.notFound }
            if let optionId, !clarification.options.contains(where: { $0.id == optionId }) {
                throw LocalActionError.invalid("Diese Antwort ist für die Rückfrage nicht vorgesehen.")
            }
            if optionId == nil {
                guard text != nil else { throw LocalActionError.invalid("Bitte eine Antwort wählen oder eingeben.") }
                guard clarification.allowFreeText else { throw LocalActionError.invalid("Für diese Rückfrage ist keine freie Antwort vorgesehen.") }
            }
            try LocalStore.enqueue(Mutation(clientTimestamp: now, entityId: id, kind: .clarificationAnswer(optionId: optionId, text: text, scope: scope)),
                                   taskId: clarification.taskId, context: OutboxContext(), origin: origin, now: now, db)
        }
    }
}

/// Grenzen aus dem Vertrag, damit der Server nichts ablehnen muss.
enum Validation {
    static func title(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LocalActionError.invalid("Bitte einen Titel eingeben.") }
        guard trimmed.count <= 300 else { throw LocalActionError.invalid("Der Titel ist zu lang (höchstens 300 Zeichen).") }
        return trimmed
    }

    static func body(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LocalActionError.invalid("Die Notiz ist leer.") }
        guard value.count <= 20_000 else { throw LocalActionError.invalid("Die Notiz ist zu lang (höchstens 20 000 Zeichen).") }
        return value
    }

    static func optionalText(_ value: String?, max: Int, field: String) throws -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.count <= max else { throw LocalActionError.invalid("\(field) ist zu lang (höchstens \(max) Zeichen).") }
        return trimmed
    }

    static func check(_ patch: TaskPatch) throws {
        if case .set(let title) = patch.title { _ = try Validation.title(title) }
        if case .set(let nextStep) = patch.nextStep, nextStep.count > 1000 {
            throw LocalActionError.invalid("Der nächste Schritt ist zu lang (höchstens 1000 Zeichen).")
        }
        if case .set(let minutes) = patch.estimatedMinutes, !(1...10_000).contains(minutes) {
            throw LocalActionError.invalid("Der Zeitaufwand muss zwischen 1 und 10 000 Minuten liegen.")
        }
    }
}
