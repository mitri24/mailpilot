import Foundation
import MailPilotKit
import Observation

/// Kurzer Hinweis am unteren Rand, optional mit „Rückgängig“.
public struct Banner: Identifiable, Equatable, Sendable {
    public enum Kind: Sendable { case info, error }
    public enum Undo: Equatable, Sendable {
        case restoreTask(UUID)
        case undoMerge(UUID)
    }

    public let id = UUID()
    public var kind: Kind
    public var message: String
    public var undo: Undo?

    public init(kind: Kind = .info, message: String, undo: Undo? = nil) {
        self.kind = kind
        self.message = message
        self.undo = undo
    }
}

public enum AppSection: String, Hashable, CaseIterable, Identifiable, Sendable {
    case today, board, clarifications, messages, accounts, settings
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .today: return "Heute"
        case .board: return "Board"
        case .clarifications: return "Rückfragen"
        case .messages: return "Mails"
        case .accounts: return "Konten"
        case .settings: return "Einstellungen"
        }
    }

    public var systemImage: String {
        switch self {
        case .today: return "sun.max"
        case .board: return "rectangle.split.3x1"
        case .clarifications: return "questionmark.bubble"
        case .messages: return "envelope"
        case .accounts: return "person.crop.circle"
        case .settings: return "gearshape"
        }
    }
}

/// Zustand und Aktionen der App. Lokale Änderungen gehen über die Outbox (offline-fähig),
/// Kontoverwaltung, Mails und Korrekturen brauchen den Server.
@MainActor
@Observable
public final class AppModel {
    public enum Phase: Equatable, Sendable { case launching, signedOut, onboarding, ready, unavailable }

    public let environment: AppEnvironment?
    public let developerMode: Bool
    public let pushEnvironment: PushRegistration.Environment
    public private(set) var phase: Phase = .launching
    public private(set) var state: LocalSnapshot = .empty
    public private(set) var now = Date()
    public private(set) var isSyncing = false
    public private(set) var lastReport: SyncReport?
    public private(set) var setupError: String?
    public private(set) var usage: Usage?

    public var section: AppSection = .today
    public var selectedTaskId: UUID?
    /// Ziel eines Deep Links, das die Plattformansicht öffnet.
    public var deepLinkTaskId: UUID?
    public var banner: Banner?
    public var boardFilter = BoardFilter()
    /// „Neue Aufgabe“ (Symbolleiste, ⌘N).
    public var isComposingTask = false
    public var lastAccountConnection: DeepLink?
    /// Von der App gesetzt (UIApplication/NSApplication registerForRemoteNotifications).
    public var registerForRemoteNotifications: (@MainActor () -> Void)?

    private static let onboardingKey = "onboarding.completed"

    public init(environment: AppEnvironment?, developerMode: Bool, pushEnvironment: PushRegistration.Environment, setupError: String? = nil) {
        self.environment = environment
        self.developerMode = developerMode
        self.pushEnvironment = pushEnvironment
        self.setupError = setupError
    }

    /// Echte Umgebung; bei Fehlern (z. B. Datenbank) zeigt die App eine verständliche Meldung statt abzustürzen.
    public static func live(developerMode: Bool, pushEnvironment: PushRegistration.Environment) -> AppModel {
        do {
            return AppModel(environment: try AppEnvironment.live(allowDebugOverride: developerMode), developerMode: developerMode, pushEnvironment: pushEnvironment)
        } catch {
            return AppModel(environment: nil, developerMode: developerMode, pushEnvironment: pushEnvironment,
                            setupError: "Der lokale Speicher konnte nicht geöffnet werden: \(error.localizedDescription)")
        }
    }

    // MARK: Ablauf

    public var onboardingCompleted: Bool {
        get { defaults?.bool(forKey: Self.onboardingKey) ?? false }
        set { defaults?.set(newValue, forKey: Self.onboardingKey) }
    }

    private var defaults: UserDefaults? { AppConfiguration.sharedDefaults(appGroup: environment?.configuration.appGroupIdentifier) }

    public var session: StoredSession? { environment?.session }
    public var timeZone: TimeZone { state.timeZone }

    public func start() async {
        guard let environment else {
            phase = .unavailable
            return
        }
        await environment.scheduler.setReportHandler { [weak self] report in
            await self?.didFinishSync(report)
        }
        reload()
        guard environment.isSignedIn else {
            phase = .signedOut
            return
        }
        // Leerer lokaler Stand (Neuinstallation, zweites Gerät): erst abrufen, dann über das Onboarding entscheiden.
        let needsServerState = state.accounts.isEmpty && !onboardingCompleted
        if needsServerState {
            await syncNow()
            await refreshAccounts()
        }
        decidePhase()
        if !needsServerState { await syncNow() }
    }

    /// Phase nur an festen Stellen wechseln (Start, Anmeldung, Onboarding-Ende, Abmelden),
    /// damit eine Synchronisierung das laufende Onboarding nicht abbricht.
    private func decidePhase() {
        guard let environment else {
            phase = .unavailable
            return
        }
        guard environment.isSignedIn else {
            phase = .signedOut
            return
        }
        phase = state.accounts.isEmpty && !onboardingCompleted ? .onboarding : .ready
    }

    public func finishOnboarding() {
        onboardingCompleted = true
        decidePhase()
    }

    public func reload() {
        now = Date()
        guard let environment, let snapshot = try? environment.store.snapshot() else { return }
        state = snapshot
    }

    public func becameActive() async {
        environment?.resumeDatabase()
        reload()
        if environment?.isSignedIn == true { await syncNow() }
    }

    public func movedToBackground() {
        environment?.refreshWidgetSnapshot()
        environment?.suspendDatabase()
    }

    public func syncNow() async {
        guard let environment else { return }
        isSyncing = true
        _ = await environment.scheduler.syncNow()
        isSyncing = false
    }

    private func didFinishSync(_ report: SyncReport) {
        lastReport = report
        reload()
        if report.outcome == .signedOut, environment?.isSignedIn == true {
            sessionExpired()
        }
    }

    /// Token ungültig: neu anmelden. Lokale Daten und Outbox bleiben für denselben Benutzer erhalten.
    private func sessionExpired() {
        try? environment?.tokenStore.clear()
        environment?.refreshWidgetSnapshot()
        banner = Banner(kind: .error, message: "Die Anmeldung ist abgelaufen. Bitte erneut anmelden; nicht übertragene Änderungen bleiben erhalten.")
        phase = .signedOut
    }

    /// Deep Links aus Widget, Mitteilungen und der OAuth-Weiterleitung.
    public func open(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        switch link {
        case .today: section = .today
        case .board: section = .board
        case .task(let id):
            section = .today
            deepLinkTaskId = id
        case .clarifications: section = .clarifications
        case .messages: section = .messages
        case .settings: section = .settings
        case .accounts: section = .accounts
        case .account:
            section = .accounts
            lastAccountConnection = link
        case .accountConnected, .accountError:
            section = .accounts
            Task { await handleAccountCallback(link) }
        }
    }

    // MARK: Abgeleitete Werte

    public var today: Today { state.today(now: now) }
    public var board: BoardColumns { state.board(filter: boardFilter, now: now) }

    public func task(_ id: UUID) -> TaskItem? { state.tasks[id] }
    public func isPending(_ id: UUID) -> Bool { state.pendingTaskIds.contains(id) }
    public func notices(for id: UUID) -> [SyncNotice] { state.notices(forTask: id) }

    public var isOffline: Bool {
        if case .offline? = lastReport?.outcome { return true }
        return lastReport == nil && state.syncState.lastErrorWasOffline
    }

    // MARK: Lokale Änderungen (Outbox)

    private func perform(_ body: (LocalActions) throws -> Void) {
        guard let environment else { return }
        do {
            try body(environment.actions(origin: .app))
            afterLocalChange()
        } catch {
            banner = Banner(kind: .error, message: (error as? LocalizedError)?.errorDescription ?? "Änderung nicht möglich.")
        }
    }

    private func afterLocalChange() {
        reload()
        environment?.refreshWidgetSnapshot()
        if let scheduler = environment?.scheduler {
            Task { await scheduler.scheduleSync() }
        }
    }

    public func setStatus(_ status: TaskStatus, for id: UUID) {
        perform { try $0.setStatus(status, taskId: id) }
    }

    public func update(_ id: UUID, _ patch: TaskPatch) {
        perform { try $0.updateTask(id, patch) }
    }

    public func setWaiting(_ waiting: Bool, checkAt: LocalDate?, for id: UUID) {
        update(id, TaskPatch(waiting: waiting, waitingCheckAt: waiting ? FieldUpdate(checkAt) : .clear))
    }

    public func snooze(_ id: UUID, until: Date?) {
        update(id, TaskPatch(snoozedUntil: FieldUpdate(until)))
    }

    public func postponeToTomorrow(_ id: UUID) {
        guard let task = task(id) else { return }
        let plan = Planning.postponeToTomorrow(task, now: Date(), timeZone: timeZone)
        update(id, plan.patch)
        banner = Banner(message: plan.hint ?? "Für morgen eingeplant.")
    }

    public func planForToday(_ id: UUID) {
        update(id, Planning.planForToday(now: Date(), timeZone: timeZone))
    }

    public func dismiss(_ id: UUID) {
        perform { try $0.dismissTask(id) }
        banner = Banner(message: "Als nicht relevant markiert.", undo: .restoreTask(id))
    }

    public func restore(_ id: UUID) {
        perform { try $0.restoreTask(id) }
    }

    /// Kanban: in eine Spalte verschieben und dort einordnen.
    public func move(_ id: UUID, to status: TaskStatus, at index: Int? = nil) {
        perform { actions in
            if task(id)?.status != status { try actions.setStatus(status, taskId: id) }
            if let index, status != .done {
                var column = board[status].filter { $0.id != id }
                if let moved = task(id) { column.insert(moved, at: min(index, column.count)) }
                try actions.setSortKeys(SortKeys.reorder(column, moving: id, to: min(index, column.count - 1)))
            }
        }
    }

    public func reorder(_ id: UUID, in column: [TaskItem], to index: Int) {
        perform { try $0.setSortKeys(SortKeys.reorder(column, moving: id, to: index)) }
    }

    @discardableResult
    public func createTask(title: String, nextStep: String?, priority: Priority?, deadline: ManualDeadline?, note: String?) -> UUID? {
        var created: UUID?
        perform { created = try $0.createTask(title: title, nextStep: nextStep, priority: priority, deadline: deadline, note: note) }
        return created
    }

    public func addNote(_ taskId: UUID, body: String) { perform { _ = try $0.addNote(taskId: taskId, body: body) } }
    public func updateNote(_ id: UUID, body: String) { perform { try $0.updateNote(id, body: body) } }
    public func deleteNote(_ id: UUID) { perform { try $0.deleteNote(id) } }
    public func addChecklistItem(_ taskId: UUID, title: String) { perform { _ = try $0.addChecklistItem(taskId: taskId, title: title) } }
    public func setChecklistItem(_ id: UUID, done: Bool) { perform { try $0.updateChecklistItem(id, done: done) } }
    public func renameChecklistItem(_ id: UUID, title: String) { perform { try $0.updateChecklistItem(id, title: title) } }
    public func deleteChecklistItem(_ id: UUID) { perform { try $0.deleteChecklistItem(id) } }

    public func answer(_ clarificationId: UUID, optionId: String?, text: String?, permanent: Bool) {
        perform { try $0.answerClarification(clarificationId, optionId: optionId, text: text, scope: permanent ? .permanent : .once) }
    }

    public func dismissNotice(_ id: UUID) {
        try? environment?.store.dismissNotice(id)
        afterLocalChange()
    }

    public func dismissNotices(forTask id: UUID) {
        try? environment?.store.dismissNotices(forTask: id)
        afterLocalChange()
    }

    public func performUndo(_ undo: Banner.Undo) async {
        banner = nil
        switch undo {
        case .restoreTask(let id): restore(id)
        case .undoMerge(let mergeId):
            if let task = await call(API.undoMerge(mergeId)) {
                try? environment?.store.store(task: task)
                await syncNow()
            }
        }
    }

    // MARK: Server-Aufrufe

    /// Führt einen Aufruf aus und zeigt Fehler als Hinweis. Ungültige Sitzung → neu anmelden.
    public func call<T>(_ endpoint: Endpoint<T>, quiet: Bool = false) async -> T? {
        guard let environment else { return nil }
        do {
            return try await environment.api.send(endpoint)
        } catch let error as APIError {
            if error.isUnauthorized, environment.isSignedIn { sessionExpired() }
            if !quiet { banner = Banner(kind: .error, message: error.message) }
            return nil
        } catch is CancellationError {
            return nil
        } catch {
            if !quiet { banner = Banner(kind: .error, message: "Fehler: \(error.localizedDescription)") }
            return nil
        }
    }

    /// Detail mit Quellen und Verlauf; zuerst aus dem Cache, dann vom Server.
    public func cachedDetail(_ taskId: UUID) -> (detail: TaskDetail, fetchedAt: Date)? {
        try? environment?.store.cachedDetail(taskId: taskId)
    }

    public func loadDetail(_ taskId: UUID) async -> TaskDetail? {
        guard let detail = await call(API.taskDetail(taskId), quiet: true) else { return nil }
        try? environment?.store.saveDetail(detail, at: Date())
        reload()
        return detail
    }

    public func correct(_ taskId: UUID, _ correction: Correction) async {
        guard let result = await call(API.correctTask(taskId, correction, idempotencyKey: UUID())) else { return }
        try? environment?.store.store(task: result.task)
        if let mergeId = result.mergeId {
            banner = Banner(message: "Mit bestehender Aufgabe zusammengeführt.", undo: .undoMerge(mergeId))
        } else {
            banner = Banner(message: "Korrektur gespeichert.")
        }
        await syncNow()
    }

    public func merge(_ taskId: UUID, into target: UUID) async {
        guard let result = await call(API.mergeTask(taskId, into: target, idempotencyKey: UUID())) else { return }
        try? environment?.store.store(task: result.task)
        banner = Banner(message: "Zusammengeführt. Quellen, Notizen und Verlauf bleiben erhalten.", undo: .undoMerge(result.mergeId))
        await syncNow()
    }

    public func unlinkSource(_ taskId: UUID, messageId: UUID) async {
        if let task = await call(API.unlinkSource(taskId, messageId: messageId)) {
            try? environment?.store.store(task: task)
            _ = await loadDetail(taskId)
        }
    }

    public func messages(_ query: MessageQuery) async -> [MessageSummary]? {
        await call(API.messages(query))?.messages
    }

    public func message(_ id: UUID) async -> MessageDetail? {
        await call(API.message(id))
    }

    /// „Als Aufgabe aufnehmen“ oder mit bestehender Aufgabe verknüpfen.
    public func takeOver(message id: UUID, title: String?, linkTo taskId: UUID?, idempotencyKey: UUID) async -> TaskItem? {
        let body = MessageToTask(title: title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty, linkToTaskId: taskId)
        guard let task = await call(API.messageToTask(id, body, idempotencyKey: idempotencyKey)) else { return nil }
        try? environment?.store.store(task: task)
        reload()
        banner = Banner(message: taskId == nil ? "Als Aufgabe aufgenommen." : "Mit der Aufgabe verknüpft.")
        Task { await syncNow() }
        return task
    }

    // MARK: Konten

    public func refreshAccounts() async {
        guard let list = await call(API.accounts(), quiet: true) else { return }
        for account in list.accounts { try? environment?.store.store(account: account) }
        reload()
    }

    public func applyAccount(_ account: Account) {
        try? environment?.store.store(account: account)
        reload()
    }

    public func removeAccount(_ id: UUID) async {
        guard await call(API.removeAccount(id)) != nil else { return }
        try? environment?.store.removeAccount(id: id)
        reload()
        banner = Banner(message: "Konto entfernt. Aufgaben bleiben erhalten.")
    }

    /// Ergebnis der OAuth-Weiterleitung (`mailpilot://accounts/...`).
    public func handleAccountCallback(_ link: DeepLink) async {
        lastAccountConnection = link
        switch link {
        case .accountConnected:
            await refreshAccounts()
            banner = Banner(message: "Postfach verbunden.")
        case .accountError(let code):
            banner = Banner(kind: .error, message: DeepLink.accountErrorMessage(code))
        default:
            break
        }
    }

    // MARK: Regeln, Einstellungen, Verbrauch

    public func updateRule(_ id: UUID, _ patch: RulePatch) async {
        if let rule = await call(API.patchRule(id, patch)) {
            try? environment?.store.store(rule: rule)
            reload()
        }
    }

    public func deleteRule(_ id: UUID) async {
        if await call(API.deleteRule(id)) != nil {
            try? environment?.store.removeRule(id: id)
            reload()
        }
    }

    public func updateSettings(_ patch: SettingsPatch) async {
        guard let settings = await call(API.patchSettings(patch)), let userId = session?.user.id else { return }
        try? environment?.store.store(settings: settings, userId: userId)
        reload()
    }

    public func loadUsage() async {
        usage = await call(API.usage(), quiet: true)
    }

    // MARK: Benachrichtigungen (erst im passenden Moment fragen)

    public func didRegisterForPush(token: Data) async {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        _ = await call(API.registerPush(PushRegistration(token: hex, environment: pushEnvironment)), quiet: true)
    }

    // MARK: Anmeldung

    public func completeSignIn(_ response: SessionResponse) async {
        guard let environment else { return }
        do {
            try environment.signIn(with: response)
        } catch {
            banner = Banner(kind: .error, message: "Anmeldung konnte nicht gespeichert werden: \(error.localizedDescription)")
            return
        }
        phase = .launching
        reload()
        await syncNow()
        await refreshAccounts()
        decidePhase()
    }

    public func signInWithApple(identityToken: String, rawNonce: String, fullName: String?) async {
        let body = AppleSignIn(identityToken: identityToken, nonce: rawNonce, deviceName: DeviceName.current, fullName: fullName)
        if let response = await call(API.signInWithApple(body)) { await completeSignIn(response) }
    }

    /// Nur in Entwicklungs-Builds sichtbar; der Server erlaubt ihn nur mit DEV_LOGIN_ENABLED außerhalb von Produktion.
    public func devSignIn(email: String) async {
        guard developerMode else { return }
        if let response = await call(API.devSignIn(DevSignIn(email: email, deviceName: DeviceName.current))) { await completeSignIn(response) }
    }

    public func signOut() async {
        await environment?.signOut()
        onboardingCompleted = false
        reload()
        decidePhase()
    }

    // MARK: Entwicklung

    public var serverURL: URL? { environment?.api.baseURL }

    public func setServerURL(_ string: String) {
        guard developerMode, let url = URL(string: string.trimmingCharacters(in: .whitespaces)), url.scheme != nil else {
            banner = Banner(kind: .error, message: "Ungültige Server-URL.")
            return
        }
        environment?.api.setBaseURL(url)
        defaults?.set(url.absoluteString, forKey: AppConfiguration.debugAPIBaseURLKey)
        banner = Banner(message: "Server-URL gespeichert.")
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
