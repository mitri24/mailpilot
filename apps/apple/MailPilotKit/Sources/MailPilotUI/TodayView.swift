import MailPilotKit
import SwiftUI

/// Zeile mit Karte, Kontextmenü und Wischaktionen; öffnet das Detail über `navigationDestination(for: UUID.self)`.
public struct TaskRow: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem
    var showsStatusButtons = false
    @State private var showsWaiting = false
    @State private var showsCorrection = false

    public init(task: TaskItem, showsStatusButtons: Bool = false) {
        self.task = task
        self.showsStatusButtons = showsStatusButtons
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            NavigationLink(value: task.id) {
                TaskCard(task: task)
            }
            if showsStatusButtons {
                StatusButtons(task: task)
            }
        }
        .contextMenu {
            TaskActionsMenuContent(task: task, onWaiting: { showsWaiting = true }, onCorrection: { showsCorrection = true })
        }
        .swipeActions(edge: .leading) {
            if task.isOpen {
                Button("Erledigt", systemImage: "checkmark") { model.setStatus(.done, for: task.id) }
                    .tint(.green)
            }
        }
        .swipeActions(edge: .trailing) {
            if task.isOpen {
                Button("Morgen", systemImage: "arrow.right.to.line") { model.postponeToTomorrow(task.id) }
                    .tint(.blue)
            }
            Button("Nicht relevant", systemImage: "xmark.circle") { model.dismiss(task.id) }
                .tint(.gray)
        }
        .sheet(isPresented: $showsWaiting) { WaitingSheet(task: task) }
        .sheet(isPresented: $showsCorrection) { CorrectionSheet(task: task) }
    }
}

public struct TodayView: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let today = model.today
        List {
            Section {
                SyncStatusLine()
                ForEach(today.accountsNeedingAttention) { attention in
                    AccountAttentionRow(attention: attention)
                }
                if today.pendingAnalysisCount > 0 {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(GermanText.count(today.pendingAnalysisCount, "Mail", "Mails")) noch ungeprüft")
                            if model.usage?.budgetReached == true {
                                Text("Das KI-Budget ist erreicht; die Analyse ist pausiert. Eigene Aufgaben kannst du weiter anlegen.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    } icon: {
                        Image(systemName: "tray.full")
                    }
                }
                if !model.state.notices.isEmpty {
                    NoticeList(notices: model.state.notices)
                }
            }

            Section("Als Nächstes") {
                if today.next.isEmpty {
                    emptyState(today)
                } else {
                    ForEach(today.next) { TaskRow(task: $0) }
                }
            }

            if !today.moreUrgent.isEmpty {
                Section {
                    ForEach(today.moreUrgent) { TaskRow(task: $0) }
                } header: {
                    Text("Ebenfalls dringend (\(today.moreUrgent.count))")
                } footer: {
                    Text("Kritische oder bald fällige Aufgaben werden hier vollständig gezeigt.")
                }
            }

            Section {
                if today.openClarifications > 0 {
                    Button {
                        model.section = .clarifications
                    } label: {
                        Label(GermanText.count(today.openClarifications, "offene Rückfrage", "offene Rückfragen"), systemImage: "questionmark.bubble")
                    }
                }
                if today.waitingCount > 0 {
                    NavigationLink {
                        TaskListView(title: "Warte auf Antwort", tasks: model.state.waitingTasks)
                    } label: {
                        Label("Warte auf Antwort (\(today.waitingCount))", systemImage: "hourglass")
                    }
                }
                if today.canWaitCount > 0 {
                    NavigationLink {
                        TaskListView(title: "Kann warten", tasks: model.state.canWaitTasks)
                    } label: {
                        Label("Kann warten (\(today.canWaitCount))", systemImage: "arrow.down")
                    }
                }
                if let fetched = today.lastSuccessfulUpdateAt {
                    Label("Mails zuletzt abgerufen: \(GermanText.dateTime(fetched, in: model.timeZone, now: model.now))", systemImage: "tray.and.arrow.down")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Heute")
        .refreshable { await model.syncNow() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Neue Aufgabe", systemImage: "plus") { model.isComposingTask = true }
            }
            ToolbarItem {
                Button("Aktualisieren", systemImage: "arrow.clockwise") { Task { await model.syncNow() } }
                    .disabled(model.isSyncing)
            }
        }
        .task { await model.loadUsage() }
    }

    @ViewBuilder
    private func emptyState(_ today: Today) -> some View {
        // Nie „keine Aufgaben“, solange Mails noch nicht geprüft sind.
        if today.pendingAnalysisCount > 0 {
            Label("Noch \(GermanText.count(today.pendingAnalysisCount, "Mail", "Mails")) ungeprüft. Aufgaben können noch hinzukommen.", systemImage: "hourglass")
                .foregroundStyle(.secondary)
        } else if model.state.syncState.lastSuccessfulSyncAt == nil {
            Label("Noch nicht synchronisiert.", systemImage: "icloud.slash")
                .foregroundStyle(.secondary)
        } else {
            Label("Für jetzt ist nichts offen.", systemImage: "checkmark.circle")
                .foregroundStyle(.secondary)
        }
    }
}

struct AccountAttentionRow: View {
    @Environment(AppModel.self) private var model
    let attention: AccountAttention

    var body: some View {
        HStack(alignment: .top) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(attention.displayName).font(.subheadline.weight(.semibold))
                Text(attention.problem).font(.callout)
                Button(attention.action) {
                    model.section = .accounts
                    model.lastAccountConnection = .account(attention.accountId)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Einfache Liste, z. B. „Warte auf Antwort“, „Kann warten“, „Nicht relevant“.
public struct TaskListView: View {
    let title: String
    let tasks: [TaskItem]

    public init(title: String, tasks: [TaskItem]) {
        self.title = title
        self.tasks = tasks
    }

    public var body: some View {
        List {
            if tasks.isEmpty {
                Text("Keine Einträge.").foregroundStyle(.secondary)
            }
            ForEach(tasks) { TaskRow(task: $0, showsStatusButtons: true) }
        }
        .navigationTitle(title)
    }
}

// MARK: - Sheets

public struct WaitingSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: TaskItem
    @State private var withCheckDate = false
    @State private var checkDate = Date().addingTimeInterval(3 * 86_400)
    @State private var note = ""

    public init(task: TaskItem) { self.task = task }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Die Aufgabe erscheint nicht mehr unter den nächsten Aufgaben und bleibt über „Warte auf Antwort“ erreichbar.")
                        .foregroundStyle(.secondary)
                }
                Section {
                    Toggle("Zeitpunkt zum Nachsehen", isOn: $withCheckDate)
                    if withCheckDate {
                        DatePicker("Nachsehen am", selection: $checkDate, displayedComponents: .date)
                    }
                }
                Section("Notiz (optional)") {
                    TextField("z. B. bei Claire angefragt", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Warte auf Antwort")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") {
                        let day = withCheckDate ? LocalDate(checkDate, in: model.timeZone) : nil
                        model.setWaiting(true, checkAt: day, for: task.id)
                        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty { model.addNote(task.id, body: trimmed) }
                        dismiss()
                    }
                }
            }
        }
        .frame(minWidth: 360, minHeight: 320)
    }
}

public struct NewTaskSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var nextStep = ""
    @State private var priority: Priority = .important
    @State private var hasDeadline = false
    @State private var deadline = Date().addingTimeInterval(86_400)
    @State private var note = ""

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                Section("Was ist zu tun?") {
                    TextField("Titel, z. B. „Formular abgeben“", text: $title)
                    TextField("Nächster Schritt (optional)", text: $nextStep, axis: .vertical)
                }
                Section("Priorität") {
                    Picker("Priorität", selection: $priority) {
                        ForEach(Priority.allCases, id: \.self) { value in
                            Label(GermanText.priority(value), systemImage: GermanText.prioritySymbol(value)).tag(value)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section {
                    Toggle("Frist", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker("Bis", selection: $deadline, displayedComponents: .date)
                    }
                } footer: {
                    Text("Eine Frist ohne Uhrzeit bleibt ein reines Datum.")
                }
                Section("Notiz (optional)") {
                    TextField("Eigene Notiz", text: $note, axis: .vertical).lineLimit(2...6)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Neue Aufgabe")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Anlegen") {
                        let manual = hasDeadline ? ManualDeadline.onDate(LocalDate(deadline, in: model.timeZone)) : nil
                        if model.createTask(title: title, nextStep: nextStep, priority: priority, deadline: manual, note: note) != nil {
                            dismiss()
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .frame(minWidth: 380, minHeight: 460)
    }
}

struct DeadlineEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: TaskItem
    @State private var date = Date()
    @State private var withTime = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Frist", selection: $date, displayedComponents: withTime ? [.date, .hourAndMinute] : [.date])
                    Toggle("Mit Uhrzeit", isOn: $withTime)
                } footer: {
                    Text("Ohne Uhrzeit wird nur das Datum gespeichert; es wird keine Uhrzeit erfunden.")
                }
                Section {
                    Button("Frist speichern") {
                        let manual = withTime ? ManualDeadline.at(date) : ManualDeadline.onDate(LocalDate(date, in: model.timeZone))
                        model.update(task.id, TaskPatch(deadline: .set(manual)))
                        dismiss()
                    }
                    Button("Keine Frist") {
                        model.update(task.id, TaskPatch(deadlineCleared: true))
                        dismiss()
                    }
                    if task.deadlineIsManual {
                        Button("Zurück zum erkannten Wert") {
                            model.update(task.id, TaskPatch(deadline: .clear, deadlineCleared: false))
                            dismiss()
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Frist ändern")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } } }
            .onAppear {
                if let deadline = task.deadline {
                    if deadline.precision == .datetime, let instant = deadline.dateTime {
                        date = instant
                        withTime = true
                    } else if let day = deadline.date {
                        date = day.startOfDay(in: model.timeZone).addingTimeInterval(12 * 3600)
                    }
                }
            }
        }
        .frame(minWidth: 360, minHeight: 320)
    }
}

/// Korrekturen: Keine Aufgabe · Falsche Priorität · Frist falsch erkannt · Gehört zu bestehender Aufgabe.
public struct CorrectionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: TaskItem
    @State private var kind = 0
    @State private var priority: Priority = .canWait
    @State private var hasDeadline = true
    @State private var deadline = Date()
    @State private var target: UUID?
    @State private var isSending = false

    public init(task: TaskItem) { self.task = task }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Korrektur", selection: $kind) {
                        Text("Keine Aufgabe").tag(0)
                        Text("Falsche Priorität").tag(1)
                        Text("Frist falsch erkannt").tag(2)
                        Text("Gehört zu bestehender Aufgabe").tag(3)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } footer: {
                    Text("Korrekturen ändern nie die Originalmail.")
                }
                switch kind {
                case 1:
                    Picker("Richtige Priorität", selection: $priority) {
                        ForEach(Priority.allCases, id: \.self) { Text(GermanText.priority($0)).tag($0) }
                    }
                case 2:
                    Toggle("Es gibt eine Frist", isOn: $hasDeadline)
                    if hasDeadline { DatePicker("Richtige Frist", selection: $deadline, displayedComponents: .date) }
                case 3:
                    Picker("Aufgabe", selection: $target) {
                        Text("Bitte wählen").tag(UUID?.none)
                        ForEach(model.state.visibleTasks.filter { $0.id != task.id && $0.isOpen }.sorted { $0.title < $1.title }) { other in
                            Text(other.title).tag(UUID?.some(other.id))
                        }
                    }
                    Text("Quellen, Notizen und Verlauf bleiben erhalten; das Zusammenführen lässt sich rückgängig machen.")
                        .font(.caption).foregroundStyle(.secondary)
                default:
                    Text("Die Aufgabe wird als nicht relevant markiert, die Mail bleibt unverändert.")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Korrektur")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Senden") {
                        isSending = true
                        Task {
                            await model.correct(task.id, correction)
                            isSending = false
                            dismiss()
                        }
                    }
                    .disabled(isSending || (kind == 3 && target == nil))
                }
            }
        }
        .frame(minWidth: 380, minHeight: 420)
    }

    private var correction: Correction {
        switch kind {
        case 1: return .wrongPriority(priority)
        case 2: return .wrongDeadline(hasDeadline ? .onDate(LocalDate(deadline, in: model.timeZone)) : nil)
        case 3: return .belongsTo(taskId: target ?? task.id)
        default: return .notATask
        }
    }
}
