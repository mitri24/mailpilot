import MailPilotKit
import SwiftUI

/// Aufgabendetail in der Reihenfolge: Was muss ich tun? · Bis wann? · Warum betrifft es mich? ·
/// Was brauche ich dafür? · Meine Notizen · Zugehörige Mails und Verlauf.
public struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let taskId: UUID
    @State private var detail: TaskDetail?
    @State private var detailFetchedAt: Date?
    @State private var isLoading = false
    @State private var showsOriginal = false
    @State private var showsDeadlineEditor = false
    @State private var showsWaiting = false
    @State private var showsCorrection = false
    @State private var titleDraft: String?
    @State private var nextStepDraft: String?
    @State private var newNote = ""
    @State private var editingNoteId: UUID?
    @State private var editingNoteText = ""
    @State private var newChecklistTitle = ""

    public init(taskId: UUID) {
        self.taskId = taskId
    }

    public var body: some View {
        Group {
            if let task = model.task(taskId) {
                content(task)
            } else {
                ContentUnavailableView("Aufgabe nicht gefunden", systemImage: "questionmark.folder",
                                       description: Text("Sie wurde vielleicht zusammengeführt oder entfernt. Bitte aktualisieren."))
            }
        }
        .task(id: taskId) { await load() }
        .onAppear { model.selectedTaskId = taskId }
        .onDisappear { if model.selectedTaskId == taskId { model.selectedTaskId = nil } }
    }

    private func load() async {
        if let cached = model.cachedDetail(taskId) {
            detail = cached.detail
            detailFetchedAt = cached.fetchedAt
        }
        isLoading = true
        if let fresh = await model.loadDetail(taskId) {
            detail = fresh
            detailFetchedAt = Date()
        }
        isLoading = false
    }

    @ViewBuilder
    private func content(_ task: TaskItem) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                let notices = model.notices(for: task.id)
                if !notices.isEmpty {
                    VStack(alignment: .leading) { NoticeList(notices: notices) }
                        .padding(12)
                        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                }
                whatToDo(task).sectionTitle("Was muss ich tun?", systemImage: "checklist")
                byWhen(task).sectionTitle("Bis wann?", systemImage: "calendar")
                why(task).sectionTitle("Warum betrifft es mich?", systemImage: "person.crop.circle.badge.questionmark")
                needs(task).sectionTitle("Was brauche ich dafür?", systemImage: "paperclip")
                notes(task).sectionTitle("Meine Notizen", systemImage: "note.text")
                mailsAndHistory(task).sectionTitle("Zugehörige Mails und Verlauf", systemImage: "envelope")
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(task.title)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu("Aktionen", systemImage: "ellipsis.circle") {
                    TaskActionsMenuContent(task: task, onWaiting: { showsWaiting = true }, onCorrection: { showsCorrection = true })
                }
            }
        }
        .refreshable { await load() }
        .sheet(isPresented: $showsDeadlineEditor) { DeadlineEditor(task: task) }
        .sheet(isPresented: $showsWaiting) { WaitingSheet(task: task) }
        .sheet(isPresented: $showsCorrection) { CorrectionSheet(task: task) }
    }

    // MARK: Was muss ich tun?

    @ViewBuilder
    private func whatToDo(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let draft = titleDraft {
                HStack {
                    TextField("Titel", text: Binding(get: { draft }, set: { titleDraft = $0 }))
                        .textFieldStyle(.roundedBorder)
                    Button("Sichern") {
                        model.update(task.id, TaskPatch(title: .set(draft)))
                        titleDraft = nil
                    }
                    Button("Abbrechen") { titleDraft = nil }
                }
            } else {
                HStack(alignment: .firstTextBaseline) {
                    Text(task.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                    Button("Titel ändern", systemImage: "pencil") { titleDraft = task.title }
                        .labelStyle(.iconOnly).buttonStyle(.borderless)
                }
            }
            if task.manual.title != nil {
                manualHint(suggestion: task.ai.title) { model.update(task.id, TaskPatch(title: .clear)) }
            }

            if let draft = nextStepDraft {
                HStack {
                    TextField("Nächster Schritt", text: Binding(get: { draft }, set: { nextStepDraft = $0 }), axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                    Button("Sichern") {
                        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        model.update(task.id, TaskPatch(nextStep: trimmed.isEmpty ? .clear : .set(trimmed)))
                        nextStepDraft = nil
                    }
                    Button("Abbrechen") { nextStepDraft = nil }
                }
            } else {
                HStack(alignment: .firstTextBaseline) {
                    Label(task.nextStep ?? "Kein nächster Schritt hinterlegt.", systemImage: "arrow.right.circle")
                        .foregroundStyle(task.nextStep == nil ? .secondary : .primary)
                    Button("Nächsten Schritt ändern", systemImage: "pencil") { nextStepDraft = task.nextStep ?? "" }
                        .labelStyle(.iconOnly).buttonStyle(.borderless)
                }
            }

            if let latest = task.latestChange {
                Label(latest, systemImage: "sparkles")
                    .padding(8)
                    .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("Neueste Änderung: \(latest)")
            }

            if let summary = task.summary {
                Text(summary).textSelection(.enabled)
            }
            let quotes = detail?.sources.flatMap(\.evidenceQuotes) ?? []
            if !quotes.isEmpty {
                DisclosureGroup(isExpanded: $showsOriginal) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(quotes.enumerated()), id: \.offset) { _, quote in
                            Text("„\(quote)“").italic().textSelection(.enabled)
                        }
                    }
                    .padding(.top, 4)
                } label: {
                    Text("Originalpassagen (Originalsprache)")
                }
            }

            HStack(spacing: 12) {
                PriorityBadge(priority: task.priority, reason: task.priorityReason, isManual: task.priorityIsManual)
                Menu("Priorität ändern") {
                    ForEach(Priority.allCases, id: \.self) { value in
                        Button(GermanText.priority(value), systemImage: GermanText.prioritySymbol(value)) {
                            model.update(task.id, TaskPatch(priority: .set(value)))
                        }
                    }
                    if task.priorityIsManual {
                        Divider()
                        Button("Zurück zum Vorschlag") { model.update(task.id, TaskPatch(priority: .clear)) }
                    }
                }
                .fixedSize()
            }
            if task.priorityIsManual, let ai = task.ai.priority {
                Text("Vorschlag war: \(GermanText.priority(ai))\(task.ai.priorityReason.map { " – \($0)" } ?? "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text("Status: \(GermanText.status(task.status))").font(.subheadline)
                StatusButtons(task: task)
            }
            TaskFlags(task: task, isPending: model.isPending(task.id), hasConflict: false, timeZone: model.timeZone, now: model.now)
        }
    }

    private func manualHint(suggestion: String?, reset: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Label("Von dir geändert", systemImage: "person.fill.checkmark")
            if let suggestion {
                Text("· Vorschlag: \(suggestion)").lineLimit(1)
                Button("Vorschlag übernehmen", action: reset).buttonStyle(.borderless)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    // MARK: Bis wann?

    @ViewBuilder
    private func byWhen(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let deadline = task.deadline {
                DeadlineLabel(deadline: deadline, timeZone: model.timeZone, now: model.now, isManual: task.deadlineIsManual, showsKind: true)
                    .font(.body)
                if let quote = deadline.sourceQuote {
                    Text("Aus der Mail: „\(quote)“").font(.callout).italic().foregroundStyle(.secondary).textSelection(.enabled)
                }
            } else {
                Text(task.deadlineIsManual ? "Keine Frist (von dir entfernt)." : "Keine Frist erkannt.").foregroundStyle(.secondary)
            }
            if task.deadlineIsManual, let ai = task.ai.deadline {
                Text("Erkannt war: \(GermanText.deadline(ai, in: model.timeZone, now: model.now)) (\(GermanText.deadlineKind(ai.kind)))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let planned = task.plannedFor {
                Label("Eingeplant für \(GermanText.day(planned, today: LocalDate(model.now, in: model.timeZone)))", systemImage: "calendar.day.timeline.left")
            }
            if let estimate = GermanText.estimate(minutes: task.estimatedMinutes, source: task.estimateSource) {
                Label("Zeitaufwand: \(estimate)", systemImage: "clock")
            }
            HStack {
                Button("Frist ändern", systemImage: "calendar.badge.exclamationmark") { showsDeadlineEditor = true }
                if task.isOpen {
                    Button("Heute einplanen") { model.planForToday(task.id) }
                    Button("Auf morgen verschieben") { model.postponeToTomorrow(task.id) }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    // MARK: Warum betrifft es mich?

    @ViewBuilder
    private func why(_ task: TaskItem) -> some View {
        if let why = task.why, !why.isEmpty {
            Text(why).textSelection(.enabled)
        } else if task.origin == .manual {
            Text("Eigene Aufgabe.").foregroundStyle(.secondary)
        } else {
            Text("Keine Begründung hinterlegt.").foregroundStyle(.secondary)
        }
    }

    // MARK: Was brauche ich dafür?

    @ViewBuilder
    private func needs(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if task.requiresAttachmentReading {
                Label("Für diese Aufgabe muss ein Anhang gelesen werden. MailPilot hat ihn nicht ausgewertet.", systemImage: "doc.text.magnifyingglass")
                    .foregroundStyle(.orange)
            }
            let attachments = (detail?.sources ?? []).filter { !$0.attachments.isEmpty }
            ForEach(attachments) { source in
                VStack(alignment: .leading, spacing: 4) {
                    Text("Anhänge von „\(source.subject ?? "ohne Betreff")“").font(.caption.weight(.semibold))
                    ForEach(Array(source.attachments.enumerated()), id: \.offset) { _, attachment in
                        Label("\(attachment.filename ?? "ohne Namen") · \(attachment.contentType ?? "Typ unbekannt") · \(GermanText.bytes(attachment.size))",
                              systemImage: "paperclip")
                            .font(.callout)
                    }
                }
            }
            if attachments.isEmpty && !task.requiresAttachmentReading {
                Text("Keine Anhänge.").foregroundStyle(.secondary).font(.callout)
            }

            let items = model.state.checklist(for: task.id)
            VStack(alignment: .leading, spacing: 6) {
                Text("Checkliste").font(.subheadline.weight(.semibold))
                ForEach(items) { item in
                    HStack {
                        Toggle(isOn: Binding(get: { item.done }, set: { model.setChecklistItem(item.id, done: $0) })) {
                            Text(item.title).strikethrough(item.done)
                        }
                        #if os(macOS)
                        .toggleStyle(.checkbox)
                        #endif
                        if item.source == .ai {
                            Text("aus der Mail").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Löschen", systemImage: "trash") { model.deleteChecklistItem(item.id) }
                            .labelStyle(.iconOnly).buttonStyle(.borderless)
                    }
                }
                HStack {
                    TextField("Punkt hinzufügen", text: $newChecklistTitle)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(addChecklistItem)
                    Button("Hinzufügen", action: addChecklistItem)
                        .disabled(newChecklistTitle.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func addChecklistItem() {
        let title = newChecklistTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        model.addChecklistItem(taskId, title: title)
        newChecklistTitle = ""
    }

    // MARK: Meine Notizen (getrennt vom KI-Inhalt)

    @ViewBuilder
    private func notes(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(model.state.notes(for: task.id)) { note in
                VStack(alignment: .leading, spacing: 4) {
                    if note.conflictOfNoteId != nil {
                        Label("Gleichzeitig bearbeitete Fassung", systemImage: "arrow.triangle.branch")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    if editingNoteId == note.id {
                        TextField("Notiz", text: $editingNoteText, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(2...10)
                        HStack {
                            Button("Sichern") {
                                model.updateNote(note.id, body: editingNoteText)
                                editingNoteId = nil
                            }
                            Button("Abbrechen") { editingNoteId = nil }
                        }
                    } else {
                        Text(note.body).textSelection(.enabled)
                        HStack {
                            Text(GermanText.dateTime(note.updatedAt, in: model.timeZone, now: model.now)).font(.caption2).foregroundStyle(.secondary)
                            Button("Bearbeiten") {
                                editingNoteId = note.id
                                editingNoteText = note.body
                            }
                            Button("Löschen", role: .destructive) { model.deleteNote(note.id) }
                        }
                        .buttonStyle(.borderless)
                        .font(.caption)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.yellow.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
            TextField("Neue Notiz", text: $newNote, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...8)
            Button("Notiz hinzufügen") {
                model.addNote(task.id, body: newNote)
                newNote = ""
            }
            .disabled(newNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    // MARK: Zugehörige Mails und Verlauf

    @ViewBuilder
    private func mailsAndHistory(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let detail {
                if detail.sources.isEmpty {
                    Text(task.origin == .manual ? "Eigene Aufgabe ohne Mail." : "Keine Mail verknüpft.").foregroundStyle(.secondary)
                }
                ForEach(detail.sources) { source in
                    NavigationLink {
                        MessageDetailView(messageId: source.messageId)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(source.subject ?? "Ohne Betreff").font(.subheadline.weight(.semibold))
                            Text([source.fromName ?? source.fromAddress, source.sentAt.map { GermanText.dateTime($0, in: model.timeZone, now: model.now) }, roleText(source.role)]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if let change = source.changeSummary {
                                Label(change, systemImage: "sparkles").font(.caption).foregroundStyle(.blue)
                            }
                        }
                    }
                    .contextMenu {
                        Button("Verknüpfung lösen", role: .destructive) {
                            Task { await model.unlinkSource(task.id, messageId: source.messageId) }
                        }
                    }
                }
                Divider()
                Text("Verlauf").font(.subheadline.weight(.semibold))
                ForEach(detail.events.sorted { $0.createdAt > $1.createdAt }) { event in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(actorText(event.actor)).font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.secondary.opacity(0.15), in: Capsule())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.summary).font(.callout)
                            if let old = event.oldValue, let new = event.newValue, old != .null || new != .null {
                                Text("\(old.displayText) → \(new.displayText)").font(.caption).foregroundStyle(.secondary)
                            }
                            Text(GermanText.dateTime(event.createdAt, in: model.timeZone, now: model.now)).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                if let fetched = detailFetchedAt {
                    Text("Stand: \(GermanText.age(of: fetched, now: model.now))").font(.caption2).foregroundStyle(.secondary)
                }
            } else if isLoading {
                ProgressView("Quellen und Verlauf werden geladen …")
            } else {
                Text("Quellen und Verlauf werden geladen, sobald eine Verbindung zum Server besteht.").foregroundStyle(.secondary)
            }
        }
    }

    private func roleText(_ role: TaskSourceRole) -> String {
        switch role {
        case .origin: return "Ursprung"
        case .update: return "Neue Information"
        case .reference: return "Verweis"
        }
    }

    private func actorText(_ actor: EventActor) -> String {
        switch actor {
        case .ai: return "KI"
        case .user: return "Du"
        case .system: return "System"
        }
    }
}
