import Foundation

/// Lokale Anwendung von Änderungen, gespiegelt von `effectiveTask` (services/api/src/domain/dto.ts)
/// und `updateTask` (services/api/src/domain/mutations.ts), damit die optimistische Anzeige dem Serverergebnis entspricht.
public enum TaskEffects {
    public static let untitled = "Aufgabe ohne Titel"
    public static let manualPriorityReason = "Von dir festgelegt"

    /// Wirksame Werte aus KI- und manueller Schicht neu berechnen (manuell gewinnt).
    public static func recomputeEffective(_ task: inout TaskItem) {
        let manualDeadline = task.manual.deadline?.asDeadline
        task.deadline = task.manual.deadlineCleared ? nil : (manualDeadline ?? task.ai.deadline)
        task.deadlineIsManual = task.manual.deadlineCleared || manualDeadline != nil
        task.priority = task.manual.priority ?? task.ai.priority ?? .important
        task.priorityIsManual = task.manual.priority != nil
        task.priorityReason = task.manual.priority != nil ? manualPriorityReason : task.ai.priorityReason
        task.title = task.manual.title ?? task.ai.title ?? untitled
        task.nextStep = task.manual.nextStep ?? task.ai.nextStep
    }

    public static func apply(_ patch: TaskPatch, to original: TaskItem, now: Date) -> TaskItem {
        var task = original
        if let status = patch.status, status != task.status {
            // Der Status ist hier immer ein anderer als vorher.
            if status == .done { task.doneAt = now }
            if task.status == .done { task.doneAt = nil }
            if status == .dismissed { task.dismissedAt = now }
            if task.status == .dismissed { task.dismissedAt = nil }
            task.status = status
        }
        if let waiting = patch.waiting { task.waiting = waiting }
        if let value = patch.waitingCheckAt.change { task.waitingCheckAt = value }
        if let value = patch.snoozedUntil.change { task.snoozedUntil = value }
        if let value = patch.plannedFor.change { task.plannedFor = value }
        if let value = patch.sortKey.change { task.sortKey = value }
        if let value = patch.title.change { task.manual.title = value }
        if let value = patch.nextStep.change { task.manual.nextStep = value }
        if let value = patch.priority.change { task.manual.priority = value }
        if patch.deadlineCleared == true {
            task.manual.deadline = nil
            task.manual.deadlineCleared = true
        } else if let value = patch.deadline.change {
            task.manual.deadline = value?.normalized
            task.manual.deadlineCleared = false
        } else if patch.deadlineCleared == false {
            task.manual.deadlineCleared = false
        }
        if let value = patch.estimatedMinutes.change {
            task.estimatedMinutes = value
            task.estimateSource = value == nil ? nil : .user
        }
        if !patch.isEmpty { task.updatedAt = now }
        recomputeEffective(&task)
        return task
    }

    /// Lokales Abbild einer offline angelegten Aufgabe, wie `createTask` sie serverseitig anlegt.
    public static func created(id: UUID, title: String, nextStep: String?, priority: Priority?, deadline: ManualDeadline?, at now: Date) -> TaskItem {
        var task = TaskItem(
            id: id,
            version: 0,
            origin: .manual,
            status: .todo,
            title: title,
            manual: ManualOverrides(title: title, nextStep: nextStep, priority: priority, deadline: deadline?.normalized, deadlineCleared: false),
            createdAt: now,
            updatedAt: now
        )
        recomputeEffective(&task)
        return task
    }

    /// Vergleichbare Feldwerte so, wie der Server sie auf „unverändert“ prüft (manuelle Schicht, nicht KI).
    public static func comparableFields(of task: TaskItem) -> [String: JSONValue] {
        var deadline: [String: JSONValue] = ["cleared": .bool(task.manual.deadlineCleared)]
        if let manual = task.manual.deadline?.normalized {
            deadline["precision"] = .string(manual.precision.rawValue)
            deadline["date"] = manual.date.map { .string($0.description) } ?? .null
            deadline["dateTime"] = manual.dateTime.map { .string(ISOTimestamp.format($0)) } ?? .null
        }
        return [
            "status": .string(task.status.rawValue),
            "waiting": .bool(task.waiting),
            "waitingCheckAt": task.waitingCheckAt.map { .string($0.description) } ?? .null,
            "snoozedUntil": task.snoozedUntil.map { .string(ISOTimestamp.format($0)) } ?? .null,
            "plannedFor": task.plannedFor.map { .string($0.description) } ?? .null,
            "sortKey": task.sortKey.map { .number($0) } ?? .null,
            "title": task.manual.title.map { .string($0) } ?? .null,
            "nextStep": task.manual.nextStep.map { .string($0) } ?? .null,
            "priority": task.manual.priority.map { .string($0.rawValue) } ?? .null,
            "deadline": .object(deadline),
            "estimatedMinutes": task.estimatedMinutes.map { .number(Double($0)) } ?? .null,
        ]
    }

    public static func comparableFields(of note: TaskNote) -> [String: JSONValue] {
        ["body": .string(note.body)]
    }

    public static func comparableFields(of item: ChecklistItem) -> [String: JSONValue] {
        ["title": .string(item.title), "done": .bool(item.done), "position": .number(item.position)]
    }

    /// Wie `answerClarification`: dauerhaft nur, wenn auch die gewählte Option dauerhaft sein darf.
    public static func answered(_ clarification: Clarification, optionId: String?, text: String?, scope: AnswerScope, at now: Date) -> Clarification {
        var result = clarification
        let option = optionId.flatMap { id in clarification.options.first { $0.id == id } }
        let effectiveScope: AnswerScope = scope == .permanent && (option.map { $0.scope == .permanent } ?? true) ? .permanent : .once
        result.status = option?.isDeferral == true ? .open : .answered
        result.answer = ClarificationAnswerRecord(optionId: optionId, text: text, scope: effectiveScope, answeredAt: now)
        result.updatedAt = now
        return result
    }
}
