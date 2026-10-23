import Foundation

/// Deep Links mit dem Schema `mailpilot` (auch Ziel der OAuth-Weiterleitung des Servers).
public enum DeepLink: Hashable, Sendable {
    case today
    case board
    case task(UUID)
    case clarifications
    case messages
    case accounts
    case account(UUID)
    /// `mailpilot://accounts/connected?accountId=…`
    case accountConnected(accountId: UUID?)
    /// `mailpilot://accounts/error?code=…`
    case accountError(code: String)
    case settings

    public static let scheme = "mailpilot"

    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // `mailpilot://tasks/<id>`: der erste Teil steht im Host.
        var parts = [components.host ?? ""] + components.path.split(separator: "/").map(String.init)
        parts = parts.filter { !$0.isEmpty }.map { $0.removingPercentEncoding ?? $0 }
        let query = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })

        switch parts.first?.lowercased() {
        case "today", nil: self = .today
        case "board": self = .board
        case "tasks" where parts.count == 1: self = .board
        case "tasks":
            guard parts.count == 2, let id = UUID(uuidString: parts[1]) else { return nil }
            self = .task(id)
        case "clarifications": self = .clarifications
        case "messages": self = .messages
        case "settings": self = .settings
        case "accounts":
            guard parts.count >= 2 else {
                self = .accounts
                return
            }
            switch parts[1].lowercased() {
            case "connected": self = .accountConnected(accountId: query["accountId"].flatMap(UUID.init(uuidString:)))
            case "error": self = .accountError(code: query["code"].flatMap { $0.isEmpty ? nil : $0 } ?? "unknown")
            default:
                guard let id = UUID(uuidString: parts[1]) else { return nil }
                self = .account(id)
            }
        default:
            return nil
        }
    }

    public var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        switch self {
        case .today: components.host = "today"
        case .board: components.host = "board"
        case .task(let id):
            components.host = "tasks"
            components.path = "/\(id.uuidString.lowercased())"
        case .clarifications: components.host = "clarifications"
        case .messages: components.host = "messages"
        case .settings: components.host = "settings"
        case .accounts: components.host = "accounts"
        case .account(let id):
            components.host = "accounts"
            components.path = "/\(id.uuidString.lowercased())"
        case .accountConnected(let accountId):
            components.host = "accounts"
            components.path = "/connected"
            if let accountId { components.queryItems = [URLQueryItem(name: "accountId", value: accountId.uuidString.lowercased())] }
        case .accountError(let code):
            components.host = "accounts"
            components.path = "/error"
            components.queryItems = [URLQueryItem(name: "code", value: code)]
        }
        return components.url!
    }

    /// Verständliche Meldung zu den Fehlercodes der OAuth-Weiterleitung (services/api/src/routes/accounts.ts).
    public static func accountErrorMessage(_ code: String) -> String {
        switch code {
        case "access_denied": return "Die Freigabe wurde beim Anbieter abgelehnt."
        case "missing_code": return "Der Anbieter hat die Anmeldung ohne Ergebnis beendet."
        case "not_configured": return "Diese Anmeldung ist auf dem Server nicht eingerichtet."
        case "state_invalid": return "Die Anmeldung ist abgelaufen oder wurde schon verwendet. Bitte erneut verbinden."
        case "exchange_failed": return "Der Anbieter hat die Anmeldung nicht bestätigt. Bitte erneut versuchen."
        default: return "Das Postfach konnte nicht verbunden werden (\(code))."
        }
    }
}
