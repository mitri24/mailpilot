import Foundation

// Modelle aus packages/contracts/src/messages.ts.

public struct MailAddress: Codable, Sendable, Hashable {
    public var name: String?
    public var address: String

    public var display: String {
        if let name, !name.isEmpty { return "\(name) <\(address)>" }
        return address
    }
}

public struct AttachmentMeta: Codable, Sendable, Hashable {
    public var filename: String?
    public var contentType: String?
    public var size: Int?
    public var inline: Bool
}

public struct MessageSummary: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var accountId: UUID
    public var subject: String?
    public var from: MailAddress?
    public var sentAt: Date?
    public var snippet: String?
    public var language: String?
    public var hasAttachments: Bool
    public var analysisStatus: AnalysisStatus
    public var taskIds: [UUID]
    public var folders: [String]
    public var deleted: Bool
}

/// Wege zur Originalmail. Die sichere Ansicht ist immer verfügbar; Apple Mail wird nie als garantiert behauptet.
public struct OpenOriginal: Codable, Sendable, Hashable {
    public struct SearchHints: Codable, Sendable, Hashable {
        public var from: String?
        public var subject: String?
        public var date: String?
        public var messageIdHeader: String?
    }

    public var webLink: String?
    /// `message://`-URL; nur angeboten, wo der Server sie für sinnvoll hält.
    public var appleMailUrl: String?
    public var appleMailNote: String
    public var searchHints: SearchHints

    public var webLinkURL: URL? {
        guard let webLink, let url = URL(string: webLink), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return url
    }

    public var appleMailURL: URL? {
        guard let appleMailUrl, let url = URL(string: appleMailUrl), url.scheme?.lowercased() == "message" else { return nil }
        return url
    }
}

public struct MessageDetail: Codable, Sendable, Hashable {
    public var message: MessageSummary
    public var to: [MailAddress]
    public var cc: [MailAddress]
    /// Klartext ohne Remote-Inhalte; garantierte Darstellung.
    public var bodyText: String
    /// Bereinigtes HTML ohne Skripte und Remote-Bilder.
    public var bodyHtml: String?
    public var remoteContentBlocked: Int
    public var attachments: [AttachmentMeta]
    public var open: OpenOriginal
    public var markerStatus: MarkerStatus
}

public struct MessageList: Codable, Sendable {
    public var messages: [MessageSummary]
}

public struct MessageToTask: Encodable, Sendable, Hashable {
    public var title: String?
    /// Mail mit bestehender Aufgabe verknüpfen statt neu anzulegen.
    public var linkToTaskId: UUID?

    public init(title: String? = nil, linkToTaskId: UUID? = nil) {
        self.title = title
        self.linkToTaskId = linkToTaskId
    }
}

public struct MessageQuery: Sendable, Hashable {
    public var search: String?
    public var accountId: UUID?
    public var withoutTask: Bool?
    public var limit: Int
    public var before: Date?

    public init(search: String? = nil, accountId: UUID? = nil, withoutTask: Bool? = nil, limit: Int = 50, before: Date? = nil) {
        self.search = search
        self.accountId = accountId
        self.withoutTask = withoutTask
        self.limit = limit
        self.before = before
    }
}
