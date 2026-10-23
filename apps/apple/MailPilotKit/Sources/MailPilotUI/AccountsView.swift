import AuthenticationServices
import MailPilotKit
import SwiftUI

public struct AccountsView: View {
    @Environment(AppModel.self) private var model
    @State private var showsConnect = false
    @State private var selected: UUID?

    public init() {}

    public var body: some View {
        List {
            if model.state.accounts.isEmpty {
                ContentUnavailableView("Noch kein Postfach verbunden", systemImage: "tray",
                                       description: Text("Verbinde ein Postfach, damit MailPilot Aufgaben aus deinen Mails erkennt."))
            }
            ForEach(model.state.sortedAccounts) { account in
                Button {
                    selected = account.id
                } label: {
                    AccountSummaryRow(account: account)
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle("Konten")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Postfach verbinden", systemImage: "plus") { showsConnect = true }
            }
        }
        .navigationDestination(item: $selected) { id in AccountDetailView(accountId: id) }
        .sheet(isPresented: $showsConnect) {
            NavigationStack {
                ConnectAccountView { _ in showsConnect = false }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { showsConnect = false } } }
            }
            .frame(minWidth: 420, minHeight: 520)
        }
        .refreshable { await model.refreshAccounts() }
        .task { await model.refreshAccounts() }
        .onChange(of: model.lastAccountConnection) { _, link in
            if case .account(let id)? = link { selected = id }
        }
        .onAppear {
            if case .account(let id)? = model.lastAccountConnection { selected = id }
        }
    }
}

struct AccountSummaryRow: View {
    @Environment(AppModel.self) private var model
    let account: Account

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(account.displayName).font(.headline)
                Spacer()
                Label(GermanText.accountStatus(account.status), systemImage: statusSymbol)
                    .font(.caption)
                    .foregroundStyle(account.status == .active ? Color.secondary : Color.orange)
            }
            Text("\(account.emailAddress) · \(GermanText.provider(account.provider))").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if let fetched = account.lastSuccessfulFetchAt {
                    Text("Abruf: \(GermanText.age(of: fetched, now: model.now))")
                }
                if account.pendingAnalysisCount > 0 {
                    Text("\(account.pendingAnalysisCount) ungeprüft")
                }
                if !account.markerReliable {
                    Text("Markierung nicht zuverlässig sichtbar")
                }
            }
            .font(.caption2).foregroundStyle(.secondary)
            if let error = account.lastError {
                Text("\(error.message)\(error.action.map { " – \($0)" } ?? "")").font(.caption).foregroundStyle(.orange)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var statusSymbol: String {
        switch account.status {
        case .active: return "checkmark.circle"
        case .paused: return "pause.circle"
        case .error, .needsReauth: return "exclamationmark.triangle"
        case .removed: return "minus.circle"
        }
    }
}

/// Konto: Verbindung, letzter Abruf, letzte Analyse, ungeprüfte Mails, Markierung, Fehler mit Handlung.
public struct AccountDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    let accountId: UUID
    @State private var checkResult: AccountCheck?
    @State private var isWorking = false
    @State private var confirmsRemoval = false
    @State private var newAlias = ""
    @State private var importDays = 14
    @State private var scanRun: ScanRun?

    public init(accountId: UUID) { self.accountId = accountId }

    public var body: some View {
        if let account = model.state.accounts[accountId] {
            form(account)
                .navigationTitle(account.displayName)
                .onAppear { importDays = account.initialImportDays }
        } else {
            ContentUnavailableView("Konto nicht gefunden", systemImage: "person.crop.circle.badge.questionmark")
        }
    }

    @ViewBuilder
    private func form(_ account: Account) -> some View {
        Form {
            Section("Verbindung") {
                LabeledContent("Status", value: GermanText.accountStatus(account.status))
                LabeledContent("Anbieter", value: GermanText.provider(account.provider))
                LabeledContent("Letzter Mailabruf", value: account.lastSuccessfulFetchAt.map { GermanText.dateTime($0, in: model.timeZone, now: model.now) } ?? "noch keiner")
                LabeledContent("Letzte KI-Analyse", value: account.lastSuccessfulAnalysisAt.map { GermanText.dateTime($0, in: model.timeZone, now: model.now) } ?? "noch keine")
                LabeledContent("Noch ungeprüfte Mails", value: String(account.pendingAnalysisCount))
                if let error = account.lastError {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(error.message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        Text(GermanText.dateTime(error.at, in: model.timeZone, now: model.now)).font(.caption).foregroundStyle(.secondary)
                    }
                    actionButton(for: account, suggested: error.action)
                } else if account.status == .needsReauth {
                    actionButton(for: account, suggested: "Konto erneut verbinden")
                }
                if let checkResult {
                    if checkResult.ok {
                        Label("Verbindung in Ordnung", systemImage: "checkmark.circle").foregroundStyle(.green)
                    } else {
                        Label("\(checkResult.problem ?? "Verbindung fehlgeschlagen")\(checkResult.action.map { " – \($0)" } ?? "")",
                              systemImage: "xmark.octagon").foregroundStyle(.red)
                    }
                }
                HStack {
                    Button("Verbindung prüfen") { Task { await check(account) } }
                    Button(account.status == .paused ? "Fortsetzen" : "Pausieren") {
                        Task { await patch(AccountPatch(status: account.status == .paused ? .active : .paused)) }
                    }
                    Button("Jetzt Mails prüfen") { Task { await scan() } }
                        .disabled(account.status == .paused)
                }
                .disabled(isWorking)
                if let run = scanRun {
                    Text("Lauf: \(GermanText.runStatus(run.status)) · \(run.stats.fetched) abgerufen · \(run.stats.tasksCreated) neue Aufgaben")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section {
                NavigationLink("Ordner auswählen") { FolderSelectionView(accountId: account.id) }
                Stepper("Importzeitraum: \(importDays) Tage", value: $importDays, in: 1...365)
                    .onChange(of: importDays) { _, value in
                        guard value != account.initialImportDays else { return }
                        Task { await patch(AccountPatch(initialImportDays: value)) }
                    }
                Toggle("Gesendete Mails berücksichtigen (eigene Antworten erkennen)", isOn: Binding(get: { account.includeSent }, set: { value in
                    Task { await patch(AccountPatch(includeSent: value)) }
                }))
            } header: {
                Text("Umfang")
            } footer: {
                Text("Spam und Papierkorb sind standardmäßig ausgeschlossen. Das Lesen durch MailPilot markiert Mails nicht als gelesen.")
            }

            Section("Eigene Adressen und Aliasse") {
                ForEach(account.aliases, id: \.self) { alias in
                    HStack {
                        Text(alias)
                        Spacer()
                        Button("Entfernen", systemImage: "minus.circle") {
                            Task { await patch(AccountPatch(aliases: account.aliases.filter { $0 != alias })) }
                        }
                        .labelStyle(.iconOnly).buttonStyle(.borderless)
                    }
                }
                HStack {
                    TextField("weitere@adresse.example", text: $newAlias)
                        .textContentType(.emailAddress)
                    Button("Hinzufügen") {
                        let alias = newAlias.trimmingCharacters(in: .whitespaces)
                        Task { await patch(AccountPatch(aliases: account.aliases + [alias])) }
                        newAlias = ""
                    }
                    .disabled(!newAlias.contains("@"))
                }
            }

            Section {
                LabeledContent("Strategie", value: GermanText.marker(account.marker.strategy))
                if !account.markerReliable {
                    Label("Diese Markierung ist in Apple Mail nicht zuverlässig sichtbar.", systemImage: "eye.slash").foregroundStyle(.orange)
                }
                if account.markerFailures > 0 {
                    Text("\(account.markerFailures) Markierungen sind fehlgeschlagen; Aufgaben sind davon nicht betroffen.").font(.caption)
                }
                NavigationLink("Markierung einstellen") { MarkerSettingsView(account: account) }
            } header: {
                Text("Markierung in Apple Mail")
            } footer: {
                Text("Die Zuordnung von Mail und Aufgabe speichert MailPilot unabhängig von jeder Markierung.")
            }

            Section {
                Button("Konto entfernen", role: .destructive) { confirmsRemoval = true }
            } footer: {
                Text("Der Zugang wird widerrufen. Aufgaben und Notizen bleiben erhalten.")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Konto „\(account.displayName)“ entfernen?", isPresented: $confirmsRemoval) {
            Button("Entfernen", role: .destructive) { Task { await model.removeAccount(account.id) } }
        } message: {
            Text("Aufgaben bleiben erhalten. Mails dieses Kontos werden nicht mehr abgerufen.")
        }
    }

    @ViewBuilder
    private func actionButton(for account: Account, suggested: String?) -> some View {
        if account.provider != .imap && (account.status == .needsReauth || account.lastError?.code == "auth_failed" || account.lastError?.code == "needs_reauth") {
            Button("Konto erneut verbinden") { Task { await reconnect(account) } }
                .buttonStyle(.borderedProminent)
        } else if account.provider == .imap && account.status == .needsReauth {
            Text("Für IMAP: Konto entfernen und mit neuem (ggf. app-spezifischem) Passwort neu verbinden.").font(.caption)
        } else if let suggested {
            Button(suggested) { Task { await check(account) } }
                .buttonStyle(.bordered)
        }
    }

    private func check(_ account: Account) async {
        isWorking = true
        checkResult = await model.call(API.checkAccount(account.id))
        await model.refreshAccounts()
        isWorking = false
    }

    private func patch(_ patch: AccountPatch) async {
        isWorking = true
        if let updated = await model.call(API.patchAccount(accountId, patch)) { model.applyAccount(updated) }
        isWorking = false
    }

    private func scan() async {
        isWorking = true
        scanRun = await model.call(API.startScan(accountId: accountId))?.runs.first
        isWorking = false
        while let run = scanRun, !run.status.isFinished {
            try? await Task.sleep(for: .seconds(2))
            guard let next = await model.call(API.scan(run.id), quiet: true) else { break }
            scanRun = next
        }
        await model.syncNow()
    }

    private func reconnect(_ account: Account) async {
        guard let provider = OAuthProvider(rawValue: account.provider.rawValue),
              let start = await model.call(API.startOAuth(provider, OAuthStartRequest(loginHint: account.emailAddress, accountId: account.id,
                                                                                      withMarker: account.marker.strategy != .none))),
              let url = start.authorizationURL else { return }
        do {
            let callback = try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: DeepLink.scheme, preferredBrowserSession: .ephemeral)
            if let link = DeepLink(url: callback) { await model.handleAccountCallback(link) }
        } catch {
            model.banner = Banner(kind: .error, message: "Anmeldung beim Anbieter abgebrochen.")
        }
    }
}

/// Postfach verbinden: Vorschlag zur Adresse, dann OAuth (Gmail, Microsoft) oder IMAP-Formular.
public struct ConnectAccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    let onConnected: (UUID?) -> Void
    @State private var email = ""
    @State private var suggestion: SetupSuggestion?
    @State private var useImap = false
    @State private var withMarker = false
    @State private var isWorking = false
    @State private var imap = ImapForm()

    struct ImapForm {
        var displayName = ""
        var host = ""
        var port = 993
        var secure = true
        var username = ""
        var password = ""
        var importDays = 14
    }

    public init(onConnected: @escaping (UUID?) -> Void) {
        self.onConnected = onConnected
    }

    public var body: some View {
        Form {
            Section {
                TextField("E-Mail-Adresse", text: $email)
                    .textContentType(.emailAddress)
                    .autocorrectionDisabled()
                Button("Weiter") { Task { await suggest() } }
                    .disabled(!email.contains("@") || isWorking)
            } header: {
                Text("Postfach verbinden")
            } footer: {
                Text("Die Anmeldung bei MailPilot gibt keinen Zugriff auf deine Mails; jedes Postfach wird einzeln freigegeben.")
            }

            if let suggestion {
                Section("Vorschlag") {
                    ForEach(suggestion.notes, id: \.self) { Text($0).font(.callout) }
                    if suggestion.confidence != .known {
                        Text("Nicht jede Hochschul- oder Firmenadresse erlaubt IMAP. Im Zweifel bei der IT nachfragen.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if !useImap, let provider = OAuthProvider(rawValue: suggestion.provider.rawValue) {
                        Toggle("Markieren in der Mailbox erlauben (Schreibrecht)", isOn: $withMarker)
                        Text("Nur nötig, wenn MailPilot übernommene Mails markieren soll. Ohne bleibt der Zugriff lesend.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button(provider == .gmail ? "Mit Google anmelden" : "Mit Microsoft anmelden") { Task { await oauth(provider) } }
                            .buttonStyle(.borderedProminent)
                            .disabled(isWorking)
                        Button("Stattdessen IMAP verwenden") { useImap = true }
                    }
                }
                if useImap || OAuthProvider(rawValue: suggestion.provider.rawValue) == nil {
                    imapSection
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Postfach verbinden")
    }

    private var imapSection: some View {
        Section {
            TextField("Name, z. B. Hochschule", text: $imap.displayName)
            TextField("IMAP-Server", text: $imap.host).autocorrectionDisabled()
            Stepper("Port: \(imap.port)", value: $imap.port, in: 1...65535)
            Toggle("TLS direkt (sonst STARTTLS)", isOn: $imap.secure)
            TextField("Benutzername", text: $imap.username).autocorrectionDisabled()
            SecureField("Passwort", text: $imap.password)
            Stepper("Importzeitraum: \(imap.importDays) Tage", value: $imap.importDays, in: 1...365)
            Button("Verbinden und prüfen") { Task { await connectImap() } }
                .buttonStyle(.borderedProminent)
                .disabled(isWorking || imap.host.isEmpty || imap.username.isEmpty || imap.password.isEmpty)
        } header: {
            Text("IMAP")
        } footer: {
            Text("Bei iCloud und manchen Anbietern ist ein app-spezifisches Passwort nötig. Das Passwort wird nur an deinen MailPilot-Server übertragen und dort verschlüsselt gespeichert.")
        }
    }

    private func suggest() async {
        isWorking = true
        defer { isWorking = false }
        let address = email.trimmingCharacters(in: .whitespaces)
        suggestion = await model.call(API.setupSuggestion(email: address))
        if let imapServer = suggestion?.imap {
            imap.host = imapServer.host
            imap.port = imapServer.port
            imap.secure = imapServer.secure
        }
        if imap.username.isEmpty { imap.username = address }
        if imap.displayName.isEmpty { imap.displayName = address.components(separatedBy: "@").last ?? address }
        useImap = suggestion.map { OAuthProvider(rawValue: $0.provider.rawValue) == nil } ?? false
    }

    private func oauth(_ provider: OAuthProvider) async {
        isWorking = true
        defer { isWorking = false }
        guard let start = await model.call(API.startOAuth(provider, OAuthStartRequest(loginHint: email.trimmingCharacters(in: .whitespaces), withMarker: withMarker))),
              let url = start.authorizationURL else { return }
        do {
            // Der Server leitet nach der Freigabe auf mailpilot://accounts/connected?accountId=… bzw. …/error?code=… weiter.
            let callback = try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: DeepLink.scheme, preferredBrowserSession: .ephemeral)
            guard let link = DeepLink(url: callback) else { return }
            await model.handleAccountCallback(link)
            if case .accountConnected(let accountId) = link { onConnected(accountId) }
        } catch {
            model.banner = Banner(kind: .error, message: "Anmeldung beim Anbieter abgebrochen.")
        }
    }

    private func connectImap() async {
        isWorking = true
        defer { isWorking = false }
        let body = ImapAccountCreate(displayName: imap.displayName.isEmpty ? email : imap.displayName, emailAddress: email.trimmingCharacters(in: .whitespaces),
                                     host: imap.host.trimmingCharacters(in: .whitespaces), port: imap.port, secure: imap.secure,
                                     username: imap.username, password: imap.password, initialImportDays: imap.importDays)
        if let account = await model.call(API.connectImap(body)) {
            model.applyAccount(account)
            imap.password = ""
            onConnected(account.id)
        }
    }
}

/// Markierung: nur vom Konto unterstützte Strategien, Einschränkungen erklären und bestätigen lassen.
struct MarkerSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let account: Account
    @State private var strategy: MarkerStrategy = .none
    @State private var keyword = "MailPilot"
    @State private var folder = "MailPilot"
    @State private var acknowledged = false

    private var options: [MarkerStrategy] {
        var list: [MarkerStrategy] = [.none]
        for value in account.capabilities?.supportedMarkers ?? [] where !list.contains(value) { list.append(value) }
        return list
    }

    var body: some View {
        Form {
            Section {
                Picker("Markierung", selection: $strategy) {
                    ForEach(options, id: \.self) { Text(GermanText.marker($0)).tag($0) }
                }
                Text(GermanText.markerExplanation(strategy)).font(.callout)
                if account.capabilities == nil {
                    Text("Die Fähigkeiten dieses Kontos sind noch nicht erkannt. Bitte zuerst „Verbindung prüfen“.").font(.caption).foregroundStyle(.orange)
                }
                ForEach(account.capabilities?.notes ?? [], id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
            } footer: {
                Text("Bestehende Markierungen werden nicht verändert; Mails werden nicht verschoben. „Erledigt“ entfernt keine Markierung.")
            }
            if strategy == .imapKeyword || strategy == .gmailLabel || strategy == .graphCategory {
                Section("Name") { TextField("Name", text: $keyword) }
            }
            if strategy == .imapCopyFolder {
                Section("Ordner für Kopien") { TextField("Ordner", text: $folder) }
            }
            if strategy != .none {
                Section {
                    Toggle("Ich habe die Einschränkungen gelesen", isOn: $acknowledged)
                }
            }
            Section {
                Button("Speichern") {
                    let config = MarkerConfig(strategy: strategy,
                                              keyword: [.imapKeyword, .gmailLabel, .graphCategory].contains(strategy) ? keyword : nil,
                                              folder: strategy == .imapCopyFolder ? folder : nil,
                                              acknowledgedLimitations: strategy == .none ? false : acknowledged)
                    Task {
                        if let updated = await model.call(API.patchAccount(account.id, AccountPatch(marker: config))) {
                            model.applyAccount(updated)
                            dismiss()
                        }
                    }
                }
                .disabled(strategy != .none && !acknowledged)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Markierung")
        .onAppear {
            strategy = account.marker.strategy
            keyword = account.marker.keyword ?? keyword
            folder = account.marker.folder ?? folder
            acknowledged = account.marker.acknowledgedLimitations
        }
        .onChange(of: strategy) { _, value in
            if value != account.marker.strategy { acknowledged = false }
        }
    }
}

struct FolderSelectionView: View {
    @Environment(AppModel.self) private var model
    let accountId: UUID
    @State private var folders: [Folder] = []
    @State private var selected: Set<UUID> = []
    @State private var isLoading = true

    var body: some View {
        Form {
            if isLoading { ProgressView() }
            ForEach(folders) { folder in
                Toggle(isOn: Binding(get: { selected.contains(folder.id) }, set: { on in
                    if on { selected.insert(folder.id) } else { selected.remove(folder.id) }
                })) {
                    VStack(alignment: .leading) {
                        Text(folder.name)
                        Text("\(GermanText.folderRole(folder.role)) · \(folder.path)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                Button("Auswahl speichern") {
                    Task {
                        if let result = await model.call(API.selectFolders(accountId, FolderSelection(selectedFolderIds: Array(selected)))) {
                            folders = result.folders
                            selected = Set(result.folders.filter(\.selected).map(\.id))
                            model.banner = Banner(message: "Ordnerauswahl gespeichert.")
                        }
                    }
                }
            } footer: {
                Text("Spam und Papierkorb sind standardmäßig nicht ausgewählt.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Ordner")
        .task {
            if let result = await model.call(API.folders(accountId)) {
                folders = result.folders
                selected = Set(result.folders.filter(\.selected).map(\.id))
            }
            isLoading = false
        }
    }
}
