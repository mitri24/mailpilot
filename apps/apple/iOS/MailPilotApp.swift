import MailPilotKit
import MailPilotUI
import SwiftUI
import UIKit

@main
struct MailPilotPhoneApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel

    init() {
        #if DEBUG
        let model = AppModel.live(developerMode: true, pushEnvironment: .sandbox)
        #else
        let model = AppModel.live(developerMode: false, pushEnvironment: .production)
        #endif
        model.registerForRemoteNotifications = { UIApplication.shared.registerForRemoteNotifications() }
        PushAppDelegate.onToken = { token in Task { await model.didRegisterForPush(token: token) } }
        _model = State(initialValue: model)
    }

    var body: some Scene {
        WindowGroup {
            RootView { PhoneRootView() }
                .environment(model)
                .onOpenURL { model.open($0) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await model.becameActive() }
            case .background: model.movedToBackground()
            default: break
            }
        }
    }
}

/// APNs ist optional: ohne Token bleibt die App vollständig nutzbar.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    @MainActor static var onToken: ((Data) -> Void)?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.onToken?(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // Ohne Push-Entitlement oder im Simulator: nichts zu tun.
    }
}
