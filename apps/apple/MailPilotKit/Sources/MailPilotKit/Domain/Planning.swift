import Foundation

public struct PostponePlan: Sendable, Hashable {
    /// Ändert nur `plannedFor`, nie die Frist.
    public var patch: TaskPatch
    public var plannedFor: LocalDate
    /// Kurzer sachlicher Hinweis, wenn morgen nach der Frist liegt.
    public var hint: String?
}

public struct SnoozeOption: Sendable, Hashable, Identifiable {
    public var id: String { label }
    public var label: String
    public var until: Date
}

public enum Planning {
    /// „Auf morgen verschieben“: plant für morgen ein; eine echte Frist bleibt unverändert.
    public static func postponeToTomorrow(_ task: TaskItem, now: Date, timeZone: TimeZone) -> PostponePlan {
        let today = LocalDate(now, in: timeZone)
        let tomorrow = today.adding(days: 1)
        var hint: String?
        if let due = TodayRanking.dueDate(of: task, in: timeZone), tomorrow > due, let deadline = task.deadline {
            var dueText = GermanText.day(due, today: today)
            if deadline.precision == .datetime, let instant = deadline.dateTime {
                dueText += ", \(GermanText.time(instant, in: timeZone))"
            }
            hint = "Morgen liegt nach der Frist (\(dueText)). Die Frist bleibt unverändert."
        }
        return PostponePlan(patch: TaskPatch(plannedFor: .set(tomorrow)), plannedFor: tomorrow, hint: hint)
    }

    public static func planForToday(now: Date, timeZone: TimeZone) -> TaskPatch {
        TaskPatch(plannedFor: .set(LocalDate(now, in: timeZone)))
    }

    /// Vorschläge für „Später anzeigen“ (getrennt vom Einplanen).
    public static func snoozeOptions(now: Date, timeZone: TimeZone) -> [SnoozeOption] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        func at(_ day: LocalDate, hour: Int) -> Date {
            calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day.startOfDay(in: timeZone)) ?? day.startOfDay(in: timeZone)
        }
        let today = LocalDate(now, in: timeZone)
        var options: [SnoozeOption] = []
        let evening = at(today, hour: 18)
        if evening > now.addingTimeInterval(30 * 60) {
            options.append(SnoozeOption(label: "Heute, 18:00", until: evening))
        }
        options.append(SnoozeOption(label: "Morgen, 8:00", until: at(today.adding(days: 1), hour: 8)))
        let daysToMonday = (8 - today.weekday) % 7 == 0 ? 7 : (8 - today.weekday) % 7
        if daysToMonday > 1 {
            options.append(SnoozeOption(label: "Montag, 8:00", until: at(today.adding(days: daysToMonday), hour: 8)))
        }
        options.append(SnoozeOption(label: "In einer Woche", until: at(today.adding(days: 7), hour: 8)))
        return options
    }
}

/// Manuelle Reihenfolge (`sortKey`, kleiner zuerst, ohne Wert zuletzt).
public enum SortKeys {
    /// Neue Schlüssel, damit `id` in der nach `sortKey` sortierten Liste an Position `index` steht.
    /// Liefert nur die nötigen Änderungen.
    public static func reorder(_ ordered: [TaskItem], moving id: UUID, to index: Int) -> [UUID: Double] {
        guard let from = ordered.firstIndex(where: { $0.id == id }) else { return [:] }
        var items = ordered
        let moved = items.remove(at: from)
        let target = max(0, min(index, items.count))
        items.insert(moved, at: target)
        let next: Double? = target + 1 < items.count ? items[target + 1].sortKey : nil

        guard target > 0 else {
            return [moved.id: (next ?? 1) - 1]
        }
        if let previous = items[target - 1].sortKey {
            guard let next else { return [moved.id: previous + 1] }
            if previous < next { return [moved.id: (previous + next) / 2] }
            return renumber(items, through: target, below: next)
        }
        // Davor liegen Einträge ohne Schlüssel: Sie bekommen fortlaufende Schlüssel, sonst stünden sie am Ende.
        var value = items[..<target].compactMap(\.sortKey).max() ?? 0
        var changes: [UUID: Double] = [:]
        for item in items[...target] where item.sortKey == nil || item.id == moved.id {
            value += 1
            changes[item.id] = value
        }
        return changes
    }

    static func renumber(_ items: [TaskItem], through target: Int, below upper: Double) -> [UUID: Double] {
        var changes: [UUID: Double] = [:]
        for position in 0...target {
            let value = upper - Double(target - position + 1)
            if items[position].sortKey != value { changes[items[position].id] = value }
        }
        return changes
    }
}
