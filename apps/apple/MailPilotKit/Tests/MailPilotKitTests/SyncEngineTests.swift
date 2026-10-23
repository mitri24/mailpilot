import Foundation
import Testing
@testable import MailPilotKit

@Suite("Sync-Engine mit Mock-Transport")
struct SyncEngineTests {
    let clock = TestClock(date("2026-10-23T08:00:00Z"))

    // MARK: Abruf

    @Test("Ohne Cursor: vollständiger Stand ersetzt lokale Daten, Cursor wird gespeichert")
    func fullSnapshot() async throws {
        let store = try LocalStore.inMemory()
        try store.apply(changes: [Change(seq: "1", entityId: UUID(), op: .upsert, version: 1, data: .task(makeTask("Veraltet")))],
                        nextCursor: "1", replacingAll: false)
        try store.setCursor(nil)
        let server = FakeSyncServer(now: clock.closure)
        let a = makeTask("A")
        let b = makeTask("B")
        server.seed(a)
        server.seed(b)
        let (engine, _) = signedInEnvironment(store: store, transport: server, clock: clock)
        let report = await engine.sync()
        #expect(report.outcome == .success)
        #expect(Set(try store.snapshot().tasks.values.map(\.title)) == ["A", "B"])
        #expect(try store.syncState().cursor == "102")
        #expect(server.cursors == [nil])
        #expect(try store.syncState().serverPendingAnalysisCount == 7)
    }

    @Test("Delta mit Upserts und Tombstones; hasMore-Paging bis zum Ende")
    func deltaAndTombstones() async throws {
        let store = try LocalStore.inMemory()
        let transport = ScriptedTransport()
        transport.addPage(for: nil, try Fixture.decode(ChangesResponse.self, "changes-snapshot"))
        let (engine, _) = signedInEnvironment(store: store, transport: transport, clock: clock)
        #expect(await engine.sync().outcome == .success)
        var state = try store.snapshot()
        #expect(state.tasks.count == 2)
        #expect(state.notes.count == 2)
        #expect(state.accounts.count == 2)
        #expect(state.settings?.timezone == "Europe/Paris")

        transport.addPage(for: "1042", try Fixture.decode(ChangesResponse.self, "changes-delta"))
        transport.addPage(for: "1049", ChangesResponse(changes: [], nextCursor: "1049", hasMore: false, serverTime: clock.now))
        let report = await engine.sync()
        #expect(report.outcome == .success)
        #expect(report.pages == 2)
        state = try store.snapshot()
        let taskId = UUID(uuidString: "33333333-3333-4333-8333-333333333331")!
        #expect(state.tasks[taskId]?.status == .done)
        #expect(state.tasks[UUID(uuidString: "33333333-3333-4333-8333-333333333332")!] == nil)
        #expect(state.notes.count == 1)
        #expect(state.checklist.count == 1)
        #expect(state.accounts.count == 1)
        #expect(state.sortedRules.first?.value.applies == false)
        #expect(state.openClarifications.isEmpty)
        #expect(transport.state.current.requestedCursors == [nil, "1042", "1049"])
        #expect(try store.syncState().cursor == "1049")
    }

    @Test("Mehrere Seiten: Abruf folgt nextCursor, bis hasMore=false")
    func paging() async throws {
        let store = try LocalStore.inMemory()
        try store.setCursor("10")
        let transport = ScriptedTransport()
        let tasks = (1...5).map { makeTask("Seite \($0)") }
        func page(_ slice: ArraySlice<TaskItem>, next: String, more: Bool) -> ChangesResponse {
            ChangesResponse(changes: slice.map { Change(seq: next, entityId: $0.id, op: .upsert, version: 1, data: .task($0)) },
                            nextCursor: next, hasMore: more, serverTime: Date())
        }
        transport.addPage(for: "10", page(tasks[0..<2], next: "12", more: true))
        transport.addPage(for: "12", page(tasks[2..<4], next: "14", more: true))
        transport.addPage(for: "14", page(tasks[4..<5], next: "15", more: false))
        let (engine, _) = signedInEnvironment(store: store, transport: transport, clock: clock)
        let report = await engine.sync()
        #expect(report.pages == 3)
        #expect(report.pulledChanges == 5)
        #expect(transport.state.current.requestedCursors == ["10", "12", "14"])
        #expect(try store.syncState().cursor == "15")
        #expect(try store.snapshot().tasks.count == 5)
    }

    @Test("resetRequired: Cursor verwerfen, Vollabzug, lokale Daten ersetzen, Outbox bleibt")
    func resetRequired() async throws {
        let store = try LocalStore.inMemory()
        let stale = makeTask("Veraltet")
        try seed(store, tasks: [stale], cursor: "999")
        let actions = LocalActions(store: store, clock: clock.closure)
        let local = try actions.createTask(title: "Offline angelegt")
        let transport = ScriptedTransport()
        // Der Server beantwortet die Mutation nicht (z. B. abgebrochene Antwort): sie bleibt in der Outbox.
        transport.state.withLock { $0.pushResults = [[]] }
        transport.addPage(for: "999", ChangesResponse(changes: [], nextCursor: "0", resetRequired: true, serverTime: Date()))
        let fresh = makeTask("Vom Server")
        transport.addPage(for: nil, ChangesResponse(changes: [Change(seq: "50", entityId: fresh.id, op: .upsert, version: 1, data: .task(fresh))],
                                                    nextCursor: "50", serverTime: Date()))
        let (engine, _) = signedInEnvironment(store: store, transport: transport, clock: clock)
        let report = await engine.sync()
        #expect(report.didReset)
        #expect(transport.state.current.requestedCursors == ["999", nil])
        let state = try store.snapshot()
        #expect(state.tasks[stale.id] == nil)
        #expect(state.tasks[fresh.id]?.title == "Vom Server")
        #expect(state.tasks[local]?.title == "Offline angelegt")
        #expect(try store.outbox().count == 1)
        #expect(try store.syncState().cursor == "50")
    }

    // MARK: Senden und Ergebnisse

    @Test("Statuskonflikt: veraltetes Offlinegerät setzt erledigte Aufgabe nicht still auf To Do")
    func staleOfflineStatusChange() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask("Studienbescheinigung schicken", status: .doing)
        server.seed(task)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        #expect(await engine.sync().outcome == .success)

        // Offline zurück auf To Do; inzwischen erledigt ein anderes Gerät die Aufgabe.
        try actions.setStatus(.todo, taskId: task.id)
        server.otherDeviceUpdates(task.id, TaskPatch(status: .done))
        let report = await engine.sync()

        #expect(report.conflicts == 1)
        #expect(server.task(task.id)?.status == .done)
        let state = try store.snapshot()
        #expect(state.tasks[task.id]?.status == .done)
        #expect(try store.outbox().isEmpty)
        let notice = try #require(state.notices.first)
        #expect(notice.kind == .conflict)
        #expect(notice.fields == ["status"])
        #expect(notice.taskId == task.id)
        #expect(notice.message.contains("Auf einem anderen Gerät geändert"))
    }

    @Test("Gleiche Idempotency-Keys und Bytes bei Wiederholung nach Netzwerkfehlern")
    func retryKeepsKeys() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask()
        server.seed(task)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        _ = await engine.sync()
        try actions.setStatus(.doing, taskId: task.id)
        _ = try actions.addNote(taskId: task.id, body: "Notiz")
        server.state.withLock { $0.failNextPushes = 2 }

        #expect(await engine.sync().outcome == .offline)
        #expect(try store.syncState().lastErrorWasOffline)
        #expect(await engine.sync().outcome == .offline)
        #expect(try store.syncState().consecutiveFailures == 2)
        #expect(await engine.sync().outcome == .success)

        let bodies = server.pushedBodies
        #expect(bodies.count == 3)
        #expect(bodies[0] == bodies[1])
        #expect(bodies[1] == bodies[2])
        #expect(try store.outbox().isEmpty)
        #expect(server.task(task.id)?.status == .doing)
        #expect(server.notes.map(\.body) == ["Notiz"])
        #expect(try store.syncState().consecutiveFailures == 0)
    }

    @Test("applied/duplicate: bestätigt, Anzeige bleibt bis zum Abruf; danach entfernt")
    func acknowledgedUntilPulled() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask()
        server.seed(task)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        _ = await engine.sync()
        try actions.setStatus(.doing, taskId: task.id)
        server.state.withLock { $0.failNextPulls = 1 }

        #expect(await engine.sync().outcome == .offline)
        let entry = try #require(try store.outbox().first)
        #expect(entry.isAcknowledged)
        #expect(try store.snapshot().tasks[task.id]?.status == .doing)
        #expect(try store.snapshot().pendingCount == 0)
        #expect(try store.serverState().tasks[task.id]?.status == .todo)

        #expect(await engine.sync().outcome == .success)
        #expect(try store.outbox().isEmpty)
        #expect(try store.serverState().tasks[task.id]?.status == .doing)
        #expect(server.pushes.count == 1)
    }

    @Test("Zwei Änderungen derselben Aufgabe nacheinander: zweite wird nach dem Abruf auf die neue Version gesetzt")
    func sequentialChangesOnSameTask() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask()
        server.seed(task)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        _ = await engine.sync()
        try actions.setStatus(.doing, taskId: task.id)
        server.state.withLock { $0.failNextPushes = 1 }
        _ = await engine.sync()                         // Versuch gescheitert, Eintrag ist eingefroren
        try actions.setStatus(.done, taskId: task.id)   // eigener Eintrag
        #expect(try store.outbox().count == 2)

        let report = await engine.sync()
        #expect(report.outcome == .success)
        #expect(report.conflicts == 0)
        #expect(server.task(task.id)?.status == .done)
        #expect(try store.snapshot().tasks[task.id]?.status == .done)
        #expect(try store.outbox().isEmpty)
        // Erst die erste Änderung (zweimal wegen des Fehlers), dann die zweite mit neuer Basisversion.
        #expect(server.pushes.map { $0.map(\.type) } == [["task.update"], ["task.update"], ["task.update"]])
        #expect(server.pushes[2].first?.baseVersion == 2)
        #expect(try store.snapshot().notices.isEmpty)
    }

    @Test("Vor dem Senden: vom anderen Gerät geändertes Feld wird nicht überschrieben")
    func revalidationDropsConflictingField() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask("Original")
        server.seed(task)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        _ = await engine.sync()
        try actions.setStatus(.doing, taskId: task.id)
        server.state.withLock { $0.failNextPushes = 1 }
        _ = await engine.sync()
        try actions.updateTask(task.id, TaskPatch(title: .set("Mein Titel")))
        server.otherDeviceUpdates(task.id, TaskPatch(title: .set("Titel vom Mac")))

        let report = await engine.sync()
        #expect(report.dropped == 1)
        #expect(server.task(task.id)?.title == "Titel vom Mac")
        #expect(server.task(task.id)?.status == .doing)
        let state = try store.snapshot()
        #expect(state.tasks[task.id]?.title == "Titel vom Mac")
        #expect(state.notices.first?.fields == ["title"])
        #expect(!server.pushes.flatMap { $0 }.contains { if case .taskUpdate(let p) = $0.kind { return p.title != .unchanged } else { return false } })
    }

    @Test("Gleichzeitig bearbeitete Notiz: beide Fassungen bleiben erhalten")
    func concurrentNoteEdits() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask()
        let note = TaskNote(taskId: task.id, version: 1, body: "Erste Fassung", createdAt: clock.now)
        server.seed(task)
        server.seed(note)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        _ = await engine.sync()
        try actions.updateNote(note.id, body: "Fassung vom iPhone")
        server.otherDeviceEditsNote(note.id, body: "Fassung vom Mac")

        let report = await engine.sync()
        #expect(report.conflicts == 1)
        let bodies = try store.snapshot().notes(for: task.id).map(\.body)
        #expect(Set(bodies) == ["Fassung vom Mac", "Fassung vom iPhone"])
        let copy = try #require(try store.snapshot().notes(for: task.id).first { $0.body == "Fassung vom iPhone" })
        #expect(copy.conflictOfNoteId == note.id)
        #expect(try store.snapshot().notices.first?.message.contains("Beide Fassungen") == true)
    }

    @Test("rejected: entfernt und als Fehler sichtbar")
    func rejectedIsVisible() async throws {
        let store = try LocalStore.inMemory()
        let gone = makeTask("Auf dem Server gelöscht")
        try seed(store, tasks: [gone])
        let server = FakeSyncServer(now: clock.closure)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        try actions.setStatus(.doing, taskId: gone.id)
        let report = await engine.sync()
        #expect(report.rejected == 1)
        #expect(try store.outbox().isEmpty)
        let notice = try #require(try store.snapshot().notices.first)
        #expect(notice.kind == .rejected)
        #expect(notice.message == "Änderung nicht übernommen: Aufgabe nicht gefunden")
    }

    @Test("Offline angelegte Aufgabe mit Notiz kommt beim Server an")
    func offlineCreateWithNote() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        let id = try actions.createTask(title: "Fahrradschloss kaufen", priority: .canWait, note: "Im Laden am Bahnhof")
        #expect(try store.snapshot().tasks[id]?.origin == .manual)
        #expect(await engine.sync().outcome == .success)
        #expect(server.task(id)?.title == "Fahrradschloss kaufen")
        #expect(server.notes.first?.taskId == id)
        #expect(try store.outbox().isEmpty)
        #expect(try store.snapshot().tasks[id]?.version == 1)
    }

    @Test("Mehr als 100 Änderungen werden in Stapeln zu höchstens 100 gesendet")
    func batchesOfHundred() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        for index in 0..<230 { _ = try actions.createTask(title: "Aufgabe \(index)") }
        let report = await engine.sync()
        #expect(report.outcome == .success)
        #expect(server.pushes.map(\.count) == [100, 100, 30])
        #expect(try store.outbox().isEmpty)
        #expect(try store.snapshot().tasks.count == 230)
    }

    @Test("Ungültiger Stapel (HTTP 400): einzeln wiederholt, nur die fehlerhafte Änderung wird abgelehnt")
    func badRequestIsolated() async throws {
        let store = try LocalStore.inMemory()
        let transport = ScriptedTransport()
        let (engine, actions) = signedInEnvironment(store: store, transport: transport, clock: clock)
        _ = try actions.createTask(title: "Eins")
        _ = try actions.createTask(title: "Zwei")
        transport.state.withLock { $0.pushErrors = [.http(status: 400, body: nil), nil, .http(status: 400, body: nil)] }
        let report = await engine.sync()
        #expect(report.outcome == .success)
        #expect(report.rejected == 1)
        #expect(try store.snapshot().notices.count == 1)
    }

    @Test("Nicht angemeldet: kein Netzwerkzugriff")
    func signedOut() async throws {
        let store = try LocalStore.inMemory()
        let transport = ScriptedTransport()
        let engine = SyncEngine(store: store, transport: transport, isSignedIn: { false })
        #expect(await engine.sync().outcome == .signedOut)
        #expect(transport.state.current.requestedCursors.isEmpty)
    }

    @Test("Backoff: exponentiell, gedeckelt, gestreut")
    func backoff() {
        let backoff = Backoff(baseSeconds: 2, maximumSeconds: 300, jitter: 0.2)
        #expect(backoff.delay(forAttempt: 1, random: 0.5) == .seconds(2))
        #expect(backoff.delay(forAttempt: 2, random: 0.5) == .seconds(4))
        #expect(backoff.delay(forAttempt: 4, random: 0.5) == .seconds(16))
        #expect(backoff.delay(forAttempt: 30, random: 0.5) == .seconds(300))
        #expect(backoff.delay(forAttempt: 1, random: 0) == .milliseconds(1600))
        #expect(backoff.delay(forAttempt: 1, random: 1) == .milliseconds(2400))
    }

    @Test("Scheduler wiederholt nach einem Netzwerkfehler automatisch")
    func schedulerRetries() async throws {
        let store = try LocalStore.inMemory()
        let server = FakeSyncServer(now: clock.closure)
        let task = makeTask()
        server.seed(task)
        try seed(store, tasks: [task], cursor: "101")
        let (engine, actions) = signedInEnvironment(store: store, transport: server, clock: clock)
        let scheduler = SyncScheduler(engine: engine, backoff: Backoff(baseSeconds: 0.01, maximumSeconds: 0.01, jitter: 0), sleep: { _ in await Task.yield() })
        try actions.setStatus(.doing, taskId: task.id)
        server.state.withLock { $0.failNextPushes = 1 }
        #expect(await scheduler.syncNow().outcome == .offline)
        for _ in 0..<300 {
            let pending = try !store.outbox().isEmpty
            let failures = await scheduler.consecutiveFailures
            if !pending && failures == 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try store.outbox().isEmpty)
        #expect(server.task(task.id)?.status == .doing)
        #expect(await scheduler.consecutiveFailures == 0)
    }
}
