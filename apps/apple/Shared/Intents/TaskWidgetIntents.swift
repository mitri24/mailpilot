import AppIntents
import Foundation
import MailPilotKit

// Wird in App und Widget-Extension kompiliert (project.yml), damit die Intents dort ausführbar sind,
// wo `Button(intent:)` sie auslöst. Die Logik liegt in MailPilotKit (LocalActions, getestet).

/// „Erledigt“ aus dem Widget.
struct CompleteTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Aufgabe erledigen"
    static let description: IntentDescription? = IntentDescription("Markiert eine MailPilot-Aufgabe als erledigt.")
    static let isDiscoverable = false

    @Parameter(title: "Aufgabe") var taskID: String

    init() {}

    init(taskID: UUID) {
        self.taskID = taskID.lowercased
    }

    func perform() async throws -> some IntentResult {
        await WidgetIntentRunner.setStatus(.done, taskID: taskID)
        return .result()
    }
}

/// „Starten“ (Doing) aus dem Widget.
struct StartTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Aufgabe starten"
    static let description: IntentDescription? = IntentDescription("Setzt eine MailPilot-Aufgabe auf Doing.")
    static let isDiscoverable = false

    @Parameter(title: "Aufgabe") var taskID: String

    init() {}

    init(taskID: UUID) {
        self.taskID = taskID.lowercased
    }

    func perform() async throws -> some IntentResult {
        await WidgetIntentRunner.setStatus(.doing, taskID: taskID)
        return .result()
    }
}

enum WidgetIntentRunner {
    #if DEBUG
    static let allowDebugOverride = true
    #else
    static let allowDebugOverride = false
    #endif

    /// Schreibt in die gemeinsame Outbox, aktualisiert den Snapshot sofort und versucht kurz zu synchronisieren.
    /// Scheitert das (offline, Zeitlimit), überträgt die App die Änderung später mit demselben Idempotency-Key.
    static func setStatus(_ status: TaskStatus, taskID: String) async {
        guard let id = UUID(uuidString: taskID),
              let environment = try? AppEnvironment.live(allowDebugOverride: allowDebugOverride),
              environment.isSignedIn else { return }
        do {
            try environment.actions(origin: .widget).setStatus(status, taskId: id)
        } catch {
            // Aufgabe lokal nicht vorhanden: der nächste App-Start zeigt den aktuellen Stand.
        }
        environment.refreshWidgetSnapshot()
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = await environment.engine.sync() }
            group.addTask { try? await Task.sleep(for: .seconds(6)) }
            await group.next()
            group.cancelAll()
        }
    }
}
