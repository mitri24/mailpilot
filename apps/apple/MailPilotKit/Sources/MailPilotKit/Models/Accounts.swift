import Foundation

// Modelle aus packages/contracts/src/accounts.ts.

public enum IncrementalSyncKind: String, Codable, Sendable, Hashable {
    case gmailHistory = "gmail_history"
    case graphDelta = "graph_delta"
    case imapCondstore = "imap_condstore"
    case imapUid = "imap_uid"
    case none
}

/// Was der Server des Kontos tatsächlich anbietet (erkannt, nie angenommen).
public struct AccountCapabilities: Codable, Sendable, Hashable {
    public var incrementalSync: IncrementalSyncKind
    public var customKeywords: Bool
    public var flagged: Bool
    public var labels: Bool
    public var categories: Bool
    public var copyToFolder: Bool
    public var webLinks: Bool
    public var immutableIds: Bool
    public var supportedMarkers: [MarkerStrategy]
    /// Einschränkungen in deutscher Sprache.
    public var notes: [String]
}

public struct MarkerConfig: Codable, Sendable, Hashable {
    public var strategy: MarkerStrategy
    public var keyword: String?
    public var folder: String?
    public var acknowledgedLimitations: Bool

    public init(strategy: MarkerStrategy, keyword: String? = nil, folder: String? = nil, acknowledgedLimitations: Bool) {
        self.strategy = strategy
        self.keyword = keyword
        self.folder = folder
        self.acknowledgedLimitations = acknowledgedLimitations
    }

    enum CodingKeys: String, CodingKey { case strategy, keyword, folder, acknowledgedLimitations }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        strategy = try c.decode(MarkerStrategy.self, forKey: .strategy)
        keyword = try c.decodeIfPresent(String.self, forKey: .keyword)
        folder = try c.decodeIfPresent(String.self, forKey: .folder)
        acknowledgedLimitations = try c.decode(Bool.self, forKey: .acknowledgedLimitations)
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(strategy, forKey: .strategy)
        try c.encodeNullable(keyword, forKey: .keyword)
        try c.encodeNullable(folder, forKey: .folder)
        try c.encode(acknowledgedLimitations, forKey: .acknowledgedLimitations)
    }
}

public struct AccountError: Codable, Sendable, Hashable {
    public var code: String
    public var message: String
    public var at: Date
    public var action: String?
}

public struct Account: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var version: Int
    public var provider: Provider
    public var displayName: String
    public var emailAddress: String
    public var aliases: [String]
    public var status: AccountStatus
    public var capabilities: AccountCapabilities?
    public var marker: MarkerConfig
    /// `false`, wenn die Markierung in Apple Mail nicht zuverlässig sichtbar ist.
    public var markerReliable: Bool
    public var initialImportDays: Int
    public var includeSent: Bool
    public var lastSuccessfulFetchAt: Date?
    public var lastSuccessfulAnalysisAt: Date?
    public var pendingAnalysisCount: Int
    public var markerFailures: Int
    public var lastError: AccountError?
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: UUID = UUID(), version: Int = 1, provider: Provider, displayName: String, emailAddress: String, aliases: [String] = [],
                status: AccountStatus = .active, capabilities: AccountCapabilities? = nil,
                marker: MarkerConfig = MarkerConfig(strategy: .none, acknowledgedLimitations: false), markerReliable: Bool = true,
                initialImportDays: Int = 14, includeSent: Bool = true, lastSuccessfulFetchAt: Date? = nil, lastSuccessfulAnalysisAt: Date? = nil,
                pendingAnalysisCount: Int = 0, markerFailures: Int = 0, lastError: AccountError? = nil, createdAt: Date, updatedAt: Date? = nil) {
        self.id = id
        self.version = version
        self.provider = provider
        self.displayName = displayName
        self.emailAddress = emailAddress
        self.aliases = aliases
        self.status = status
        self.capabilities = capabilities
        self.marker = marker
        self.markerReliable = markerReliable
        self.initialImportDays = initialImportDays
        self.includeSent = includeSent
        self.lastSuccessfulFetchAt = lastSuccessfulFetchAt
        self.lastSuccessfulAnalysisAt = lastSuccessfulAnalysisAt
        self.pendingAnalysisCount = pendingAnalysisCount
        self.markerFailures = markerFailures
        self.lastError = lastError
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

public struct Folder: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var accountId: UUID
    public var name: String
    public var path: String
    public var role: FolderRole
    public var selected: Bool
}

public struct FolderList: Codable, Sendable {
    public var folders: [Folder]
}

public struct AccountList: Codable, Sendable {
    public var accounts: [Account]
}

public struct ImapAccountCreate: Codable, Sendable, Hashable {
    public var displayName: String
    public var emailAddress: String
    public var host: String
    public var port: Int
    /// Implizites TLS; sonst ist STARTTLS Pflicht.
    public var secure: Bool
    public var username: String
    /// App-spezifisches Passwort, wo der Anbieter es verlangt.
    public var password: String
    public var initialImportDays: Int

    public init(displayName: String, emailAddress: String, host: String, port: Int = 993, secure: Bool = true, username: String, password: String, initialImportDays: Int = 14) {
        self.displayName = displayName
        self.emailAddress = emailAddress
        self.host = host
        self.port = port
        self.secure = secure
        self.username = username
        self.password = password
        self.initialImportDays = initialImportDays
    }
}

public struct AccountPatch: Encodable, Sendable, Hashable {
    public enum RunState: String, Encodable, Sendable { case active, paused }

    public var displayName: String?
    public var status: RunState?
    public var aliases: [String]?
    public var initialImportDays: Int?
    public var includeSent: Bool?
    public var marker: MarkerConfig?

    public init(displayName: String? = nil, status: RunState? = nil, aliases: [String]? = nil, initialImportDays: Int? = nil, includeSent: Bool? = nil, marker: MarkerConfig? = nil) {
        self.displayName = displayName
        self.status = status
        self.aliases = aliases
        self.initialImportDays = initialImportDays
        self.includeSent = includeSent
        self.marker = marker
    }
}

public struct FolderSelection: Encodable, Sendable {
    public var selectedFolderIds: [UUID]
    public init(selectedFolderIds: [UUID]) { self.selectedFolderIds = selectedFolderIds }
}

public enum OAuthProvider: String, Codable, Sendable, CaseIterable {
    case gmail, microsoft
}

public struct OAuthStartRequest: Encodable, Sendable {
    public var loginHint: String?
    public var accountId: UUID?
    public var withMarker: Bool

    public init(loginHint: String? = nil, accountId: UUID? = nil, withMarker: Bool = false) {
        self.loginHint = loginHint
        self.accountId = accountId
        self.withMarker = withMarker
    }
}

public struct OAuthStart: Codable, Sendable {
    /// Als Text dekodiert; `URL(string:)` ist strenger als die Server-Prüfung.
    public var authorizationUrl: String
    public var state: String

    public var authorizationURL: URL? { URL(string: authorizationUrl) }
}

public struct AccountCheck: Codable, Sendable {
    public var ok: Bool
    public var capabilities: AccountCapabilities?
    public var problem: String?
    public var action: String?
}

public struct ScanStats: Codable, Sendable, Hashable {
    public var fetched: Int
    public var newMessages: Int
    public var updatedMessages: Int
    public var analyzed: Int
    public var tasksCreated: Int
    public var tasksUpdated: Int
    public var clarifications: Int
    public var skipped: Int
    public var budgetPaused: Int
    public var errors: Int
}

public struct ScanRun: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var accountId: UUID?
    public var kind: RunKind
    public var trigger: RunTrigger
    public var status: RunStatus
    public var startedAt: Date?
    public var finishedAt: Date?
    public var stats: ScanStats
    public var error: String?
    public var createdAt: Date
}

public struct ScanList: Codable, Sendable {
    public var runs: [ScanRun]
}

public struct ScanRequest: Encodable, Sendable {
    public var accountId: UUID?
    public init(accountId: UUID? = nil) { self.accountId = accountId }
}

public struct SetupSuggestion: Codable, Sendable, Hashable {
    public enum SuggestedProvider: String, Codable, Sendable { case gmail, microsoft, imap, unknown }
    public enum Confidence: String, Codable, Sendable { case known, probable, unknown }
    public struct ImapServer: Codable, Sendable, Hashable {
        public var host: String
        public var port: Int
        public var secure: Bool
    }

    public var provider: SuggestedProvider
    public var imap: ImapServer?
    public var confidence: Confidence
    public var notes: [String]
}
