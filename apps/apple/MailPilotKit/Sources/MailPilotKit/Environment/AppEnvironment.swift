import Foundation
import GRDB
import WidgetKit

/// Werte aus der Info.plist (gesetzt über Build-Settings in project.yml / Config/*.xcconfig).
public struct AppConfiguration: Sendable, Hashable {
    public static let apiBaseURLKey = "MailPilotAPIBaseURL"
    public static let appGroupKey = "MailPilotAppGroup"
    public static let keychainAccessGroupKey = "MailPilotKeychainAccessGroup"
    /// Nur in Entwicklungs-Builds: in den gemeinsamen Defaults überschriebene Server-URL.
    public static let debugAPIBaseURLKey = "debug.apiBaseURL"

    public var apiBaseURL: URL
    public var appGroupIdentifier: String?
    public var keychainAccessGroup: String?

    public init(apiBaseURL: URL, appGroupIdentifier: String? = nil, keychainAccessGroup: String? = nil) {
        self.apiBaseURL = apiBaseURL
        self.appGroupIdentifier = appGroupIdentifier
        self.keychainAccessGroup = keychainAccessGroup
    }

    /// Server-Standard aus services/api/src/config.ts (`PORT` 8787), falls nichts konfiguriert ist.
    public static let fallbackBaseURL = URL(string: "http://localhost:8787")!

    public static func fromBundle(_ bundle: Bundle = .main, allowDebugOverride: Bool) -> AppConfiguration {
        func value(_ key: String) -> String? {
            guard let raw = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            // Nicht ersetzte Build-Variablen wie "$(…)" gelten als nicht gesetzt.
            return trimmed.isEmpty || trimmed.contains("$(") ? nil : trimmed
        }
        let group = value(appGroupKey)
        var baseURL = value(apiBaseURLKey).flatMap(URL.init(string:)) ?? fallbackBaseURL
        if allowDebugOverride, let override = sharedDefaults(appGroup: group)?.string(forKey: debugAPIBaseURLKey),
           let url = URL(string: override), url.scheme != nil {
            baseURL = url
        }
        return AppConfiguration(apiBaseURL: baseURL, appGroupIdentifier: group, keychainAccessGroup: value(keychainAccessGroupKey))
    }

    public static func sharedDefaults(appGroup: String?) -> UserDefaults? {
        guard let appGroup, !appGroup.isEmpty else { return .standard }
        return UserDefaults(suiteName: appGroup)
    }
}

/// Gemeinsame Bausteine für App, Widget-Intents und Share Extension.
public final class AppEnvironment: Sendable {
    public let configuration: AppConfiguration
    public let store: LocalStore
    public let tokenStore: any TokenStore
    public let api: APIClient
    public let engine: SyncEngine
    public let scheduler: SyncScheduler
    private let reloadWidgets: @Sendable () -> Void
    private let clock: @Sendable () -> Date

    public init(configuration: AppConfiguration, store: LocalStore, tokenStore: any TokenStore, api: APIClient,
                transport: (any SyncTransport)? = nil, reloadWidgets: @escaping @Sendable () -> Void = {},
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.configuration = configuration
        self.store = store
        self.tokenStore = tokenStore
        self.api = api
        self.reloadWidgets = reloadWidgets
        self.clock = clock
        let snapshotRefresh = SnapshotRefresher(store: store, tokenStore: tokenStore, reloadWidgets: reloadWidgets, clock: clock)
        let engine = SyncEngine(
            store: store,
            transport: transport ?? api,
            clock: clock,
            isSignedIn: { (try? tokenStore.load()) != nil },
            didFinish: { _ in snapshotRefresh.refresh() }
        )
        self.engine = engine
        self.scheduler = SyncScheduler(engine: engine)
    }

    /// Echte Umgebung: Datei im App-Group-Container, Schlüsselbund mit Access Group, WidgetKit-Reload.
    public static func live(bundle: Bundle = .main, allowDebugOverride: Bool) throws -> AppEnvironment {
        let configuration = AppConfiguration.fromBundle(bundle, allowDebugOverride: allowDebugOverride)
        let location = LocalStore.databaseURL(appGroup: configuration.appGroupIdentifier)
        let store = try LocalStore.open(at: location.url, isShared: location.isShared)
        let tokenStore = KeychainTokenStore(accessGroup: configuration.keychainAccessGroup)
        let api = APIClient(baseURL: configuration.apiBaseURL, tokenStore: tokenStore)
        return AppEnvironment(configuration: configuration, store: store, tokenStore: tokenStore, api: api,
                              reloadWidgets: { WidgetCenter.shared.reloadAllTimelines() })
    }

    public var now: Date { clock() }

    public var session: StoredSession? { try? tokenStore.load() }
    public var isSignedIn: Bool { session != nil }

    public func actions(origin: OutboxOrigin) -> LocalActions {
        LocalActions(store: store, origin: origin, clock: clock)
    }

    /// Nach lokaler Änderung oder Synchronisierung: Snapshot schreiben und Widgets neu laden.
    public func refreshWidgetSnapshot() {
        SnapshotRefresher(store: store, tokenStore: tokenStore, reloadWidgets: reloadWidgets, clock: clock).refresh()
    }

    /// iOS: Datenbank vor dem Suspendieren freigeben (Sperren im App-Group-Container), siehe GRDB „Sharing a Database“.
    public func suspendDatabase() {
        NotificationCenter.default.post(name: Database.suspendNotification, object: nil)
    }

    public func resumeDatabase() {
        NotificationCenter.default.post(name: Database.resumeNotification, object: nil)
    }

    /// Nach erfolgreicher Anmeldung.
    public func signIn(with response: SessionResponse) throws {
        try store.prepare(forUser: response.user.id)
        try tokenStore.save(StoredSession(response))
        refreshWidgetSnapshot()
    }

    /// Abmelden: Sitzung serverseitig beenden (best effort), lokal alles löschen.
    public func signOut() async {
        _ = try? await api.send(API.logout())
        try? tokenStore.clear()
        try? store.wipeAll()
        refreshWidgetSnapshot()
    }
}

struct SnapshotRefresher: Sendable {
    let store: LocalStore
    let tokenStore: any TokenStore
    let reloadWidgets: @Sendable () -> Void
    let clock: @Sendable () -> Date

    func refresh() {
        let signedIn = (try? tokenStore.load()) != nil
        if let state = try? store.snapshot() {
            try? store.saveWidgetSnapshot(WidgetSnapshotBuilder.build(from: state, signedIn: signedIn, now: clock()))
        }
        reloadWidgets()
    }
}
