import Foundation

/// Heute-Ranking, Spiegel von services/api/src/domain/today.ts (Parität per Fixture aus dem Servercode geprüft):
/// 0 belegte Frist binnen zwei Tagen oder überfällig · 1 heute eingeplant · 2 kritisch · 3 wichtig · 4 kann warten.
/// Innerhalb eines Rangs: bei Rang 0 nach Frist, sonst nach manueller Reihenfolge, dann Frist, dann Alter.
public enum TodayRanking {
    /// Lokales Fälligkeitsdatum der wirksamen Frist; vorgeschlagene Bearbeitungsdaten sind keine Fristen.
    public static func dueDate(of task: TaskItem, in timeZone: TimeZone) -> LocalDate? {
        guard let deadline = task.deadline, deadline.kind != .suggested else { return nil }
        if deadline.precision == .date { return deadline.date }
        return deadline.dateTime.map { LocalDate($0, in: timeZone) }
    }

    public static func rank(of task: TaskItem, today: LocalDate, in timeZone: TimeZone) -> Int {
        if let due = dueDate(of: task, in: timeZone), due <= today.adding(days: 2) { return 0 }
        if let planned = task.plannedFor, planned <= today { return 1 }
        switch task.priority {
        case .critical: return 2
        case .important: return 3
        case .canWait: return 4
        }
    }

    public static func sortForToday(_ tasks: [TaskItem], today: LocalDate, in timeZone: TimeZone) -> [TaskItem] {
        struct Key {
            let task: TaskItem
            let rank: Int
            let due: LocalDate?
            let sortKey: Double
            let offset: Int
        }
        let keys = tasks.enumerated().map { offset, task in
            Key(task: task, rank: rank(of: task, today: today, in: timeZone), due: dueDate(of: task, in: timeZone),
                sortKey: task.sortKey ?? .infinity, offset: offset)
        }
        // Fehlende Frist zählt wie "9999-12-31" auf dem Server.
        func dueLess(_ a: LocalDate?, _ b: LocalDate?) -> Bool {
            switch (a, b) {
            case let (a?, b?): return a < b
            case (_?, nil): return true
            default: return false
            }
        }
        return keys.sorted { a, b in
            if a.rank != b.rank { return a.rank < b.rank }
            if a.rank == 0, a.due != b.due { return dueLess(a.due, b.due) }
            if a.sortKey != b.sortKey { return a.sortKey < b.sortKey }
            if a.due != b.due { return dueLess(a.due, b.due) }
            if a.task.createdAt != b.task.createdAt { return a.task.createdAt < b.task.createdAt }
            return a.offset < b.offset
        }.map(\.task)
    }

    /// Nur To Do und Doing, nicht wartend, nicht für später ausgeblendet.
    public static func isActionableNow(_ task: TaskItem, now: Date) -> Bool {
        guard task.status == .todo || task.status == .doing else { return false }
        if task.waiting { return false }
        if let snoozedUntil = task.snoozedUntil, snoozedUntil > now { return false }
        return true
    }

    /// Lokale Berechnung von `GET /v1/today` (offline und für optimistische Änderungen).
    /// `pendingAnalysisCount`: Wert aus dem letzten Server-Abruf, sonst Summe der Konten (Näherung).
    public static func computeToday(
        tasks: [TaskItem],
        openClarifications: Int,
        accounts: [Account],
        pendingAnalysisCount: Int?,
        timeZone: TimeZone,
        now: Date
    ) -> Today {
        let all = tasks.filter { ($0.status == .todo || $0.status == .doing) && $0.mergedIntoTaskId == nil }
        let today = LocalDate(now, in: timeZone)
        let actionable = sortForToday(all.filter { isActionableNow($0, now: now) }, today: today, in: timeZone)
        let next = Array(actionable.prefix(3))
        let limit = today.adding(days: 2)
        let moreUrgent = actionable.dropFirst(3).filter { task in
            if let due = dueDate(of: task, in: timeZone), due <= limit { return true }
            return task.priority == .critical
        }
        let nextIds = Set(next.map(\.id))
        let lastFetch = accounts.filter { $0.status == .active }.compactMap(\.lastSuccessfulFetchAt).max()
        return Today(
            next: next,
            moreUrgent: Array(moreUrgent),
            waitingCount: all.filter(\.waiting).count,
            canWaitCount: all.filter { $0.priority == .canWait && !nextIds.contains($0.id) }.count,
            openClarifications: openClarifications,
            lastSuccessfulUpdateAt: lastFetch,
            pendingAnalysisCount: pendingAnalysisCount ?? accounts.reduce(0) { $0 + $1.pendingAnalysisCount },
            accountsNeedingAttention: accountsNeedingAttention(accounts),
            generatedAt: now
        )
    }

    /// Wie `computeToday` auf dem Server: Fehlerstatus oder ein Fehler nach dem letzten erfolgreichen Abruf.
    public static func accountsNeedingAttention(_ accounts: [Account]) -> [AccountAttention] {
        accounts.filter { account in
            if account.status == .error || account.status == .needsReauth { return true }
            guard let error = account.lastError else { return false }
            guard let fetched = account.lastSuccessfulFetchAt else { return true }
            return error.at > fetched
        }.map { account in
            let message = account.lastError?.message ?? ""
            return AccountAttention(
                accountId: account.id,
                displayName: account.displayName,
                problem: message.isEmpty ? "Letzter Abruf fehlgeschlagen" : message,
                action: account.lastError?.action ?? (account.status == .needsReauth ? "Konto erneut verbinden" : "Verbindung prüfen")
            )
        }
    }
}
