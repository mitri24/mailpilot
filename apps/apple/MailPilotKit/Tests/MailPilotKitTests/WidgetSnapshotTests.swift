import Foundation
import Testing
@testable import MailPilotKit

@Suite("Widget-Snapshot")
struct WidgetSnapshotTests {
    let now = date("2026-10-23T08:00:00Z")

    func snapshot(lastSync: Date?, offline: Bool = false, pending: Int = 0, failed: Int = 0, tasks: [WidgetTaskItem] = [],
                  pendingAnalysis: Int = 0, clarifications: Int = 0) -> WidgetSnapshot {
        WidgetSnapshot(generatedAt: now, signedIn: true, lastSuccessfulSyncAt: lastSync, lastSyncFailedOffline: offline, timeZoneIdentifier: "Europe/Paris",
                       next: tasks, moreUrgent: [], additional: [], openTaskCount: tasks.count, openClarifications: clarifications,
                       pendingChangeCount: pending, failedChangeCount: failed, pendingAnalysisCount: pendingAnalysis)
    }

    let item = WidgetTaskItem(id: UUID(), title: "Studienbescheinigung schicken", status: .todo, priority: .critical, deadline: nil,
                              hasPendingChanges: false, hasConflict: false)

    @Test("Veraltete Daten: Alter sichtbar, ab sechs Stunden als veraltet markiert")
    func stale() {
        let fresh = WidgetPresentation(snapshot: snapshot(lastSync: now.addingTimeInterval(-600), tasks: [item]), now: now)
        #expect(!fresh.isStale)
        #expect(fresh.ageText == "Stand: vor 10 Min.")
        let old = WidgetPresentation(snapshot: snapshot(lastSync: now.addingTimeInterval(-7 * 3600), tasks: [item]), now: now)
        #expect(old.isStale)
        #expect(old.ageText == "Stand: vor 7 Std.")
        let never = WidgetPresentation(snapshot: snapshot(lastSync: nil), now: now)
        #expect(never.isStale)
        #expect(never.ageText == "Noch nicht synchronisiert")
    }

    @Test("Offline und ausstehende Aktionen werden gekennzeichnet")
    func offlineAndPending() {
        let presentation = WidgetPresentation(snapshot: snapshot(lastSync: now, offline: true, pending: 2, failed: 1, tasks: [item]), now: now)
        #expect(presentation.showsOffline)
        #expect(presentation.pendingText == "2 Änderungen noch nicht synchronisiert")
        #expect(presentation.failedText == "1 Änderung nicht übernommen – in der App ansehen")
    }

    @Test("Abgemeldet: keine Aufgaben, Hinweis zur Anmeldung")
    func signedOut() throws {
        let store = try LocalStore.inMemory()
        try seed(store, tasks: [makeTask("Geheim")])
        let built = WidgetSnapshotBuilder.build(from: try store.snapshot(), signedIn: false, now: now)
        #expect(!built.signedIn)
        #expect(built.allTasks.isEmpty)
        let presentation = WidgetPresentation(snapshot: built, now: now)
        #expect(!presentation.isSignedIn)
        #expect(presentation.emptyText == "Nicht angemeldet. Bitte in MailPilot anmelden.")
        #expect(WidgetPresentation(snapshot: nil, now: now).emptyText?.contains("Noch keine Daten") == true)
    }

    @Test("Nie „nichts offen“, solange Mails ungeprüft sind")
    func pendingAnalysis() {
        let waiting = WidgetPresentation(snapshot: snapshot(lastSync: now, pendingAnalysis: 3), now: now)
        #expect(waiting.emptyText == "3 Mails noch ungeprüft")
        let empty = WidgetPresentation(snapshot: snapshot(lastSync: now), now: now)
        #expect(empty.emptyText == "Für jetzt ist nichts offen.")
        let clarifications = WidgetPresentation(snapshot: snapshot(lastSync: now, clarifications: 2), now: now)
        #expect(clarifications.clarificationText == "2 offene Rückfragen")
    }

    @Test("Widget-Aktion „Erledigt“: Outbox, Snapshot sofort aktuell, Kennzeichnung ausstehend")
    func widgetActionUpdatesSnapshot() throws {
        let store = try LocalStore.inMemory()
        let first = makeTask("Erste", priority: .critical, createdAt: date("2026-10-01T08:00:00Z"))
        let second = makeTask("Zweite", priority: .critical, createdAt: date("2026-10-01T08:00:01Z"))
        try seed(store, tasks: [first, second])
        let reloads = Locked(0)
        let tokens = InMemoryTokenStore(StoredSession(token: "t", expiresAt: now.addingTimeInterval(86_400),
                                                      user: UserProfile(id: UUID(), displayName: nil, email: nil, devLogin: true, createdAt: now)))
        let environment = AppEnvironment(configuration: AppConfiguration(apiBaseURL: URL(string: "https://example.invalid")!), store: store,
                                         tokenStore: tokens, api: APIClient(baseURL: URL(string: "https://example.invalid")!, tokenStore: tokens),
                                         transport: ScriptedTransport(), reloadWidgets: { reloads.withLock { $0 += 1 } }, clock: { [now] in now })
        environment.refreshWidgetSnapshot()
        #expect(try store.widgetSnapshot()?.next.map(\.title) == ["Erste", "Zweite"])

        try environment.actions(origin: .widget).setStatus(.doing, taskId: second.id)
        environment.refreshWidgetSnapshot()
        var built = try #require(try store.widgetSnapshot())
        #expect(built.next.first { $0.id == second.id }?.status == .doing)
        #expect(built.next.first { $0.id == second.id }?.hasPendingChanges == true)
        #expect(built.pendingChangeCount == 1)

        try environment.actions(origin: .widget).setStatus(.done, taskId: first.id)
        environment.refreshWidgetSnapshot()
        built = try #require(try store.widgetSnapshot())
        #expect(built.next.map(\.title) == ["Zweite"])
        #expect(built.openTaskCount == 1)
        #expect(try store.outbox().map(\.origin) == [.widget, .widget])
        #expect(reloads.current == 3)
    }
}

@Suite("Planung und Board")
struct PlanningTests {
    let now = date("2026-10-23T08:00:00Z")

    @Test("„Auf morgen verschieben“ ändert nie die Frist; Hinweis, wenn morgen nach der Frist liegt")
    func postponeToTomorrow() {
        let dueToday = makeTask(deadline: .onDate(day("2026-10-23")))
        let plan = Planning.postponeToTomorrow(dueToday, now: now, timeZone: paris)
        #expect(plan.plannedFor == day("2026-10-24"))
        #expect(plan.patch == TaskPatch(plannedFor: .set(day("2026-10-24"))))
        #expect(plan.hint == "Morgen liegt nach der Frist (heute). Die Frist bleibt unverändert.")
        let applied = TaskEffects.apply(plan.patch, to: dueToday, now: now)
        #expect(applied.deadline == dueToday.deadline)
        #expect(applied.plannedFor == day("2026-10-24"))

        let dueTomorrow = makeTask(deadline: .onDate(day("2026-10-24")))
        #expect(Planning.postponeToTomorrow(dueTomorrow, now: now, timeZone: paris).hint == nil)

        let suggested = makeTask(deadline: .onDate(day("2026-10-20"), kind: .suggested))
        #expect(Planning.postponeToTomorrow(suggested, now: now, timeZone: paris).hint == nil)

        let withTime = makeTask(deadline: .at(date("2026-10-23T14:00:00Z")))
        #expect(Planning.postponeToTomorrow(withTime, now: now, timeZone: paris).hint == "Morgen liegt nach der Frist (heute, 16:00). Die Frist bleibt unverändert.")
    }

    @Test("Später anzeigen: Vorschläge in der Zukunft, Montag nur wenn nicht morgen")
    func snoozeOptions() {
        let friday = Planning.snoozeOptions(now: now, timeZone: paris)
        #expect(friday.map(\.label) == ["Heute, 18:00", "Morgen, 8:00", "Montag, 8:00", "In einer Woche"])
        #expect(friday.allSatisfy { $0.until > now })
        #expect(friday[1].until == date("2026-10-24T06:00:00Z"))
        #expect(friday[2].until == date("2026-10-26T07:00:00Z"))
        let sundayEvening = Planning.snoozeOptions(now: date("2026-10-25T19:00:00Z"), timeZone: paris)
        #expect(sundayEvening.map(\.label) == ["Morgen, 8:00", "In einer Woche"])
    }

    @Test("Manuelle Reihenfolge: nur nötige Schlüssel, Position stimmt danach")
    func sortKeys() {
        let a = makeTask("A")
        let b = makeTask("B")
        let c = makeTask("C")
        func apply(_ items: [TaskItem], _ changes: [UUID: Double]) -> [String] {
            var keyed: [(key: Double, offset: Int, title: String)] = []
            for (offset, item) in items.enumerated() {
                let key: Double = changes[item.id] ?? item.sortKey ?? .infinity
                keyed.append((key: key, offset: offset, title: item.title))
            }
            keyed.sort { lhs, rhs in lhs.key != rhs.key ? lhs.key < rhs.key : lhs.offset < rhs.offset }
            return keyed.map(\.title)
        }
        var list = [a, b, c]
        var changes = SortKeys.reorder(list, moving: c.id, to: 0)
        #expect(changes.count == 1)
        #expect(apply(list, changes) == ["C", "A", "B"])

        changes = SortKeys.reorder(list, moving: c.id, to: 1)
        #expect(apply(list, changes) == ["A", "C", "B"])
        #expect(changes.keys.contains(a.id))

        var keyedA = a; keyedA.sortKey = 1
        var keyedB = b; keyedB.sortKey = 2
        list = [keyedA, keyedB, c]
        changes = SortKeys.reorder(list, moving: c.id, to: 1)
        #expect(changes == [c.id: 1.5])
        #expect(apply(list, changes) == ["A", "C", "B"])

        var tieB = b; tieB.sortKey = 1
        list = [keyedA, tieB, c]
        changes = SortKeys.reorder(list, moving: c.id, to: 1)
        #expect(apply(list, changes) == ["A", "C", "B"])
    }

    @Test("Board: Filter für Konto, Priorität, Frist, Warten, Suche; Erledigt getrennt")
    func boardFilter() {
        let account = UUID()
        var mail = makeTask("Attestation de scolarité schicken", priority: .critical, deadline: .onDate(day("2026-10-22")))
        mail.accountIds = [account]
        var waiting = makeTask("Antwort von Claire", priority: .important)
        waiting.waiting = true
        var snoozed = makeTask("Später", priority: .canWait)
        snoozed.snoozedUntil = now.addingTimeInterval(3600)
        let done = makeTask("Erledigt", status: .done)
        let dueWeek = makeTask("Nächste Woche", deadline: .onDate(day("2026-10-29")))
        let tasks = [mail, waiting, snoozed, done, dueWeek]

        var filter = BoardFilter()
        let columns = BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris)
        #expect(columns.todo.count == 3)
        #expect(columns.done.map(\.title) == ["Erledigt"])
        #expect(columns.snoozedHidden == 1)

        filter.showSnoozed = true
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.count == 4)

        filter = BoardFilter(accountId: account)
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.map(\.title) == ["Attestation de scolarité schicken"])
        filter = BoardFilter(due: .overdue)
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.count == 1)
        filter = BoardFilter(due: .week)
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.count == 2)
        filter = BoardFilter(due: .none)
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.map(\.title) == ["Antwort von Claire"])
        filter = BoardFilter(waitingOnly: true)
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.map(\.title) == ["Antwort von Claire"])
        filter = BoardFilter(priority: .critical)
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.count == 1)
        filter = BoardFilter(search: "SCOLARITE")
        #expect(BoardColumns.build(from: tasks, filter: filter, now: now, timeZone: paris).todo.count == 1)
    }
}

@Suite("Deep Links")
struct DeepLinkTests {
    let id = UUID(uuidString: "33333333-3333-4333-8333-333333333331")!

    @Test("Parsen", arguments: [
        ("mailpilot://today", DeepLink.today),
        ("MAILPILOT://today", DeepLink.today),
        ("mailpilot://board", DeepLink.board),
        ("mailpilot://tasks/33333333-3333-4333-8333-333333333331", DeepLink.task(UUID(uuidString: "33333333-3333-4333-8333-333333333331")!)),
        ("mailpilot://tasks/33333333-3333-4333-8333-333333333331/", DeepLink.task(UUID(uuidString: "33333333-3333-4333-8333-333333333331")!)),
        ("mailpilot://clarifications", DeepLink.clarifications),
        ("mailpilot://messages", DeepLink.messages),
        ("mailpilot://accounts", DeepLink.accounts),
        ("mailpilot://accounts/connected?accountId=11111111-1111-4111-8111-111111111111", DeepLink.accountConnected(accountId: UUID(uuidString: "11111111-1111-4111-8111-111111111111"))),
        ("mailpilot://accounts/error?code=state_invalid", DeepLink.accountError(code: "state_invalid")),
        ("mailpilot://accounts/error", DeepLink.accountError(code: "unknown")),
        ("mailpilot://accounts/11111111-1111-4111-8111-111111111111", DeepLink.account(UUID(uuidString: "11111111-1111-4111-8111-111111111111")!)),
    ])
    func parse(url: String, expected: DeepLink) throws {
        #expect(DeepLink(url: try #require(URL(string: url))) == expected)
    }

    @Test("Ungültige Links", arguments: ["https://today", "mailpilot://tasks/keine-uuid", "mailpilot://unbekannt", "mailto:a@example.com"])
    func invalid(url: String) throws {
        #expect(DeepLink(url: try #require(URL(string: url))) == nil)
    }

    @Test("Hin und zurück")
    func roundTrip() {
        let links: [DeepLink] = [.today, .board, .task(id), .clarifications, .messages, .accounts, .account(id), .accountConnected(accountId: id), .accountError(code: "access_denied"), .settings]
        for link in links {
            #expect(DeepLink(url: link.url) == link)
        }
        #expect(DeepLink.task(id).url.absoluteString == "mailpilot://tasks/33333333-3333-4333-8333-333333333331")
        #expect(DeepLink.accountErrorMessage("state_invalid").contains("abgelaufen"))
    }
}

@Suite("Wirksame Werte wie dto.ts / mutations.ts")
struct TaskEffectsTests {
    let now = date("2026-10-23T08:00:00Z")

    @Test("Manuelle Priorität gewinnt; null kehrt zur KI zurück")
    func priority() {
        let task = makeTask(priority: .canWait)
        let manual = TaskEffects.apply(TaskPatch(priority: .set(.critical)), to: task, now: now)
        #expect(manual.priority == .critical)
        #expect(manual.priorityIsManual)
        #expect(manual.priorityReason == "Von dir festgelegt")
        let back = TaskEffects.apply(TaskPatch(priority: .clear), to: manual, now: now)
        #expect(back.priority == .canWait)
        #expect(!back.priorityIsManual)
    }

    @Test("Frist: manuell, „keine Frist“, zurück zum Vorschlag")
    func deadline() {
        let ai = Deadline.onDate(day("2026-10-30"), kind: .uncertain, quote: "avant vendredi")
        let task = makeTask(deadline: ai)
        let manual = TaskEffects.apply(TaskPatch(deadline: .set(.onDate(day("2026-11-02")))), to: task, now: now)
        #expect(manual.deadline == Deadline.onDate(day("2026-11-02"), kind: .explicit))
        #expect(manual.deadlineIsManual)
        #expect(manual.ai.deadline == ai)
        let cleared = TaskEffects.apply(TaskPatch(deadlineCleared: true), to: manual, now: now)
        #expect(cleared.deadline == nil)
        #expect(cleared.deadlineIsManual)
        let back = TaskEffects.apply(TaskPatch(deadline: .clear), to: cleared, now: now)
        #expect(back.deadline == ai)
        #expect(!back.deadlineIsManual)
    }

    @Test("Titel, Status-Zeitpunkte, Zeitaufwand mit Herkunft")
    func otherFields() {
        var task = makeTask("KI-Titel")
        task = TaskEffects.apply(TaskPatch(title: .set("Mein Titel")), to: task, now: now)
        #expect(task.title == "Mein Titel")
        task = TaskEffects.apply(TaskPatch(title: .clear), to: task, now: now)
        #expect(task.title == "KI-Titel")
        task = TaskEffects.apply(TaskPatch(status: .done), to: task, now: now)
        #expect(task.doneAt == now)
        task = TaskEffects.apply(TaskPatch(status: .todo), to: task, now: now)
        #expect(task.doneAt == nil)
        task = TaskEffects.apply(TaskPatch(estimatedMinutes: .set(20)), to: task, now: now)
        #expect(task.estimateSource == .user)
        task = TaskEffects.apply(TaskPatch(estimatedMinutes: .clear), to: task, now: now)
        #expect(task.estimateSource == nil)
        var untitled = makeTask()
        untitled.ai.title = nil
        TaskEffects.recomputeEffective(&untitled)
        #expect(untitled.title == "Aufgabe ohne Titel")
    }

    @Test("Rückfrage: „Diesmal nicht“ bleibt einmalig, „später“ bleibt offen")
    func clarificationAnswers() {
        let clarification = Clarification(kind: .membership, question: "Gehörst du zu B2?", reason: "Nur die Gruppe ist betroffen.", options: [
            ClarificationOption(id: "yes", label: "Ja", scope: .permanent),
            ClarificationOption(id: "not_this_time", label: "Diesmal nicht", scope: .once),
            ClarificationOption(id: "later", label: "Weiß ich noch nicht", scope: .once),
        ], createdAt: now)
        let permanent = TaskEffects.answered(clarification, optionId: "yes", text: nil, scope: .permanent, at: now)
        #expect(permanent.status == .answered)
        #expect(permanent.answer?.scope == .permanent)
        let once = TaskEffects.answered(clarification, optionId: "not_this_time", text: nil, scope: .permanent, at: now)
        #expect(once.answer?.scope == .once)
        let later = TaskEffects.answered(clarification, optionId: "later", text: nil, scope: .once, at: now)
        #expect(later.status == .open)
    }
}
