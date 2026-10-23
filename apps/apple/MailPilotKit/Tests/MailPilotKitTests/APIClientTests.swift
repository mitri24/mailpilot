import Foundation
import Testing
@testable import MailPilotKit

@Suite("API-Client über Mock-URLProtocol")
struct APIClientTests {
    let session = StoredSession(token: "secret-token", expiresAt: date("2027-01-01T00:00:00Z"),
                                user: UserProfile(id: UUID(), displayName: nil, email: nil, devLogin: false, createdAt: date("2026-10-01T00:00:00Z")))

    func client(_ host: String, base: String? = nil, signedIn: Bool = true,
                handler: @escaping MockURLProtocol.Handler) -> APIClient {
        let urlSession = MockURLProtocol.session(host: host, handler: handler)
        return APIClient(baseURL: URL(string: base ?? "https://\(host)")!, tokenStore: InMemoryTokenStore(signedIn ? session : nil), session: urlSession)
    }

    static func json(_ string: String, status: Int = 200) -> (status: Int, body: Data) { (status, Data(string.utf8)) }

    @Test("Authorization: Bearer, Idempotency-Key, Methode, Pfad und JSON-Body")
    func headersAndBody() async throws {
        let host = "headers-\(UUID().uuidString.lowercased()).test"
        let detail = try Fixture.data("task-detail")
        let taskJSON = try JSONDecoder().decode(JSONValue.self, from: detail)
        guard case .object(let object) = taskJSON, let task = object["task"] else { Issue.record("Fixture"); return }
        let taskData = try JSONEncoder().encode(task)
        let api = client(host) { _ in (200, taskData) }
        let key = UUID(uuidString: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1")!
        let created = try await api.send(API.createTask(TaskCreate(title: "Formular abgeben", priority: .critical), idempotencyKey: key))
        #expect(created.title == "Studienbescheinigung an Claire schicken")

        let request = try #require(MockURLProtocol.recorded(host: host).first)
        #expect(request.method == "POST")
        #expect(request.url.path == "/v1/tasks")
        #expect(request.headers["Authorization"] == "Bearer secret-token")
        #expect(request.headers["Idempotency-Key"] == "dddddddd-dddd-4ddd-8ddd-ddddddddddd1")
        #expect(request.headers["Content-Type"] == "application/json")
        #expect(request.headers["Accept"] == "application/json")
        let body = try JSONDecoder().decode(JSONValue.self, from: try #require(request.body))
        #expect(body == .object(["title": .string("Formular abgeben"), "priority": .string("critical")]))
    }

    @Test("Wiederholung desselben Aufrufs verwendet denselben Idempotency-Key")
    func sameKeyOnRetry() async throws {
        let host = "retry-\(UUID().uuidString.lowercased()).test"
        let attempts = Locked(0)
        let api = client(host) { _ in
            let attempt = attempts.withLock { value -> Int in
                value += 1
                return value
            }
            if attempt == 1 { throw URLError(.networkConnectionLost) }
            return (200, Data(#"{"result":{"idempotencyKey":"dddddddd-dddd-4ddd-8ddd-ddddddddddd2","status":"applied","entityType":"note","entityId":"44444444-4444-4444-8444-444444444441","version":2,"conflictingFields":[],"createdEntityId":null,"error":null}}"#.utf8))
        }
        let key = UUID(uuidString: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2")!
        let endpoint = API.updateNote(UUID(uuidString: "44444444-4444-4444-8444-444444444441")!, baseVersion: 1, body: "Neu", idempotencyKey: key)
        await #expect(throws: APIError.transport(.networkConnectionLost)) { try await api.send(endpoint) }
        let result = try await api.send(endpoint)
        #expect(result.result.status == .applied)
        let recorded = MockURLProtocol.recorded(host: host)
        #expect(recorded.count == 2)
        #expect(recorded.map { $0.headers["Idempotency-Key"] } == [key.lowercased, key.lowercased])
        #expect(recorded[0].body == recorded[1].body)
        #expect(recorded[0].method == "PATCH")
        #expect(recorded[0].url.path == "/v1/notes/44444444-4444-4444-8444-444444444441")
    }

    @Test("Query: Cursor, strenge Kodierung von + und Umlauten, Zeitstempel")
    func queryEncoding() async throws {
        let host = "query-\(UUID().uuidString.lowercased()).test"
        let api = client(host) { request in
            if request.url.path == "/v1/sync/changes" { return Self.json(String(decoding: try Fixture.data("changes-delta"), as: UTF8.self)) }
            return Self.json(String(decoding: try Fixture.data("message-list"), as: UTF8.self))
        }
        let changes = try await api.send(API.changes(cursor: "1042"))
        #expect(changes.nextCursor == "1049")
        _ = try await api.send(API.messages(MessageQuery(search: "a+b ä", withoutTask: true, limit: 20, before: date("2026-10-23T10:00:00+02:00"))))
        let recorded = MockURLProtocol.recorded(host: host)
        #expect(recorded[0].url.query == "cursor=1042&limit=500")
        #expect(recorded[1].url.query == "search=a%2Bb%20%C3%A4&withoutTask=true&limit=20&before=2026-10-23T08%3A00%3A00.000Z")
        #expect(recorded[0].headers["Content-Type"] == nil)
    }

    @Test("Mutationsstapel: gespeicherte Bytes unverändert im Body")
    func rawMutationBody() async throws {
        let host = "batch-\(UUID().uuidString.lowercased()).test"
        let api = client(host) { _ in Self.json(#"{"results":[]}"#) }
        let first = Data(#"{"entityId":"a","type":"task.dismiss"}"#.utf8)
        let second = Data(#"{"entityId":"b","type":"task.restore"}"#.utf8)
        _ = try await api.pushMutations([first, second])
        let request = try #require(MockURLProtocol.recorded(host: host).first)
        #expect(request.url.path == "/v1/sync/mutations")
        #expect(request.body == Data(#"{"mutations":[{"entityId":"a","type":"task.dismiss"},{"entityId":"b","type":"task.restore"}]}"#.utf8))
    }

    @Test("Ohne Anmeldung: Anmeldeendpunkte ohne Token, alle anderen ohne Netzwerkaufruf abgelehnt")
    func authRequirements() async throws {
        let host = "auth-\(UUID().uuidString.lowercased()).test"
        let api = client(host, signedIn: false) { _ in Self.json(String(decoding: try Fixture.data("session"), as: UTF8.self)) }
        let session = try await api.send(API.devSignIn(DevSignIn(email: "dev@example.com")))
        #expect(session.user.devLogin)
        #expect(MockURLProtocol.recorded(host: host).first?.headers["Authorization"] == nil)
        await #expect(throws: APIError.notSignedIn) { try await api.send(API.today()) }
        #expect(MockURLProtocol.recorded(host: host).count == 1)
    }

    @Test("Fehlerabbildung: 401, 409 mit Fehlertext, Netzwerk, ungültige Antwort")
    func errorMapping() async throws {
        let host = "errors-\(UUID().uuidString.lowercased()).test"
        let api = client(host) { request in
            switch request.url.path {
            case "/v1/me": return Self.json(#"{"error":{"code":"unauthorized","message":"Anmeldung erforderlich"}}"#, status: 401)
            case "/v1/scans": return Self.json(#"{"error":{"code":"no_active_account","message":"Kein aktives Postfach verbunden"}}"#, status: 409)
            case "/v1/usage": throw URLError(.notConnectedToInternet)
            default: return Self.json(#"{"unerwartet":true}"#)
            }
        }
        do {
            _ = try await api.send(API.me())
            Issue.record("401 erwartet")
        } catch let error as APIError {
            #expect(error.isUnauthorized)
            #expect(error.message == "Anmeldung erforderlich")
        }
        do {
            _ = try await api.send(API.startScan())
            Issue.record("409 erwartet")
        } catch let error as APIError {
            #expect(error.serverCode == "no_active_account")
            #expect(error.message == "Kein aktives Postfach verbunden")
            #expect(!error.isRetryable)
        }
        do {
            _ = try await api.send(API.usage())
            Issue.record("Netzwerkfehler erwartet")
        } catch let error as APIError {
            #expect(error.isOffline)
            #expect(error.isRetryable)
            #expect(error.message.contains("Keine Internetverbindung"))
        }
        await #expect(throws: APIError.self) { try await api.send(API.settings()) }
    }

    @Test("Basis-URL mit Pfad und Schrägstrich")
    func baseURLWithPath() async throws {
        let host = "base-\(UUID().uuidString.lowercased()).test"
        let api = client(host, base: "https://\(host)/api/") { _ in Self.json(String(decoding: try Fixture.data("today"), as: UTF8.self)) }
        let today = try await api.send(API.today())
        #expect(today.pendingAnalysisCount == 12)
        #expect(MockURLProtocol.recorded(host: host).first?.url.absoluteString == "https://\(host)/api/v1/today")
    }
}
