import Foundation
import Testing
@testable import MailPilotKit

func seed(_ store: LocalStore, tasks: [TaskItem], notes: [TaskNote] = [], cursor: String = "100") throws {
    let changes = tasks.map { Change(seq: cursor, entityId: $0.id, op: .upsert, version: $0.version, data: .task($0)) }
        + notes.map { Change(seq: cursor, entityId: $0.id, op: .upsert, version: $0.version, data: .note($0)) }
    try store.apply(changes: changes, nextCursor: cursor, replacingAll: false)
}

@Suite("Outbox")
struct OutboxTests {
    let clock = TestClock(date("2026-10-23T08:00:00Z"))

    @Test("Bleibt über einen Neustart erhalten: gleiche Reihenfolge, gleiche Keys, gleiche Bytes")
    func persistsAcrossReopen() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mailpilot-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("cache.sqlite")
        let task = makeTask("Formular abgeben")
        var before: [OutboxEntry] = []
        do {
            let store = try LocalStore.open(at: url)
            try seed(store, tasks: [task])
            let actions = LocalActions(store: store, clock: clock.closure)
            try actions.setStatus(.doing, taskId: task.id)
            _ = try actions.createTask(title: "Eigene Aufgabe", note: "Ohne Mail")
            _ = try actions.addNote(taskId: task.id, body: "Angefragt")
            before = try store.outbox()
        }
        let reopened = try LocalStore.open(at: url)
        let after = try reopened.outbox()
        #expect(before.count == 4)
        #expect(after.map(\.seq) == before.map(\.seq))
        #expect(after.map(\.idempotencyKey) == before.map(\.idempotencyKey))
        #expect(after.map(\.body) == before.map(\.body))
        #expect(after.map(\.mutation.type) == ["task.update", "task.create", "note.create", "note.create"])
        #expect(try reopened.snapshot().tasks[task.id]?.status == .doing)
    }

    @Test("Lokale Änderung ist sofort sichtbar und als ausstehend markiert")
    func optimisticOverlay() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask("Studienbescheinigung schicken", version: 3)
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        try actions.updateTask(task.id, TaskPatch(priority: .set(.critical)))
        let state = try store.snapshot()
        #expect(state.tasks[task.id]?.priority == .critical)
        #expect(state.tasks[task.id]?.priorityIsManual == true)
        #expect(state.tasks[task.id]?.priorityReason == "Von dir festgelegt")
        #expect(state.pendingTaskIds == [task.id])
        #expect(state.pendingCount == 1)
        let entry = try #require(try store.outbox().first)
        #expect(entry.mutation.baseVersion == 3)
        #expect(entry.context.preimage == ["priority": .null])
        // Der Serverstand selbst bleibt unverändert, bis der Server bestätigt.
        #expect(try store.serverState().tasks[task.id]?.priority == .important)
    }

    @Test("Noch nicht gesendete Änderungen derselben Aufgabe werden zusammengefasst")
    func coalescesUnsentUpdates() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask()
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        try actions.setStatus(.doing, taskId: task.id)
        try actions.setStatus(.done, taskId: task.id)
        try actions.updateTask(task.id, TaskPatch(title: .set("Neuer Titel")))
        let entries = try store.outbox()
        #expect(entries.count == 1)
        guard case .taskUpdate(let patch) = entries[0].mutation.kind else {
            Issue.record("task.update erwartet")
            return
        }
        #expect(patch.status == .done)
        #expect(patch.title == .set("Neuer Titel"))
        // Ausgangswert ist der Stand vor der ersten Änderung.
        #expect(entries[0].context.preimage?["status"] == .string("todo"))
    }

    @Test("Unveränderte Werte erzeugen keine Mutation")
    func noOpIsSkipped() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask()
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        #expect(try actions.setStatus(.todo, taskId: task.id) == false)
        #expect(try store.outbox().isEmpty)
    }

    @Test("„Nicht relevant“ und Rückgängig vor dem Senden heben sich auf")
    func dismissUndoBeforeSending() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask(status: .doing)
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        try actions.dismissTask(task.id)
        #expect(try store.snapshot().tasks[task.id]?.status == .dismissed)
        try actions.restoreTask(task.id)
        #expect(try store.outbox().isEmpty)
        #expect(try store.snapshot().tasks[task.id]?.status == .doing)
    }

    @Test("Rückgängig nach dem Senden zeigt lokal den früheren Status")
    func undoAfterSendingRestoresPreviousStatus() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask(status: .doing)
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        try actions.dismissTask(task.id)
        _ = try store.prepareBatch(now: clock.now)   // Sendeversuch: Eintrag ist jetzt eingefroren
        try actions.restoreTask(task.id)
        let entries = try store.outbox()
        #expect(entries.map(\.mutation.type) == ["task.dismiss", "task.restore"])
        #expect(entries[1].context.restoreStatus == .doing)
        #expect(try store.snapshot().tasks[task.id]?.status == .doing)
    }

    @Test("Notiz anlegen und bearbeiten vor dem Senden: eine Mutation; anlegen und löschen: keine")
    func noteCoalescing() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask()
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        let noteId = try actions.addNote(taskId: task.id, body: "Entwurf")
        try actions.updateNote(noteId, body: "Endgültig")
        let entries = try store.outbox()
        #expect(entries.count == 1)
        #expect(entries.first?.mutation.kind == .noteCreate(taskId: task.id, body: "Endgültig"))
        #expect(try store.snapshot().notes(for: task.id).map(\.body) == ["Endgültig"])
        try actions.deleteNote(noteId)
        #expect(try store.outbox().isEmpty)
        #expect(try store.snapshot().notes(for: task.id).isEmpty)
    }

    @Test("Checkliste: Positionen werden fortlaufend vergeben")
    func checklistPositions() throws {
        let store = try LocalStore.inMemory()
        let task = makeTask()
        try seed(store, tasks: [task])
        let actions = LocalActions(store: store, clock: clock.closure)
        _ = try actions.addChecklistItem(taskId: task.id, title: "PDF laden")
        let second = try actions.addChecklistItem(taskId: task.id, title: "Senden")
        try actions.updateChecklistItem(second, done: true)
        let items = try store.snapshot().checklist(for: task.id)
        #expect(items.map(\.position) == [1, 2])
        #expect(items.map(\.done) == [false, true])
        #expect(try store.outbox().map(\.mutation.type) == ["checklist.create", "checklist.create", "checklist.update"])
    }

    @Test("Eingaben werden vor dem Speichern nach den Vertragsgrenzen geprüft")
    func validation() throws {
        let store = try LocalStore.inMemory()
        let actions = LocalActions(store: store, clock: clock.closure)
        #expect(throws: LocalActionError.invalid("Bitte einen Titel eingeben.")) { try actions.createTask(title: "   ") }
        #expect(throws: LocalActionError.self) { try actions.createTask(title: String(repeating: "x", count: 301)) }
        #expect(throws: LocalActionError.notFound) { try actions.setStatus(.doing, taskId: UUID()) }
        #expect(try store.outbox().isEmpty)
    }

    @Test("Stapel: Reihenfolge, höchstens 100, pro Entität eine Änderung je Stapel")
    func batching() throws {
        let store = try LocalStore.inMemory()
        let actions = LocalActions(store: store, clock: clock.closure)
        let first = try actions.createTask(title: "Erste")
        try actions.setStatus(.doing, taskId: first)    // eigener Eintrag nach task.create
        let second = try actions.createTask(title: "Zweite")
        var batch = try store.prepareBatch(now: clock.now)
        #expect(batch.entries.map(\.mutation.entityId) == [first])
        #expect(try store.outbox().first?.attempts == 1)
        _ = second

        let many = try LocalStore.inMemory()
        let manyActions = LocalActions(store: many, clock: clock.closure)
        for index in 0..<230 { _ = try manyActions.createTask(title: "Aufgabe \(index)") }
        batch = try many.prepareBatch(limit: 100, now: clock.now)
        #expect(batch.entries.count == 100)
        let all = try many.outbox()
        #expect(batch.entries.map(\.seq) == Array(all.prefix(100).map(\.seq)))
        #expect(all.filter { $0.attempts == 1 }.count == 100)
    }

    @Test("Vollabzug ersetzt den Serverstand, die Outbox bleibt")
    func replaceKeepsOutbox() throws {
        let store = try LocalStore.inMemory()
        let old = makeTask("Alt")
        try seed(store, tasks: [old])
        let actions = LocalActions(store: store, clock: clock.closure)
        let created = try actions.createTask(title: "Offline angelegt")
        let fresh = makeTask("Neu")
        try store.apply(changes: [Change(seq: "7", entityId: fresh.id, op: .upsert, version: 1, data: .task(fresh))], nextCursor: "7", replacingAll: true)
        let state = try store.snapshot()
        #expect(state.tasks[old.id] == nil)
        #expect(state.tasks[fresh.id] != nil)
        #expect(state.tasks[created] != nil)
        #expect(try store.outbox().count == 1)
        #expect(try store.syncState().cursor == "7")
    }
}
