import MailPilotKit
import MailPilotUI
import SwiftUI

enum MoreRoute: Hashable {
    case accounts
}

/// iPhone: Tabs; Aufgaben öffnen sich im jeweiligen Navigationsstapel.
struct PhoneRootView: View {
    @Environment(AppModel.self) private var model
    @State private var todayPath = NavigationPath()
    @State private var settingsPath = NavigationPath()

    private var tabSelection: Binding<AppSection> {
        Binding(get: { model.section == .accounts ? .settings : model.section }, set: { model.section = $0 })
    }

    var body: some View {
        TabView(selection: tabSelection) {
            NavigationStack(path: $todayPath) {
                TodayView().taskDestinations()
            }
            .tabItem { Label(AppSection.today.title, systemImage: AppSection.today.systemImage) }
            .tag(AppSection.today)

            NavigationStack {
                PhoneBoardView().taskDestinations()
            }
            .tabItem { Label(AppSection.board.title, systemImage: AppSection.board.systemImage) }
            .tag(AppSection.board)

            NavigationStack {
                ClarificationsView().taskDestinations()
            }
            .tabItem { Label(AppSection.clarifications.title, systemImage: AppSection.clarifications.systemImage) }
            .badge(model.state.openClarifications.count)
            .tag(AppSection.clarifications)

            NavigationStack {
                MessagesView().taskDestinations()
            }
            .tabItem { Label(AppSection.messages.title, systemImage: AppSection.messages.systemImage) }
            .tag(AppSection.messages)

            NavigationStack(path: $settingsPath) {
                SettingsView()
                    .taskDestinations()
                    .navigationDestination(for: MoreRoute.self) { _ in AccountsView() }
            }
            .tabItem { Label(AppSection.settings.title, systemImage: AppSection.settings.systemImage) }
            .tag(AppSection.settings)
        }
        .onChange(of: model.deepLinkTaskId) { _, id in
            guard let id else { return }
            model.deepLinkTaskId = nil
            Task { todayPath = NavigationPath([id]) }
        }
        .onChange(of: model.section) { _, section in
            if section == .accounts, settingsPath.isEmpty { settingsPath.append(MoreRoute.accounts) }
        }
    }
}

extension View {
    func taskDestinations() -> some View {
        navigationDestination(for: UUID.self) { TaskDetailView(taskId: $0) }
    }
}

/// iPhone-Board: Spalte wählen, Statusbuttons an jeder Karte, Erledigt eingeklappt; kein Drag-and-drop nötig.
struct PhoneBoardView: View {
    @Environment(AppModel.self) private var model
    @State private var column: TaskStatus = .todo
    @State private var showsDone = false

    var body: some View {
        @Bindable var model = model
        let board = model.board
        List {
            Section {
                BoardFilterBar()
                Picker("Spalte", selection: $column) {
                    Text("To Do (\(board.todo.count))").tag(TaskStatus.todo)
                    Text("Doing (\(board.doing.count))").tag(TaskStatus.doing)
                }
                .pickerStyle(.segmented)
            }
            Section {
                let tasks = board[column]
                if tasks.isEmpty {
                    Text(model.boardFilter.isActive ? "Keine Aufgabe passt zum Filter." : "Leer.").foregroundStyle(.secondary)
                }
                ForEach(tasks) { TaskRow(task: $0, showsStatusButtons: true) }
                    .onMove { offsets, destination in
                        guard let from = offsets.first else { return }
                        let id = tasks[from].id
                        model.reorder(id, in: tasks, to: destination > from ? destination - 1 : destination)
                    }
                if board.snoozedHidden > 0 {
                    Text("\(GermanText.count(board.snoozedHidden, "Aufgabe", "Aufgaben")) später angezeigt (Filter „Später angezeigte“).")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section {
                DisclosureGroup("Erledigt (\(board.done.count))", isExpanded: $showsDone) {
                    ForEach(board.done) { TaskRow(task: $0, showsStatusButtons: true) }
                }
            }
        }
        .navigationTitle("Board")
        .searchable(text: $model.boardFilter.search, prompt: "Aufgaben durchsuchen")
        .refreshable { await model.syncNow() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { EditButton() }
            ToolbarItem(placement: .primaryAction) {
                Button("Neue Aufgabe", systemImage: "plus") { model.isComposingTask = true }
            }
        }
    }
}
