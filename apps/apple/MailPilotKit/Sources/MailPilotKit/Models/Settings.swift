import Foundation

// Modelle aus packages/contracts/src/settings.ts und primitives.ts.
// `Settings` heißt hier `UserSettings`, damit es nicht mit der SwiftUI-Szene `Settings` kollidiert.

public struct UserSettings: Codable, Sendable, Hashable {
    public var version: Int
    /// IANA-Zone, z. B. Europe/Paris.
    public var timezone: String
    public var scanEnabled: Bool
    /// Täglicher Scan, Ortszeit `HH:MM`.
    public var scanTime: String
    public var extraScanIntervalMinutes: Int?
    public var aiMonthlyBudgetCents: Int
    public var maxMessageChars: Int
    public var maxAttachmentBytes: Int
    public var notifyDailyDigest: Bool
    public var notifyUrgentDeadlines: Bool
    public var notifyClarifications: Bool
    public var quietHoursStart: String?
    public var quietHoursEnd: String?

    public init(version: Int = 1, timezone: String = "Europe/Paris", scanEnabled: Bool = true, scanTime: String = "07:00", extraScanIntervalMinutes: Int? = nil,
                aiMonthlyBudgetCents: Int = 500, maxMessageChars: Int = 20_000, maxAttachmentBytes: Int = 5_000_000, notifyDailyDigest: Bool = false,
                notifyUrgentDeadlines: Bool = false, notifyClarifications: Bool = false, quietHoursStart: String? = nil, quietHoursEnd: String? = nil) {
        self.version = version
        self.timezone = timezone
        self.scanEnabled = scanEnabled
        self.scanTime = scanTime
        self.extraScanIntervalMinutes = extraScanIntervalMinutes
        self.aiMonthlyBudgetCents = aiMonthlyBudgetCents
        self.maxMessageChars = maxMessageChars
        self.maxAttachmentBytes = maxAttachmentBytes
        self.notifyDailyDigest = notifyDailyDigest
        self.notifyUrgentDeadlines = notifyUrgentDeadlines
        self.notifyClarifications = notifyClarifications
        self.quietHoursStart = quietHoursStart
        self.quietHoursEnd = quietHoursEnd
    }

    public var timeZone: TimeZone? { TimeZone(identifier: timezone) }
    public var wantsAnyNotification: Bool { notifyDailyDigest || notifyUrgentDeadlines || notifyClarifications }
}

/// `PATCH /v1/settings`: alle Felder optional, die mit `null` erlaubten dreiwertig.
public struct SettingsPatch: Encodable, Sendable, Hashable {
    public var timezone: String?
    public var scanEnabled: Bool?
    public var scanTime: String?
    public var extraScanIntervalMinutes: FieldUpdate<Int>
    public var aiMonthlyBudgetCents: Int?
    public var maxMessageChars: Int?
    public var maxAttachmentBytes: Int?
    public var notifyDailyDigest: Bool?
    public var notifyUrgentDeadlines: Bool?
    public var notifyClarifications: Bool?
    public var quietHoursStart: FieldUpdate<String>
    public var quietHoursEnd: FieldUpdate<String>

    public init(timezone: String? = nil, scanEnabled: Bool? = nil, scanTime: String? = nil, extraScanIntervalMinutes: FieldUpdate<Int> = .unchanged,
                aiMonthlyBudgetCents: Int? = nil, maxMessageChars: Int? = nil, maxAttachmentBytes: Int? = nil, notifyDailyDigest: Bool? = nil,
                notifyUrgentDeadlines: Bool? = nil, notifyClarifications: Bool? = nil, quietHoursStart: FieldUpdate<String> = .unchanged,
                quietHoursEnd: FieldUpdate<String> = .unchanged) {
        self.timezone = timezone
        self.scanEnabled = scanEnabled
        self.scanTime = scanTime
        self.extraScanIntervalMinutes = extraScanIntervalMinutes
        self.aiMonthlyBudgetCents = aiMonthlyBudgetCents
        self.maxMessageChars = maxMessageChars
        self.maxAttachmentBytes = maxAttachmentBytes
        self.notifyDailyDigest = notifyDailyDigest
        self.notifyUrgentDeadlines = notifyUrgentDeadlines
        self.notifyClarifications = notifyClarifications
        self.quietHoursStart = quietHoursStart
        self.quietHoursEnd = quietHoursEnd
    }

    enum CodingKeys: String, CodingKey {
        case timezone, scanEnabled, scanTime, extraScanIntervalMinutes, aiMonthlyBudgetCents, maxMessageChars, maxAttachmentBytes
        case notifyDailyDigest, notifyUrgentDeadlines, notifyClarifications, quietHoursStart, quietHoursEnd
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(timezone, forKey: .timezone)
        try c.encodeIfPresent(scanEnabled, forKey: .scanEnabled)
        try c.encodeIfPresent(scanTime, forKey: .scanTime)
        try c.encodeUpdate(extraScanIntervalMinutes, forKey: .extraScanIntervalMinutes)
        try c.encodeIfPresent(aiMonthlyBudgetCents, forKey: .aiMonthlyBudgetCents)
        try c.encodeIfPresent(maxMessageChars, forKey: .maxMessageChars)
        try c.encodeIfPresent(maxAttachmentBytes, forKey: .maxAttachmentBytes)
        try c.encodeIfPresent(notifyDailyDigest, forKey: .notifyDailyDigest)
        try c.encodeIfPresent(notifyUrgentDeadlines, forKey: .notifyUrgentDeadlines)
        try c.encodeIfPresent(notifyClarifications, forKey: .notifyClarifications)
        try c.encodeUpdate(quietHoursStart, forKey: .quietHoursStart)
        try c.encodeUpdate(quietHoursEnd, forKey: .quietHoursEnd)
    }
}

public struct Usage: Codable, Sendable, Hashable {
    /// `YYYY-MM`
    public var month: String
    public var spentCents: Double
    public var budgetCents: Int
    public var budgetReached: Bool
    public var pendingAnalysisCount: Int
    public var analyzedThisMonth: Int
    public var inputTokens: Int
    public var outputTokens: Int
}

public struct UserProfile: Codable, Sendable, Hashable {
    public var id: UUID
    public var displayName: String?
    public var email: String?
    public var devLogin: Bool
    public var createdAt: Date
}

public struct SessionResponse: Codable, Sendable {
    public var token: String
    public var expiresAt: Date
    public var user: UserProfile
}

public struct AppleSignIn: Encodable, Sendable {
    public var identityToken: String
    /// Rohwert; das Token enthält seinen SHA-256-Hash.
    public var nonce: String
    public var deviceName: String?
    public var platform: ClientPlatform?
    public var fullName: String?

    public init(identityToken: String, nonce: String, deviceName: String? = nil, platform: ClientPlatform? = .current, fullName: String? = nil) {
        self.identityToken = identityToken
        self.nonce = nonce
        self.deviceName = deviceName
        self.platform = platform
        self.fullName = fullName
    }
}

public struct DevSignIn: Encodable, Sendable {
    public var email: String
    public var deviceName: String?
    public var platform: ClientPlatform?

    public init(email: String, deviceName: String? = nil, platform: ClientPlatform? = .current) {
        self.email = email
        self.deviceName = deviceName
        self.platform = platform
    }
}

public struct PushRegistration: Encodable, Sendable {
    public enum Environment: String, Encodable, Sendable { case sandbox, production }

    public var token: String
    public var environment: Environment
    public var platform: ClientPlatform

    public init(token: String, environment: Environment, platform: ClientPlatform = .current) {
        self.token = token
        self.environment = environment
        self.platform = platform
    }
}

public struct ErrorBody: Codable, Sendable, Hashable {
    public struct Detail: Codable, Sendable, Hashable {
        public var code: String
        public var message: String
        public var details: JSONValue?
    }

    public var error: Detail
}

public struct OKResponse: Codable, Sendable {
    public var ok: Bool
}
