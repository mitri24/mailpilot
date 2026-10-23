import MailPilotKit
import MailPilotUI
import SwiftUI

/// Mac: Seitenleiste mit Bereichen, rechts der Inhalt mit Navigationsstapel für Aufgaben.
struct MacRootView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()

    private var selection: Binding<AppSection?> {
        Binding(get: { model.section }, set: { if let value = $0 { model.section = value } })
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(AppSection.allCases) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .badge(section == .clarifications ? model.state.openClarifications.count : 0)
                        .tag(section)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200)
        } detail: {
            NavigationStack(path: $path) {
                SectionContent(section: model.section) { MacBoardView() }
                    .navigationDestination(for: UUID.self) { TaskDetailView(taskId: $0) }
            }
        }
        .onChange(of: model.section) { path = NavigationPath() }
        .onChange(of: model.deepLinkTaskId) { _, id in
            guard let id else { return }
            model.deepLinkTaskId = nil
            // Nach dem Bereichswechsel (der den Stapel leert) setzen.
            Task { path = NavigationPath([id]) }
        }
    }
}

/// Kanban mit Drag-and-drop zwischen To Do, Doing und Erledigt (eingeklappt).
struct MacBoardView: View {
    @Environment(AppModel.self) private var model
    @State private var showsDone = false

    var body: some View {
        @Bindable var model = model
        let board = model.board
        VStack(alignment: .leading, spacing: 12) {
            BoardFilterBar()
            if board.snoozedHidden > 0 {
                Text("\(GermanText.count(board.snoozedHidden, "Aufgabe wird", "Aufgaben werden")) später angezeigt.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 12) {
                BoardColumnView(title: "To Do", status: .todo, tasks: board.todo)
                BoardColumnView(title: "Doing", status: .doing, tasks: board.doing)
                if showsDone {
                    BoardColumnView(title: "Erledigt", status: .done, tasks: board.done, onCollapse: { showsDone = false })
                } else {
                    CollapsedDoneColumn(count: board.done.count) { showsDone = true }
                }
            }
        }
        .padding()
        .navigationTitle("Board")
        .searchable(text: $model.boardFilter.search, prompt: "Aufgaben durchsuchen")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Neue Aufgabe", systemImage: "plus") { model.isComposingTask = true }
            }
            ToolbarItem {
                Button("Aktualisieren", systemImage: "arrow.clockwise") { Task { await model.syncNow() } }
            }
        }
    }
}

struct BoardColumnView: View {
    @Environment(AppModel.self) private var model
    let title: String
    let status: TaskStatus
    let tasks: [TaskItem]
    var onCollapse: (() -> Void)?
    @State private var isTargeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(title) (\(tasks.count))").font(.headline)
                Spacer()
                if let onCollapse {
                    Button("Einklappen", systemImage: "chevron.right", action: onCollapse)
                        .labelStyle(.iconOnly).buttonStyle(.borderless)
                }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        BoardCard(task: task)
                            .dropDestination(for: String.self) { items, _ in
                                drop(items, at: index)
                            }
                    }
                    if tasks.isEmpty {
                        Text("Hierher ziehen").foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 60)
                    }
                }
                .padding(.bottom, 40)
            }
        }
        .padding(10)
        .frame(minWidth: 240, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(isTargeted ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .dropDestination(for: String.self) { items, _ in
            drop(items, at: nil)
        } isTargeted: { isTargeted = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title), \(GermanText.count(tasks.count, "Aufgabe", "Aufgaben"))")
    }

    private func drop(_ items: [String], at index: Int?) -> Bool {
        let ids = items.compactMap(UUID.init(uuidString:))
        guard !ids.isEmpty else { return false }
        for id in ids { model.move(id, to: status, at: index) }
        return true
    }
}

struct BoardCard: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem
    @State private var showsWaiting = false
    @State private var showsCorrection = false

    var body: some View {
        NavigationLink(value: task.id) {
            TaskCard(task: task, showsStatus: false)
                .padding(10)
                .background(.background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        }
        .buttonStyle(.plain)
        .draggable(task.id.uuidString) {
            Text(task.title).padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        }
        .contextMenu {
            TaskActionsMenuContent(task: task, onWaiting: { showsWaiting = true }, onCorrection: { showsCorrection = true })
        }
        .sheet(isPresented: $showsWaiting) { WaitingSheet(task: task) }
        .sheet(isPresented: $showsCorrection) { CorrectionSheet(task: task) }
    }
}

struct CollapsedDoneColumn: View {
    let count: Int
    let expand: () -> Void

    var body: some View {
        Button(action: expand) {
            VStack(spacing: 6) {
                Image(systemName: "checkmark.circle")
                Text("Erledigt")
                Text("\(count)").font(.caption).foregroundStyle(.secondary)
            }
            .frame(width: 80)
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel("Erledigt, \(count), ausklappen")
    }
}
