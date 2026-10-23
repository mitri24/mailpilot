import Foundation

/// Filter für das Kanban (Konto, Priorität, Frist, Warten, Suche); Fristfilter wie `due` in `GET /v1/tasks`.
public struct BoardFilter: Sendable, Hashable {
    public enum Due: String, CaseIterable, Sendable, Hashable, Identifiable {
        case any, overdue, today, week, none
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .any: return "Alle Fristen"
            case .overdue: return "Überfällig"
            case .today: return "Bis heute"
            case .week: return "Nächste 7 Tage"
            case .none: return "Ohne Frist"
            }
        }
    }

    public var accountId: UUID?
    public var priority: Priority?
    public var due: Due
    public var waitingOnly: Bool
    public var showSnoozed: Bool
    public var search: String

    public init(accountId: UUID? = nil, priority: Priority? = nil, due: Due = .any, waitingOnly: Bool = false, showSnoozed: Bool = false, search: String = "") {
        self.accountId = accountId
        self.priority = priority
        self.due = due
        self.waitingOnly = waitingOnly
        self.showSnoozed = showSnoozed
        self.search = search
    }

    public var isActive: Bool {
        accountId != nil || priority != nil || due != .any || waitingOnly || !search.trimmingCharacters(in: .whitespaces).isEmpty
    }

    public func matches(_ task: TaskItem, now: Date, timeZone: TimeZone) -> Bool {
        if task.mergedIntoTaskId != nil { return false }
        if let accountId, !task.accountIds.contains(accountId) { return false }
        if let priority, task.priority != priority { return false }
        if waitingOnly, !task.waiting { return false }
        if !showSnoozed, task.status != .done, let until = task.snoozedUntil, until > now { return false }
        if due != .any {
            let today = LocalDate(now, in: timeZone)
            let dueDate = TodayRanking.dueDate(of: task, in: timeZone)
            switch due {
            case .any: break
            case .overdue: guard let d = dueDate, d < today else { return false }
            case .today: guard let d = dueDate, d <= today else { return false }
            case .week: guard let d = dueDate, d <= today.adding(days: 7) else { return false }
            case .none: guard dueDate == nil else { return false }
            }
        }
        let term = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !term.isEmpty {
            let haystack = [task.title, task.nextStep, task.summary, task.primarySource?.subject, task.primarySource?.fromName]
                .compactMap { $0 }
                .joined(separator: "\n")
            if haystack.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) == nil { return false }
        }
        return true
    }
}

public struct BoardColumns: Sendable, Hashable {
    public var todo: [TaskItem]
    public var doing: [TaskItem]
    public var done: [TaskItem]
    public var snoozedHidden: Int

    public subscript(status: TaskStatus) -> [TaskItem] {
        switch status {
        case .todo: return todo
        case .doing: return doing
        case .done: return done
        case .dismissed: return []
        }
    }

    /// Sortierung wie `GET /v1/tasks`: manuelle Reihenfolge, dann zuletzt geändert; Erledigt nach Abschlusszeit.
    public static func build(from tasks: [TaskItem], filter: BoardFilter, now: Date, timeZone: TimeZone) -> BoardColumns {
        let visible = tasks.filter { filter.matches($0, now: now, timeZone: timeZone) }
        var withoutSnoozeFilter = filter
        withoutSnoozeFilter.showSnoozed = true
        let hidden = filter.showSnoozed ? 0 : tasks.filter {
            $0.isOpen && withoutSnoozeFilter.matches($0, now: now, timeZone: timeZone) && !filter.matches($0, now: now, timeZone: timeZone)
        }.count
        func ordered(_ list: [TaskItem]) -> [TaskItem] {
            list.sorted { a, b in
                let ka = a.sortKey ?? .infinity
                let kb = b.sortKey ?? .infinity
                if ka != kb { return ka < kb }
                return a.updatedAt > b.updatedAt
            }
        }
        return BoardColumns(
            todo: ordered(visible.filter { $0.status == .todo }),
            doing: ordered(visible.filter { $0.status == .doing }),
            done: visible.filter { $0.status == .done }.sorted { ($0.doneAt ?? $0.updatedAt) > ($1.doneAt ?? $1.updatedAt) },
            snoozedHidden: hidden
        )
    }
}
