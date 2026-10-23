import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", patch = "PATCH", put = "PUT", delete = "DELETE"
}

public enum RequestBody: Sendable {
    case json(any Encodable & Sendable)
    /// Bereits kodierte Bytes (z. B. Outbox-Mutationen, die unverändert wiederholt werden müssen).
    case raw(Data)
}

/// Beschreibung eines Aufrufs; die Antwort wird als `Response` dekodiert.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod
    public var path: String
    public var query: [(String, String)]
    public var body: RequestBody?
    public var idempotencyKey: UUID?
    public var requiresAuth: Bool
    public var timeout: TimeInterval?

    public init(_ method: HTTPMethod, _ path: String, query: [(String, String)] = [], body: RequestBody? = nil,
                idempotencyKey: UUID? = nil, requiresAuth: Bool = true, timeout: TimeInterval? = nil) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.idempotencyKey = idempotencyKey
        self.requiresAuth = requiresAuth
        self.timeout = timeout
    }
}

public enum APIError: Error, Sendable, Equatable {
    /// Kein Netz, Zeitüberschreitung, Server nicht erreichbar.
    case transport(URLError.Code)
    case notSignedIn
    case unauthorized(ErrorBody?)
    case http(status: Int, body: ErrorBody?)
    case decoding(String)
    case invalidResponse

    public var isOffline: Bool {
        if case .transport = self { return true }
        return false
    }

    public var isUnauthorized: Bool {
        switch self {
        case .unauthorized, .notSignedIn: return true
        default: return false
        }
    }

    /// Wiederholen lohnt sich (mit denselben Idempotency-Keys).
    public var isRetryable: Bool {
        switch self {
        case .transport: return true
        case .http(let status, _): return status >= 500 || status == 429 || status == 408
        default: return false
        }
    }

    public var serverCode: String? {
        switch self {
        case .unauthorized(let body), .http(_, let body): return body?.error.code
        default: return nil
        }
    }

    /// Deutsche Meldung für die Oberfläche.
    public var message: String {
        switch self {
        case .transport(let code):
            switch code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return "Keine Internetverbindung. Änderungen werden später übertragen."
            case .timedOut:
                return "Der Server antwortet nicht rechtzeitig."
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return "Der Server ist nicht erreichbar."
            default:
                return "Verbindung zum Server fehlgeschlagen."
            }
        case .notSignedIn:
            return "Nicht angemeldet."
        case .unauthorized(let body):
            return body?.error.message ?? "Die Anmeldung ist abgelaufen. Bitte erneut anmelden."
        case .http(let status, let body):
            if let message = body?.error.message { return message }
            return status >= 500 ? "Der Server hat einen Fehler gemeldet (\(status))." : "Die Anfrage wurde abgelehnt (\(status))."
        case .decoding:
            return "Die Antwort des Servers passt nicht zu dieser App-Version."
        case .invalidResponse:
            return "Ungültige Antwort vom Server."
        }
    }
}

/// HTTP-Client für die MailPilot-API (URLSession, Swift Concurrency).
public final class APIClient: Sendable {
    private let baseURLStore: Locked<URL>
    private let session: URLSession
    private let tokenStore: any TokenStore

    public init(baseURL: URL, tokenStore: any TokenStore, session: URLSession = APIClient.defaultSession()) {
        self.baseURLStore = Locked(baseURL)
        self.tokenStore = tokenStore
        self.session = session
    }

    public static func defaultSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }

    public var baseURL: URL { baseURLStore.current }

    /// Nur für Entwicklungs-Builds (Server-URL in den Einstellungen).
    public func setBaseURL(_ url: URL) { baseURLStore.set(url) }

    public func makeRequest<R>(_ endpoint: Endpoint<R>) throws -> URLRequest {
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        let path = endpoint.path.hasPrefix("/") ? endpoint.path : "/" + endpoint.path
        guard var components = URLComponents(string: base + path) else { throw APIError.invalidResponse }
        if !endpoint.query.isEmpty {
            components.percentEncodedQuery = endpoint.query
                .map { "\(Self.encodeQuery($0.0))=\(Self.encodeQuery($0.1))" }
                .joined(separator: "&")
        }
        guard let url = components.url else { throw APIError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let timeout = endpoint.timeout { request.timeoutInterval = timeout }
        if endpoint.requiresAuth {
            guard let token = try tokenStore.load()?.token, !token.isEmpty else { throw APIError.notSignedIn }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let key = endpoint.idempotencyKey {
            request.setValue(key.uuidString.lowercased(), forHTTPHeaderField: "Idempotency-Key")
        }
        switch endpoint.body {
        case .json(let value)?:
            request.httpBody = try APIJSON.encoder().encode(value)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        case .raw(let data)?:
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        case nil:
            break
        }
        return request
    }

    public func send<R>(_ endpoint: Endpoint<R>) async throws -> R {
        let request = try makeRequest(endpoint)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw APIError.transport(error.code)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let decoder = APIJSON.decoder()
        switch http.statusCode {
        case 200..<300:
            do {
                return try decoder.decode(R.self, from: data)
            } catch {
                throw APIError.decoding(String(describing: error))
            }
        case 401:
            throw APIError.unauthorized(try? decoder.decode(ErrorBody.self, from: data))
        default:
            throw APIError.http(status: http.statusCode, body: try? decoder.decode(ErrorBody.self, from: data))
        }
    }

    /// Strenge Prozentkodierung: `+` bedeutet im Query sonst Leerzeichen.
    static func encodeQuery(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    /// Nur ASCII-Zeichen ohne Sonderbedeutung (RFC 3986 „unreserved“).
    static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}
