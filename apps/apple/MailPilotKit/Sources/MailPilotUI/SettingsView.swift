import MailPilotKit
import SwiftUI
import UserNotifications

public struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmsSignOut = false
    @State private var serverURL = ""
    @State private var timezoneDraft = ""

    public init() {}

    public var body: some View {
        Form {
            if let session = model.session {
                Section("Anmeldung") {
                    LabeledContent("Angemeldet als", value: session.user.displayName ?? session.user.email ?? "Apple-Account")
                    if session.user.devLogin {
                        Label("Entwicklungslogin", systemImage: "hammer").foregroundStyle(.orange)
                    }
                    Button("Abmelden", role: .destructive) { confirmsSignOut = true }
                }
            }

            if let settings = model.state.settings {
                scanSection(settings)
                budgetSection(settings)
                notificationSection(settings)
            } else {
                Section { Text("Einstellungen werden nach der ersten Synchronisierung angezeigt.").foregroundStyle(.secondary) }
            }

            Section {
                NavigationLink("Dauerhafte Zuordnungen (\(model.state.rules.count))") { RulesView() }
                NavigationLink("Konten") { AccountsView() }
                NavigationLink("Widgets hinzufügen") { WidgetHelpView() }
                NavigationLink("Nicht relevant (\(model.state.dismissedTasks.count))") {
                    TaskListView(title: "Nicht relevant", tasks: model.state.dismissedTasks)
                }
            }

            if model.developerMode {
                developerSection
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Einstellungen")
        .task { await model.loadUsage() }
        .confirmationDialog("Abmelden?", isPresented: $confirmsSignOut) {
            Button("Abmelden", role: .destructive) { Task { await model.signOut() } }
        } message: {
            Text(model.state.pendingCount > 0
                 ? "\(GermanText.count(model.state.pendingCount, "Änderung ist", "Änderungen sind")) noch nicht übertragen und gehen verloren."
                 : "Die lokalen Daten auf diesem Gerät werden gelöscht. Auf dem Server bleibt alles erhalten.")
        }
    }

    // MARK: Abschnitte

    @ViewBuilder
    private func scanSection(_ settings: UserSettings) -> some View {
        Section {
            Toggle("Täglich prüfen", isOn: Binding(get: { settings.scanEnabled }, set: { value in
                Task { await model.updateSettings(SettingsPatch(scanEnabled: value)) }
            }))
            DatePicker("Uhrzeit", selection: Binding(get: { Self.date(fromClock: settings.scanTime) }, set: { value in
                Task { await model.updateSettings(SettingsPatch(scanTime: Self.clock(from: value))) }
            }), displayedComponents: .hourAndMinute)
            .disabled(!settings.scanEnabled)
            Picker("Zusätzlich prüfen", selection: Binding(get: { settings.extraScanIntervalMinutes ?? 0 }, set: { value in
                Task { await model.updateSettings(SettingsPatch(extraScanIntervalMinutes: value == 0 ? .clear : .set(value))) }
            })) {
                Text("Nein").tag(0)
                Text("alle 30 Minuten").tag(30)
                Text("stündlich").tag(60)
                Text("alle 2 Stunden").tag(120)
                Text("alle 4 Stunden").tag(240)
            }
            HStack {
                TextField("Zeitzone", text: $timezoneDraft)
                    .onAppear { timezoneDraft = settings.timezone }
                    .onSubmit { saveTimezone(settings) }
                Button("Gerätezone") { timezoneDraft = TimeZone.current.identifier; saveTimezone(settings) }
            }
            Button("Jetzt alle Konten prüfen") {
                Task {
                    if let runs = await model.call(API.startScan())?.runs {
                        model.banner = Banner(message: "\(GermanText.count(runs.count, "Prüfung", "Prüfungen")) gestartet.")
                    }
                }
            }
        } header: {
            Text("Mails prüfen")
        } footer: {
            Text("Die Prüfung läuft auf dem Server, auch wenn deine Geräte aus sind.")
        }
    }

    private func saveTimezone(_ settings: UserSettings) {
        let value = timezoneDraft.trimmingCharacters(in: .whitespaces)
        guard value != settings.timezone else { return }
        guard TimeZone(identifier: value) != nil else {
            model.banner = Banner(kind: .error, message: "Unbekannte Zeitzone „\(value)“.")
            return
        }
        Task { await model.updateSettings(SettingsPatch(timezone: value)) }
    }

    @ViewBuilder
    private func budgetSection(_ settings: UserSettings) -> some View {
        Section {
            Stepper("Monatliches KI-Budget: \(GermanText.euros(cents: Double(settings.aiMonthlyBudgetCents)))",
                    value: Binding(get: { settings.aiMonthlyBudgetCents / 100 }, set: { euros in
                        Task { await model.updateSettings(SettingsPatch(aiMonthlyBudgetCents: max(0, euros) * 100)) }
                    }), in: 0...1000)
            if let usage = model.usage {
                LabeledContent("Verbraucht (\(usage.month))", value: "\(GermanText.euros(cents: usage.spentCents)) von \(GermanText.euros(cents: Double(usage.budgetCents)))")
                ProgressView(value: min(usage.spentCents, Double(max(usage.budgetCents, 1))), total: Double(max(usage.budgetCents, 1)))
                LabeledContent("Analysiert in diesem Monat", value: String(usage.analyzedThisMonth))
                LabeledContent("Noch ungeprüfte Mails", value: String(usage.pendingAnalysisCount))
                if usage.budgetReached {
                    Label("Budget erreicht: Neue Mails werden weiter erfasst, die Analyse ist pausiert. Eigene Aufgaben kannst du weiter anlegen.",
                          systemImage: "pause.circle")
                        .foregroundStyle(.orange)
                }
            }
            DisclosureGroup("Größenlimits") {
                Stepper("Höchstens \(settings.maxMessageChars) Zeichen je Mail", value: Binding(get: { settings.maxMessageChars }, set: { value in
                    Task { await model.updateSettings(SettingsPatch(maxMessageChars: value)) }
                }), in: 1000...200_000, step: 1000)
                Stepper("Anhänge bis \(GermanText.bytes(settings.maxAttachmentBytes))", value: Binding(get: { settings.maxAttachmentBytes }, set: { value in
                    Task { await model.updateSettings(SettingsPatch(maxAttachmentBytes: value)) }
                }), in: 0...50_000_000, step: 1_000_000)
            }
        } header: {
            Text("KI-Verbrauch")
        }
    }

    @ViewBuilder
    private func notificationSection(_ settings: UserSettings) -> some View {
        Section {
            Toggle("Tägliche Zusammenfassung", isOn: notificationBinding(settings.notifyDailyDigest) { SettingsPatch(notifyDailyDigest: $0) })
            Toggle("Belegte dringende Fristen", isOn: notificationBinding(settings.notifyUrgentDeadlines) { SettingsPatch(notifyUrgentDeadlines: $0) })
            Toggle("Offene Rückfragen (gebündelt)", isOn: notificationBinding(settings.notifyClarifications) { SettingsPatch(notifyClarifications: $0) })
            Toggle("Ruhezeiten", isOn: Binding(get: { settings.quietHoursStart != nil && settings.quietHoursEnd != nil }, set: { on in
                Task {
                    await model.updateSettings(on
                        ? SettingsPatch(quietHoursStart: .set("22:00"), quietHoursEnd: .set("07:00"))
                        : SettingsPatch(quietHoursStart: .clear, quietHoursEnd: .clear))
                }
            }))
            if let start = settings.quietHoursStart, let end = settings.quietHoursEnd {
                DatePicker("Von", selection: Binding(get: { Self.date(fromClock: start) }, set: { value in
                    Task { await model.updateSettings(SettingsPatch(quietHoursStart: .set(Self.clock(from: value)))) }
                }), displayedComponents: .hourAndMinute)
                DatePicker("Bis", selection: Binding(get: { Self.date(fromClock: end) }, set: { value in
                    Task { await model.updateSettings(SettingsPatch(quietHoursEnd: .set(Self.clock(from: value)))) }
                }), displayedComponents: .hourAndMinute)
            }
        } header: {
            Text("Benachrichtigungen")
        } footer: {
            Text("Standardmäßig keine Mitteilung pro neuer Aufgabe. MailPilot fragt erst beim Einschalten nach der Erlaubnis und funktioniert auch ohne Mitteilungen vollständig.")
        }
    }

    /// Erlaubnis erst beim Einschalten anfragen, dann Token registrieren.
    private func notificationBinding(_ value: Bool, patch: @escaping (Bool) -> SettingsPatch) -> Binding<Bool> {
        Binding(get: { value }, set: { on in
            Task {
                if on {
                    let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                    if granted {
                        model.registerForRemoteNotifications?()
                    } else {
                        model.banner = Banner(message: "Mitteilungen sind in den Systemeinstellungen ausgeschaltet. MailPilot funktioniert auch ohne.")
                    }
                }
                await model.updateSettings(patch(on))
            }
        })
    }

    private var developerSection: some View {
        Section {
            TextField("Server-URL", text: $serverURL)
                .autocorrectionDisabled()
                .onAppear { serverURL = model.serverURL?.absoluteString ?? "" }
            Button("Server-URL übernehmen") { model.setServerURL(serverURL) }
            LabeledContent("Gemeinsamer Speicher (App Group)", value: model.environment?.store.isShared == true ? "ja" : "nein")
            LabeledContent("Ausstehende Änderungen", value: String(model.state.pendingCount))
            Button("Jetzt synchronisieren") { Task { await model.syncNow() } }
        } header: {
            Text("Entwicklung")
        } footer: {
            Text("Nur in Entwicklungs-Builds sichtbar.")
        }
    }

    // MARK: HH:MM

    static func date(fromClock clock: String) -> Date {
        let parts = clock.split(separator: ":").compactMap { Int($0) }
        var calendar = Calendar.current
        calendar.timeZone = .current
        return calendar.date(bySettingHour: parts.first ?? 7, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
    }

    static func clock(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return "\(parts.hour.map { $0 < 10 ? "0\($0)" : "\($0)" } ?? "07"):\(parts.minute.map { $0 < 10 ? "0\($0)" : "\($0)" } ?? "00")"
    }
}

/// Erklärung ohne API-Zwang: Widgets fügt man über das System hinzu.
public struct WidgetHelpView: View {
    public init() {}

    public var body: some View {
        Form {
            Section("iPhone") {
                Text("Halte einen freien Bereich des Home-Bildschirms gedrückt, tippe auf „Bearbeiten“ bzw. „+“ und wähle „MailPilot“. Es gibt drei Größen: wichtigste Aufgabe, bis zu drei Aufgaben, mehr Aufgaben mit Hinweis auf Rückfragen.")
            }
            Section("Mac") {
                Text("Klicke mit der rechten Maustaste auf den Schreibtisch und wähle „Widgets bearbeiten“ oder öffne die Mitteilungszentrale und füge „MailPilot“ hinzu.")
            }
            Section {
                Text("Im Widget kannst du eine Aufgabe öffnen, starten oder als erledigt markieren. Änderungen aus dem Widget werden mit „noch nicht synchronisiert“ gekennzeichnet, bis die App sie übertragen hat. Das Widget zeigt den zuletzt gespeicherten Stand; wie oft es neu lädt, bestimmt das System.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Widgets")
    }
}
