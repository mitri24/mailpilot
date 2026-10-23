import Foundation

/// Kompakte Aufgabe für das Widget.
public struct WidgetTaskItem: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var title: String
    public var status: TaskStatus
    public var priority: Priority
    public var deadline: Deadline?
    public var hasPendingChanges: Bool
    public var hasConflict: Bool

    public init(id: UUID, title: String, status: TaskStatus, priority: Priority, deadline: Deadline?, hasPendingChanges: Bool, hasConflict: Bool) {
        self.id = id
        self.title = title
        self.status = status
        self.priority = priority
        self.deadline = deadline
        self.hasPendingChanges = hasPendingChanges
        self.hasConflict = hasConflict
    }
}

/// Sicherer lokaler Stand für das Widget. Das Widget liest nur diesen Snapshot (keine Mailimporte, keine KI-Aufrufe).
public struct WidgetSnapshot: Codable, Sendable, Hashable {
    public static let currentSchema = 1

    public var schema: Int
    public var generatedAt: Date
    public var signedIn: Bool
    public var lastSuccessfulSyncAt: Date?
    public var lastSyncFailedOffline: Bool
    public var timeZoneIdentifier: String
    /// Die drei nächsten Aufgaben (wie „Heute“).
    public var next: [WidgetTaskItem]
    /// Weitere kritische oder überfällige Aufgaben.
    public var moreUrgent: [WidgetTaskItem]
    /// Weitere ausführbare Aufgaben für das große Widget.
    public var additional: [WidgetTaskItem]
    public var openTaskCount: Int
    public var openClarifications: Int
    public var pendingChangeCount: Int
    /// Konflikte oder abgelehnte Änderungen, die in der App angesehen werden sollten.
    public var failedChangeCount: Int
    public var pendingAnalysisCount: Int

    public init(schema: Int = WidgetSnapshot.currentSchema, generatedAt: Date, signedIn: Bool, lastSuccessfulSyncAt: Date?, lastSyncFailedOffline: Bool,
                timeZoneIdentifier: String, next: [WidgetTaskItem], moreUrgent: [WidgetTaskItem], additional: [WidgetTaskItem], openTaskCount: Int,
                openClarifications: Int, pendingChangeCount: Int, failedChangeCount: Int, pendingAnalysisCount: Int) {
        self.schema = schema
        self.generatedAt = generatedAt
        self.signedIn = signedIn
        self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
        self.lastSyncFailedOffline = lastSyncFailedOffline
        self.timeZoneIdentifier = timeZoneIdentifier
        self.next = next
        self.moreUrgent = moreUrgent
        self.additional = additional
        self.openTaskCount = openTaskCount
        self.openClarifications = openClarifications
        self.pendingChangeCount = pendingChangeCount
        self.failedChangeCount = failedChangeCount
        self.pendingAnalysisCount = pendingAnalysisCount
    }

    public static func signedOut(at now: Date) -> WidgetSnapshot {
        WidgetSnapshot(generatedAt: now, signedIn: false, lastSuccessfulSyncAt: nil, lastSyncFailedOffline: false,
                       timeZoneIdentifier: TimeZone.current.identifier, next: [], moreUrgent: [], additional: [], openTaskCount: 0,
                       openClarifications: 0, pendingChangeCount: 0, failedChangeCount: 0, pendingAnalysisCount: 0)
    }

    public var timeZone: TimeZone { TimeZone(identifier: timeZoneIdentifier) ?? .current }

    /// Alle Aufgaben in Anzeigereihenfolge.
    public var allTasks: [WidgetTaskItem] { next + moreUrgent + additional }
}

public enum WidgetSnapshotBuilder {
    public static func build(from state: LocalSnapshot, signedIn: Bool, now: Date, additionalLimit: Int = 6) -> WidgetSnapshot {
        guard signedIn else { return .signedOut(at: now) }
        let timeZone = state.timeZone
        let today = state.today(now: now)
        let actionable = TodayRanking.sortForToday(
            state.visibleTasks.filter { TodayRanking.isActionableNow($0, now: now) },
            today: LocalDate(now, in: timeZone),
            in: timeZone
        )
        let shown = Set((today.next + today.moreUrgent).map(\.id))
        let conflicted = Set(state.notices.compactMap(\.taskId))
        func item(_ task: TaskItem) -> WidgetTaskItem {
            WidgetTaskItem(id: task.id, title: task.title, status: task.status, priority: task.priority, deadline: task.deadline,
                           hasPendingChanges: state.pendingTaskIds.contains(task.id), hasConflict: conflicted.contains(task.id))
        }
        return WidgetSnapshot(
            generatedAt: now,
            signedIn: true,
            lastSuccessfulSyncAt: state.syncState.lastSuccessfulSyncAt,
            lastSyncFailedOffline: state.syncState.lastErrorWasOffline,
            timeZoneIdentifier: timeZone.identifier,
            next: today.next.map(item),
            moreUrgent: today.moreUrgent.map(item),
            additional: actionable.filter { !shown.contains($0.id) }.prefix(additionalLimit).map(item),
            openTaskCount: actionable.count,
            openClarifications: today.openClarifications,
            pendingChangeCount: state.pendingCount,
            failedChangeCount: state.notices.count,
            pendingAnalysisCount: today.pendingAnalysisCount
        )
    }
}

/// Was das Widget zu einem Snapshot anzeigt (reine Logik, testbar ohne WidgetKit).
public struct WidgetPresentation: Sendable, Hashable {
    /// Älter als das gilt der Stand als veraltet.
    public static let staleAfter: TimeInterval = 6 * 3600

    public var isSignedIn: Bool
    public var hasData: Bool
    public var isStale: Bool
    public var ageText: String?
    public var showsOffline: Bool
    public var pendingText: String?
    public var failedText: String?
    public var emptyText: String?
    public var clarificationText: String?

    public init(snapshot: WidgetSnapshot?, now: Date) {
        guard let snapshot else {
            isSignedIn = true
            hasData = false
            isStale = true
            ageText = nil
            showsOffline = false
            pendingText = nil
            failedText = nil
            emptyText = "Noch keine Daten. MailPilot öffnen, um zu aktualisieren."
            clarificationText = nil
            return
        }
        isSignedIn = snapshot.signedIn
        hasData = snapshot.signedIn
        guard snapshot.signedIn else {
            isStale = false
            ageText = nil
            showsOffline = false
            pendingText = nil
            failedText = nil
            emptyText = "Nicht angemeldet. Bitte in MailPilot anmelden."
            clarificationText = nil
            return
        }
        if let synced = snapshot.lastSuccessfulSyncAt {
            isStale = now.timeIntervalSince(synced) > Self.staleAfter
            ageText = "Stand: \(GermanText.age(of: synced, now: now))"
        } else {
            isStale = true
            ageText = "Noch nicht synchronisiert"
        }
        showsOffline = snapshot.lastSyncFailedOffline
        pendingText = snapshot.pendingChangeCount > 0
            ? "\(GermanText.count(snapshot.pendingChangeCount, "Änderung", "Änderungen")) noch nicht synchronisiert"
            : nil
        failedText = snapshot.failedChangeCount > 0
            ? "\(GermanText.count(snapshot.failedChangeCount, "Änderung", "Änderungen")) nicht übernommen – in der App ansehen"
            : nil
        if snapshot.allTasks.isEmpty {
            // Nie „keine Aufgaben“, solange Mails ungeprüft sind.
            emptyText = snapshot.pendingAnalysisCount > 0
                ? "\(GermanText.count(snapshot.pendingAnalysisCount, "Mail", "Mails")) noch ungeprüft"
                : "Für jetzt ist nichts offen."
        } else {
            emptyText = nil
        }
        clarificationText = snapshot.openClarifications > 0
            ? "\(GermanText.count(snapshot.openClarifications, "offene Rückfrage", "offene Rückfragen"))"
            : nil
    }
}
