import CryptoKit
import Foundation
import Security

/// Sitzung, wie sie nach `POST /v1/auth/apple` bzw. `/v1/auth/dev` gespeichert wird.
public struct StoredSession: Codable, Sendable, Hashable {
    public var token: String
    public var expiresAt: Date
    public var user: UserProfile

    public init(token: String, expiresAt: Date, user: UserProfile) {
        self.token = token
        self.expiresAt = expiresAt
        self.user = user
    }

    public init(_ response: SessionResponse) {
        self.init(token: response.token, expiresAt: response.expiresAt, user: response.user)
    }

    public func isExpired(now: Date = Date()) -> Bool { expiresAt <= now }
}

public protocol TokenStore: Sendable {
    func load() throws -> StoredSession?
    func save(_ session: StoredSession) throws
    func clear() throws
}

/// Für Tests und Vorschauen.
public final class InMemoryTokenStore: TokenStore {
    private let storage: Locked<StoredSession?>

    public init(_ session: StoredSession? = nil) {
        storage = Locked(session)
    }

    public func load() throws -> StoredSession? { storage.current }
    public func save(_ session: StoredSession) throws { storage.set(session) }
    public func clear() throws { storage.set(nil) }
}

public struct KeychainError: Error, Sendable, Equatable, CustomStringConvertible {
    public let status: OSStatus
    public init(_ status: OSStatus) { self.status = status }
    public var description: String {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "unbekannt"
        return "Keychain-Fehler \(status): \(message)"
    }
}

/// Sitzungstoken im Schlüsselbund. Mit Access Group lesen auch Widget und Share Extension;
/// auf macOS wird der Data-Protection-Keychain verwendet (wie auf iOS, braucht signierte App mit Entitlement).
public final class KeychainTokenStore: TokenStore {
    public let service: String
    public let account: String
    public let accessGroup: String?

    public init(service: String = "MailPilot.session", account: String = "current", accessGroup: String?) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup, !accessGroup.isEmpty {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    public func load() throws -> StoredSession? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { return nil }
            return try APIJSON.decode(StoredSession.self, from: data)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(status)
        }
    }

    public func save(_ session: StoredSession) throws {
        let data = try APIJSON.encode(session)
        // Nach dem ersten Entsperren lesbar (Widget), nicht in Backups auf andere Geräte.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery()
            add.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status)
        }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status) }
    }
}

/// Nonce für Sign in with Apple: Rohwert an den Server, SHA-256 (hex) in die Apple-Anfrage.
public enum AppleSignInNonce {
    /// base64url-Alphabet: 64 Zeichen, daher ohne Modulo-Verzerrung.
    static let charset = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    public static func random(length: Int = 32) -> String {
        precondition(length > 0)
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // Fällt auf den systemweiten Zufallsgenerator zurück (ebenfalls kryptographisch sicher).
            var generator = SystemRandomNumberGenerator()
            for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255, using: &generator) }
        }
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    public static func sha256Hex(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { byte in
            let hex = String(byte, radix: 16)
            return byte < 16 ? "0" + hex : hex
        }.joined()
    }
}
