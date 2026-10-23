import Foundation

// Aufzählungen exakt wie packages/contracts/src/enums.ts.

public enum TaskStatus: String, Codable, Sendable, CaseIterable, Hashable {
    case todo, doing, done, dismissed
}

public enum Priority: String, Codable, Sendable, CaseIterable, Hashable {
    case critical
    case important
    case canWait = "can_wait"
}

public enum DeadlinePrecision: String, Codable, Sendable, Hashable {
    case date, datetime
}

/// explicit = in der Mail genannt, uncertain = interpretiert, suggested = vorgeschlagenes Bearbeitungsdatum (keine echte Frist).
public enum DeadlineKind: String, Codable, Sendable, Hashable {
    case explicit, uncertain, suggested
}

public enum Provider: String, Codable, Sendable, Hashable {
    case gmail, microsoft, imap
}

public enum AccountStatus: String, Codable, Sendable, Hashable {
    case active, paused, error
    case needsReauth = "needs_reauth"
    case removed
}

public enum MarkerStrategy: String, Codable, Sendable, CaseIterable, Hashable {
    case none
    case imapKeyword = "imap_keyword"
    case imapFlagged = "imap_flagged"
    case imapCopyFolder = "imap_copy_folder"
    case gmailLabel = "gmail_label"
    case graphCategory = "graph_category"
    case graphFlag = "graph_flag"
}

public enum MarkerStatus: String, Codable, Sendable, Hashable {
    case notRequested = "not_requested"
    case pending, applied, failed, unsupported, cleared
}

public enum FolderRole: String, Codable, Sendable, Hashable {
    case inbox, sent, archive, drafts, spam, trash, other
}

public enum AnalysisStatus: String, Codable, Sendable, Hashable {
    case pending, analyzed, skipped, failed
    case budgetPaused = "budget_paused"
    case tooLarge = "too_large"
}

public enum ClarificationKind: String, Codable, Sendable, Hashable {
    case relevance, membership, responsibility, merge
    case deadlineConflict = "deadline_conflict"
    case reopen, other
}

public enum ClarificationStatus: String, Codable, Sendable, Hashable {
    case open, answered, dismissed
}

/// `once` erzeugt nie eine Regel; `permanent` legt eine sichtbare, änderbare Zuordnung an.
public enum AnswerScope: String, Codable, Sendable, Hashable {
    case once, permanent
}

public enum TaskOrigin: String, Codable, Sendable, Hashable {
    case ai, manual
    case mailManual = "mail_manual"
}

public enum EstimateSource: String, Codable, Sendable, Hashable {
    case user, estimate
}

public enum SyncEntityType: String, Codable, Sendable, Hashable {
    case task, note
    case checklistItem = "checklist_item"
    case clarification, account, rule, settings
}

/// Offen gehalten, damit neue Ereignisarten älterer Clients nicht den Abruf brechen.
public struct TaskEventKind: RawRepresentable, Codable, Sendable, Hashable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let createdAuto = TaskEventKind(rawValue: "created_auto")
    public static let createdManual = TaskEventKind(rawValue: "created_manual")
    public static let sourceAdded = TaskEventKind(rawValue: "source_added")
    public static let deadlineChanged = TaskEventKind(rawValue: "deadline_changed")
    public static let priorityChanged = TaskEventKind(rawValue: "priority_changed")
    public static let titleChanged = TaskEventKind(rawValue: "title_changed")
    public static let statusChanged = TaskEventKind(rawValue: "status_changed")
    public static let waitingChanged = TaskEventKind(rawValue: "waiting_changed")
    public static let noteAdded = TaskEventKind(rawValue: "note_added")
    public static let noteConflict = TaskEventKind(rawValue: "note_conflict")
    public static let merged = TaskEventKind(rawValue: "merged")
    public static let unmerged = TaskEventKind(rawValue: "unmerged")
    public static let dismissed = TaskEventKind(rawValue: "dismissed")
    public static let restored = TaskEventKind(rawValue: "restored")
    public static let correction = TaskEventKind(rawValue: "correction")
    public static let replyReceived = TaskEventKind(rawValue: "reply_received")
    public static let aiUpdated = TaskEventKind(rawValue: "ai_updated")
}

public enum EventActor: String, Codable, Sendable, Hashable {
    case ai, user, system
}

public enum RunStatus: String, Codable, Sendable, Hashable {
    case queued, running, succeeded, partial, failed

    public var isFinished: Bool { self == .succeeded || self == .partial || self == .failed }
}

public enum RunKind: String, Codable, Sendable, Hashable {
    case scan, analysis
}

public enum RunTrigger: String, Codable, Sendable, Hashable {
    case schedule, manual, retry, onboarding
}

public enum ClientPlatform: String, Codable, Sendable, Hashable {
    case ios, macos

    public static var current: ClientPlatform {
        #if os(macOS)
        return .macos
        #else
        return .ios
        #endif
    }
}
