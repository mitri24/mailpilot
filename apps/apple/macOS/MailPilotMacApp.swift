import AppKit
import MailPilotKit
import MailPilotUI
import SwiftUI

@main
struct MailPilotMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel

    init() {
        #if DEBUG
        let model = AppModel.live(developerMode: true, pushEnvironment: .sandbox)
        #else
        let model = AppModel.live(developerMode: false, pushEnvironment: .production)
        #endif
        model.registerForRemoteNotifications = { NSApplication.shared.registerForRemoteNotifications() }
        MacAppDelegate.onToken = { token in Task { await model.didRegisterForPush(token: token) } }
        _model = State(initialValue: model)
    }

    var body: some Scene {
        WindowGroup("MailPilot", id: "main") {
            RootView { MacRootView() }
                .environment(model)
                .onOpenURL { model.open($0) }
                .frame(minWidth: 860, minHeight: 560)
        }
        .commands { MailPilotCommands(model: model) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.becameActive() } }
            if phase == .background { model.movedToBackground() }
        }

        Settings {
            NavigationStack { SettingsView() }
                .environment(model)
                .frame(minWidth: 520, minHeight: 600)
        }
    }
}

final class MacAppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static var onToken: ((Data) -> Void)?

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.onToken?(deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // Push ist optional; die App funktioniert ohne.
    }
}

/// Tastaturbedienung: Bereiche (⌘1–⌘6), neue Aufgabe (⌘N), Aktualisieren (⌘R), Aktionen für die geöffnete Aufgabe.
struct MailPilotCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Neue Aufgabe") { model.isComposingTask = true }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(after: .toolbar) {
            Button("Aktualisieren") { Task { await model.syncNow() } }
                .keyboardShortcut("r", modifiers: .command)
        }
        CommandMenu("Gehe zu") {
            ForEach(Array(AppSection.allCases.enumerated()), id: \.element) { index, section in
                Button(section.title) { model.section = section }
                    .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }
        }
        CommandMenu("Aufgabe") {
            let task = model.selectedTaskId.flatMap { model.task($0) }
            Button("Starten") { if let task { model.setStatus(.doing, for: task.id) } }
                .keyboardShortcut("s", modifiers: [.command, .shift])
                .disabled(task?.status != .todo)
            Button("Erledigt") { if let task { model.setStatus(.done, for: task.id) } }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(task?.isOpen != true)
            Button("Auf morgen verschieben") { if let task { model.postponeToTomorrow(task.id) } }
                .keyboardShortcut("t", modifiers: [.command, .option])
                .disabled(task?.isOpen != true)
            Button("Heute einplanen") { if let task { model.planForToday(task.id) } }
                .keyboardShortcut("h", modifiers: [.command, .option])
                .disabled(task?.isOpen != true)
            Divider()
            Button("Nicht relevant") { if let task { model.dismiss(task.id) } }
                .keyboardShortcut(.delete, modifiers: .command)
                .disabled(task == nil || task?.status == .dismissed)
        }
    }
}
