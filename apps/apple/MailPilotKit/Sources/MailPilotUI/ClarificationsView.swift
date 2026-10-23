import MailPilotKit
import SwiftUI

/// Gebündelte Rückfragen: Frage, Grund, Mailausschnitt, Antworten wie vom Server, „Weiß ich noch nicht“, freie Antwort.
public struct ClarificationsView: View {
    @Environment(AppModel.self) private var model
    /// Lokal zurückgestellt (wenn der Server keine `later`-Option anbietet): bleibt offen, kein Serveraufruf.
    @State private var deferred: Set<UUID> = []

    public init() {}

    public var body: some View {
        let open = model.state.openClarifications
        let visible = open.filter { !deferred.contains($0.id) }
        List {
            if visible.isEmpty {
                ContentUnavailableView(open.isEmpty ? "Keine offenen Rückfragen" : "Alle Rückfragen zurückgestellt",
                                       systemImage: "checkmark.bubble",
                                       description: Text(open.isEmpty ? "Neue Rückfragen erscheinen hier gesammelt." : "Sie bleiben offen und erscheinen beim nächsten Öffnen wieder."))
            }
            ForEach(visible) { clarification in
                ClarificationCard(clarification: clarification) { deferred.insert(clarification.id) }
            }
            if !model.state.sortedRules.isEmpty {
                Section {
                    NavigationLink("Dauerhafte Zuordnungen (\(model.state.rules.count))") { RulesView() }
                }
            }
        }
        .navigationTitle("Rückfragen")
        .refreshable { await model.syncNow() }
    }
}

struct ClarificationCard: View {
    @Environment(AppModel.self) private var model
    let clarification: Clarification
    let deferLocally: () -> Void
    @State private var selectedOption: String?
    @State private var freeText = ""
    @State private var remember = false

    private var permanentAllowed: Bool {
        guard let selectedOption else { return false }
        return clarification.options.first { $0.id == selectedOption }?.scope == .permanent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(clarification.question).font(.headline)
            Label(clarification.reason, systemImage: "info.circle").font(.callout).foregroundStyle(.secondary)
            if let excerpt = clarification.excerpt {
                Text("„\(excerpt)“")
                    .font(.callout).italic()
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    .textSelection(.enabled)
            }
            if let taskId = clarification.taskId, let task = model.task(taskId) {
                NavigationLink(value: task.id) { Label("Aufgabe: \(task.title)", systemImage: "checklist").font(.caption) }
            }
            FlowButtons(options: clarification.options.filter { !$0.isDeferral }, selected: $selectedOption)
            if permanentAllowed {
                Toggle("Dauerhaft merken", isOn: $remember)
                Text(remember ? "Wird als Zuordnung gespeichert; in den Einstellungen änder- und löschbar." : "Gilt nur für diese Mail.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if clarification.allowFreeText {
                TextField("Eigene Antwort (optional)", text: $freeText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
            }
            HStack {
                Button("Antworten") {
                    let text = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
                    model.answer(clarification.id, optionId: selectedOption, text: text.isEmpty ? nil : text, permanent: remember && permanentAllowed)
                }
                .buttonStyle(.borderedProminent)
                .disabled(selectedOption == nil && freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let later = clarification.options.first(where: \.isDeferral) {
                    Button(later.label) { model.answer(clarification.id, optionId: later.id, text: nil, permanent: false) }
                } else {
                    Button("Später entscheiden", action: deferLocally)
                }
            }
        }
        .padding(.vertical, 6)
        .onChange(of: selectedOption) { remember = false }
    }
}

/// Antwortmöglichkeiten als umbrechende Schaltflächen.
struct FlowButtons: View {
    let options: [ClarificationOption]
    @Binding var selected: String?

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack { buttons }
            VStack(alignment: .leading) { buttons }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        ForEach(options) { option in
            Button {
                selected = selected == option.id ? nil : option.id
            } label: {
                Label(option.label, systemImage: selected == option.id ? "largecircle.fill.circle" : "circle")
            }
            .buttonStyle(.bordered)
            .accessibilityAddTraits(selected == option.id ? .isSelected : [])
        }
    }
}

/// Dauerhafte Zuordnungen: sichtbar, änderbar, löschbar.
public struct RulesView: View {
    @Environment(AppModel.self) private var model
    @State private var editingRule: Rule?
    @State private var note = ""

    public init() {}

    public var body: some View {
        List {
            if model.state.rules.isEmpty {
                Text("Noch keine dauerhaften Zuordnungen. Sie entstehen nur, wenn du bei einer Rückfrage „Dauerhaft merken“ wählst.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.state.sortedRules) { rule in
                VStack(alignment: .leading, spacing: 6) {
                    Text(rule.description).font(.headline)
                    if let note = rule.value.note { Text(note).font(.callout).foregroundStyle(.secondary) }
                    Toggle("Trifft zu", isOn: Binding(get: { rule.value.applies }, set: { value in
                        Task { await model.updateRule(rule.id, RulePatch(applies: value)) }
                    }))
                    HStack {
                        Button("Notiz") {
                            note = rule.value.note ?? ""
                            editingRule = rule
                        }
                        Button("Löschen", role: .destructive) { Task { await model.deleteRule(rule.id) } }
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
        .navigationTitle("Zuordnungen")
        .sheet(item: $editingRule) { rule in
            NavigationStack {
                Form {
                    TextField("Notiz", text: $note, axis: .vertical)
                }
                .formStyle(.grouped)
                .navigationTitle(rule.subject)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { editingRule = nil } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Sichern") {
                            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task { await model.updateRule(rule.id, RulePatch(note: trimmed.isEmpty ? .clear : .set(trimmed))) }
                            editingRule = nil
                        }
                    }
                }
            }
            .frame(minWidth: 320, minHeight: 200)
        }
    }
}
