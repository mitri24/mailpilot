import AuthenticationServices
import MailPilotKit
import SwiftUI

/// Gemeinsamer Einstieg: Anmeldung, Onboarding oder die plattformspezifische Hauptansicht.
public struct RootView<Ready: View>: View {
    @Environment(AppModel.self) private var model
    private let ready: () -> Ready

    public init(@ViewBuilder ready: @escaping () -> Ready) {
        self.ready = ready
    }

    public var body: some View {
        @Bindable var model = model
        Group {
            switch model.phase {
            case .launching:
                ProgressView("MailPilot wird geöffnet …")
            case .unavailable:
                ContentUnavailableView("MailPilot kann nicht starten", systemImage: "externaldrive.badge.exclamationmark",
                                       description: Text(model.setupError ?? "Unbekannter Fehler"))
            case .signedOut:
                SignInView()
            case .onboarding:
                OnboardingView()
            case .ready:
                ready()
            }
        }
        .overlay(alignment: .bottom) { BannerOverlay() }
        .animation(.default, value: model.banner)
        .sheet(isPresented: $model.isComposingTask) { NewTaskSheet() }
        .task { await model.start() }
    }
}

/// Anmeldung mit Apple; der Entwicklungslogin erscheint nur in Entwicklungs-Builds.
public struct SignInView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @State private var rawNonce = ""
    @State private var devEmail = ""
    @State private var serverURL = ""
    @State private var isWorking = false

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                VStack(spacing: 8) {
                    Image(systemName: "envelope.badge")
                        .font(.system(size: 48))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    Text("MailPilot").font(.largeTitle.weight(.semibold))
                    Text("Aufgaben aus deinen Mails, auf Deutsch, auf allen Geräten.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                }
                SignInWithAppleButton(.signIn) { request in
                    rawNonce = AppleSignInNonce.random()
                    request.requestedScopes = [.fullName, .email]
                    request.nonce = AppleSignInNonce.sha256Hex(rawNonce)
                } onCompletion: { result in
                    handle(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(maxWidth: 320, minHeight: 44, maxHeight: 50)
                .disabled(isWorking)

                Text("Die Anmeldung bei MailPilot gibt noch keinen Zugriff auf deine Mails. Postfächer verbindest du danach einzeln.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 420)

                if model.developerMode {
                    developerLogin
                }
                if isWorking { ProgressView() }
            }
            .padding(32)
            .frame(maxWidth: .infinity)
        }
    }

    private var developerLogin: some View {
        GroupBox("Entwicklung") {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Server-URL", text: $serverURL)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .onAppear { serverURL = model.serverURL?.absoluteString ?? "" }
                Button("Server-URL übernehmen") { model.setServerURL(serverURL) }
                TextField("E-Mail für den Entwicklungslogin", text: $devEmail)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                Button("Entwicklungslogin") {
                    isWorking = true
                    Task {
                        await model.devSignIn(email: devEmail.trimmingCharacters(in: .whitespaces))
                        isWorking = false
                    }
                }
                .disabled(!devEmail.contains("@") || isWorking)
                Text("Nur möglich, wenn der Server mit DEV_LOGIN_ENABLED außerhalb von Produktion läuft.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: 420)
    }

    private func handle(_ result: Result<ASAuthorization, any Error>) {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                model.banner = Banner(kind: .error, message: "Apple hat keine gültige Anmeldung geliefert.")
                return
            }
            let name = credential.fullName.map { $0.formatted() }.flatMap { $0.isEmpty ? nil : $0 }
            let nonce = rawNonce
            isWorking = true
            Task {
                await model.signInWithApple(identityToken: token, rawNonce: nonce, fullName: name)
                isWorking = false
            }
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            model.banner = Banner(kind: .error, message: "Anmeldung mit Apple fehlgeschlagen: \(error.localizedDescription)")
        }
    }
}

/// Wenige Schritte: Postfach verbinden · Umfang · Markierung · erster Import · erste Aufgabe · Widgets.
public struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var step = Step.connect
    @State private var accountId: UUID?
    @State private var run: ScanRun?
    @State private var isScanning = false

    enum Step: Int, CaseIterable {
        case connect, scope, marker, firstScan, firstTask, widgets

        var title: String {
            switch self {
            case .connect: return "Postfach verbinden"
            case .scope: return "Umfang wählen"
            case .marker: return "Markierung"
            case .firstScan: return "Ersten Import starten"
            case .firstTask: return "Erste Aufgabe"
            case .widgets: return "Widgets"
            }
        }
    }

    public init() {}

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ProgressView(value: Double(step.rawValue + 1), total: Double(Step.allCases.count))
                    .padding(.horizontal)
                    .accessibilityLabel("Schritt \(step.rawValue + 1) von \(Step.allCases.count): \(step.title)")
                content
            }
            .navigationTitle(step.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Später") { model.finishOnboarding() }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .connect:
            ConnectAccountView { id in
                accountId = id ?? model.state.sortedAccounts.first?.id
                step = .scope
            }
        case .scope:
            if let accountId {
                VStack {
                    FolderSelectionView(accountId: accountId)
                    nextButton("Weiter") { step = .marker }
                }
            } else {
                nextButton("Weiter") { step = .marker }
            }
        case .marker:
            if let accountId, let account = model.state.accounts[accountId] {
                VStack {
                    MarkerSettingsView(account: account)
                    nextButton("Ohne Änderung weiter") { step = .firstScan }
                }
            } else {
                nextButton("Weiter") { step = .firstScan }
            }
        case .firstScan:
            Form {
                Text("MailPilot prüft jetzt die Mails des gewählten Zeitraums. Das läuft auf dem Server weiter, auch wenn du die App schließt.")
                if let run {
                    LabeledContent("Status", value: GermanText.runStatus(run.status))
                    LabeledContent("Abgerufen", value: String(run.stats.fetched))
                    LabeledContent("Geprüft", value: String(run.stats.analyzed))
                    LabeledContent("Neue Aufgaben", value: String(run.stats.tasksCreated))
                    LabeledContent("Rückfragen", value: String(run.stats.clarifications))
                    if run.stats.budgetPaused > 0 {
                        Text("\(run.stats.budgetPaused) Mails warten, weil das KI-Budget erreicht ist.").foregroundStyle(.orange)
                    }
                    if let error = run.error { Text(error).foregroundStyle(.red) }
                }
                Button(run == nil ? "Import starten" : "Weiter") {
                    if run == nil { Task { await startScan() } } else { step = .firstTask }
                }
                .disabled(isScanning && run?.status.isFinished != true)
            }
            .formStyle(.grouped)
        case .firstTask:
            List {
                let today = model.today
                if let first = today.next.first {
                    Section("Deine nächste Aufgabe") { TaskCard(task: first) }
                } else if today.pendingAnalysisCount > 0 {
                    Text("Noch \(GermanText.count(today.pendingAnalysisCount, "Mail", "Mails")) ungeprüft. Aufgaben erscheinen, sobald die Prüfung fertig ist.")
                } else {
                    Text("Bisher keine Aufgabe erkannt. Du kannst jederzeit eigene Aufgaben anlegen oder unter „Mails“ eine Mail übernehmen.")
                }
                Button("Weiter") { step = .widgets }
            }
            .task { await model.syncNow() }
        case .widgets:
            VStack {
                WidgetHelpView()
                nextButton("Fertig") { model.finishOnboarding() }
            }
        }
    }

    private func nextButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.borderedProminent)
            .padding()
    }

    private func startScan() async {
        isScanning = true
        run = await model.call(API.startScan(accountId: accountId))?.runs.first
        while let current = run, !current.status.isFinished {
            try? await Task.sleep(for: .seconds(2))
            guard let next = await model.call(API.scan(current.id), quiet: true) else { break }
            run = next
        }
        isScanning = false
        await model.syncNow()
    }
}

/// Inhalt eines Bereichs; das Board liefert die Plattform (Drag-and-drop auf dem Mac, Statusbuttons auf dem iPhone).
public struct SectionContent<Board: View>: View {
    let section: AppSection
    let board: () -> Board

    public init(section: AppSection, @ViewBuilder board: @escaping () -> Board) {
        self.section = section
        self.board = board
    }

    public var body: some View {
        switch section {
        case .today: TodayView()
        case .board: board()
        case .clarifications: ClarificationsView()
        case .messages: MessagesView()
        case .accounts: AccountsView()
        case .settings: SettingsView()
        }
    }
}

/// Filterleiste für das Board (Konto, Priorität, Frist, Warten, Ausgeblendete).
public struct BoardFilterBar: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        @Bindable var model = model
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { controls(model: model) }
            VStack(alignment: .leading, spacing: 8) { controls(model: model) }
        }
        .controlSize(.small)
    }

    @ViewBuilder
    private func controls(model: AppModel) -> some View {
        @Bindable var model = model
        if model.state.accounts.count > 1 {
            Picker("Konto", selection: $model.boardFilter.accountId) {
                Text("Alle Konten").tag(UUID?.none)
                ForEach(model.state.sortedAccounts) { Text($0.displayName).tag(UUID?.some($0.id)) }
            }
            .fixedSize()
        }
        Picker("Priorität", selection: $model.boardFilter.priority) {
            Text("Alle Prioritäten").tag(Priority?.none)
            ForEach(Priority.allCases, id: \.self) { Text(GermanText.priority($0)).tag(Priority?.some($0)) }
        }
        .fixedSize()
        Picker("Frist", selection: $model.boardFilter.due) {
            ForEach(BoardFilter.Due.allCases) { Text($0.label).tag($0) }
        }
        .fixedSize()
        Toggle("Warte auf Antwort", isOn: $model.boardFilter.waitingOnly)
            .fixedSize()
        Toggle("Später angezeigte", isOn: $model.boardFilter.showSnoozed)
            .fixedSize()
        if model.boardFilter.isActive {
            Button("Filter zurücksetzen") { model.boardFilter = BoardFilter() }
        }
    }
}
