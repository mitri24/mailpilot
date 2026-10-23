import Foundation

// Modelle aus packages/contracts/src/clarifications.ts.

public struct ClarificationOption: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var label: String
    /// Ob diese Antwort eine dauerhafte Zuordnung werden darf.
    public var scope: AnswerScope

    public init(id: String, label: String, scope: AnswerScope) {
        self.id = id
        self.label = label
        self.scope = scope
    }

    /// Der Server lässt die Rückfrage bei dieser Antwort offen.
    public var isDeferral: Bool { id == ClarificationOption.laterId }
    public static let laterId = "later"
}

public struct ClarificationAnswerRecord: Codable, Sendable, Hashable {
    public var optionId: String?
    public var text: String?
    public var scope: AnswerScope
    public var answeredAt: Date

    public init(optionId: String?, text: String?, scope: AnswerScope, answeredAt: Date) {
        self.optionId = optionId
        self.text = text
        self.scope = scope
        self.answeredAt = answeredAt
    }
}

public struct Clarification: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var version: Int
    public var kind: ClarificationKind
    public var status: ClarificationStatus
    public var question: String
    /// Warum die Information benötigt wird.
    public var reason: String
    public var excerpt: String?
    public var options: [ClarificationOption]
    public var allowFreeText: Bool
    public var taskId: UUID?
    public var messageId: UUID?
    public var answer: ClarificationAnswerRecord?
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: UUID = UUID(), version: Int = 1, kind: ClarificationKind, status: ClarificationStatus = .open, question: String, reason: String,
                excerpt: String? = nil, options: [ClarificationOption], allowFreeText: Bool = false, taskId: UUID? = nil, messageId: UUID? = nil,
                answer: ClarificationAnswerRecord? = nil, createdAt: Date, updatedAt: Date? = nil) {
        self.id = id
        self.version = version
        self.kind = kind
        self.status = status
        self.question = question
        self.reason = reason
        self.excerpt = excerpt
        self.options = options
        self.allowFreeText = allowFreeText
        self.taskId = taskId
        self.messageId = messageId
        self.answer = answer
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }
}

public struct ClarificationList: Codable, Sendable {
    public var clarifications: [Clarification]
}

public struct ClarificationAnswer: Encodable, Sendable, Hashable {
    public var optionId: String?
    public var text: String?
    public var scope: AnswerScope

    public init(optionId: String? = nil, text: String? = nil, scope: AnswerScope = .once) {
        self.optionId = optionId
        self.text = text
        self.scope = scope
    }

    enum CodingKeys: String, CodingKey { case optionId, text, scope }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeNullable(optionId, forKey: .optionId)
        try c.encodeNullable(text, forKey: .text)
        try c.encode(scope, forKey: .scope)
    }
}

public struct ClarificationAnswerResponse: Codable, Sendable {
    public var result: MutationResult
    public var clarification: Clarification?
}

public enum RuleKind: String, Codable, Sendable, Hashable {
    case membership
    case senderRelevance = "sender_relevance"
    case ignoreSender = "ignore_sender"
    case responsibility
}

public struct Rule: Codable, Sendable, Hashable, Identifiable {
    public struct Value: Codable, Sendable, Hashable {
        public var applies: Bool
        public var note: String?
    }

    public var id: UUID
    public var version: Int
    public var kind: RuleKind
    /// z. B. ein Gruppenname oder eine Absenderadresse.
    public var subject: String
    public var value: Value
    public var description: String
    public var sourceClarificationId: UUID?
    public var createdAt: Date
    public var updatedAt: Date
}

public struct RuleList: Codable, Sendable {
    public var rules: [Rule]
}

public struct RulePatch: Encodable, Sendable, Hashable {
    public var applies: Bool?
    public var note: FieldUpdate<String>

    public init(applies: Bool? = nil, note: FieldUpdate<String> = .unchanged) {
        self.applies = applies
        self.note = note
    }

    enum CodingKeys: String, CodingKey { case applies, note }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(applies, forKey: .applies)
        try c.encodeUpdate(note, forKey: .note)
    }
}
