import MailPilotKit
import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@MainActor
enum DeviceName {
    static var current: String? {
        #if os(iOS)
        return UIDevice.current.name
        #elseif os(macOS)
        return Host.current().localizedName
        #else
        return nil
        #endif
    }
}

@MainActor
enum Pasteboard {
    static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

/// Priorität mit Symbol und Text (nie nur Farbe), optional mit kurzer Begründung.
public struct PriorityBadge: View {
    let priority: Priority
    var reason: String?
    var isManual = false

    public init(priority: Priority, reason: String? = nil, isManual: Bool = false) {
        self.priority = priority
        self.reason = reason
        self.isManual = isManual
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Label(GermanText.priority(priority), systemImage: GermanText.prioritySymbol(priority))
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(tint.opacity(0.15), in: Capsule())
                .foregroundStyle(tint)
            if let reason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var tint: Color {
        switch priority {
        case .critical: return .red
        case .important: return .orange
        case .canWait: return .secondary
        }
    }

    private var accessibilityText: String {
        var text = "Priorität: \(GermanText.priority(priority))"
        if isManual { text += ", von dir festgelegt" }
        if let reason, !reason.isEmpty { text += ". \(reason)" }
        return text
    }
}

/// Frist mit Art (laut Mail, unsicher, Vorschlag) und manueller Kennzeichnung.
public struct DeadlineLabel: View {
    let deadline: Deadline
    let timeZone: TimeZone
    let now: Date
    var isManual = false
    var showsKind = false

    public init(deadline: Deadline, timeZone: TimeZone, now: Date, isManual: Bool = false, showsKind: Bool = false) {
        self.deadline = deadline
        self.timeZone = timeZone
        self.now = now
        self.isManual = isManual
        self.showsKind = showsKind
    }

    private var isOverdue: Bool {
        guard deadline.kind != .suggested else { return false }
        let today = LocalDate(now, in: timeZone)
        switch deadline.precision {
        case .date: return deadline.date.map { $0 < today } ?? false
        case .datetime: return deadline.dateTime.map { $0 < now } ?? false
        }
    }

    public var body: some View {
        HStack(spacing: 4) {
            Image(systemName: deadline.kind == .suggested ? "calendar.badge.clock" : (isOverdue ? "exclamationmark.circle" : "calendar"))
            Text(GermanText.deadline(deadline, in: timeZone, now: now))
            if showsKind {
                Text("· \(isManual ? "von dir gesetzt" : GermanText.deadlineKind(deadline.kind))")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .foregroundStyle(isOverdue ? Color.red : Color.primary)
        .accessibilityElement(children: .combine)
    }
}

/// Kleine Hinweise an Karten: wartet, später, eingeplant, nicht synchronisiert, Konflikt.
struct TaskFlags: View {
    let task: TaskItem
    let isPending: Bool
    let hasConflict: Bool
    let timeZone: TimeZone
    let now: Date

    var body: some View {
        let today = LocalDate(now, in: timeZone)
        HStack(spacing: 8) {
            if task.waiting {
                Label(task.waitingCheckAt.map { "Warte auf Antwort, nachsehen \(GermanText.day($0, today: today))" } ?? "Warte auf Antwort",
                      systemImage: "hourglass")
            }
            if let until = task.snoozedUntil, until > now {
                Label("Später: \(GermanText.dateTime(until, in: timeZone, now: now))", systemImage: "moon.zzz")
            }
            if let planned = task.plannedFor, task.isOpen {
                Label("Eingeplant: \(GermanText.day(planned, today: today))", systemImage: "calendar.day.timeline.left")
            }
            if isPending {
                Label("Noch nicht synchronisiert", systemImage: "arrow.triangle.2.circlepath")
            }
            if hasConflict {
                Label("Auf anderem Gerät geändert", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .labelStyle(.titleAndIcon)
    }
}

/// Aufgabenkarte: Titel, Priorität mit Begründung, Frist, nächster Schritt, Quelle, Notizen, Status.
public struct TaskCard: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem
    var showsStatus = true

    public init(task: TaskItem, showsStatus: Bool = true) {
        self.task = task
        self.showsStatus = showsStatus
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(task.title)
                    .font(.headline)
                    .strikethrough(task.status == .done, color: .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if showsStatus {
                    Text(GermanText.status(task.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            PriorityBadge(priority: task.priority, reason: task.priorityReason, isManual: task.priorityIsManual)
            if let deadline = task.deadline {
                DeadlineLabel(deadline: deadline, timeZone: model.timeZone, now: model.now, isManual: task.deadlineIsManual)
            }
            if let nextStep = task.nextStep, !nextStep.isEmpty {
                Label(nextStep, systemImage: "arrow.right.circle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
            if let latest = task.latestChange {
                Label(latest, systemImage: "sparkles")
                    .font(.caption)
                    .foregroundStyle(.blue)
            }
            HStack(spacing: 10) {
                if let source = task.primarySource {
                    Label(sourceText(source), systemImage: "envelope")
                        .lineLimit(1)
                } else if task.origin == .manual {
                    Label("Eigene Aufgabe", systemImage: "person")
                }
                let noteCount = model.state.notes(for: task.id).count
                if noteCount > 0 {
                    Label(GermanText.count(noteCount, "Notiz", "Notizen"), systemImage: "note.text")
                }
                if task.openClarifications > 0 {
                    Label(GermanText.count(task.openClarifications, "Rückfrage", "Rückfragen"), systemImage: "questionmark.bubble")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            TaskFlags(task: task, isPending: model.isPending(task.id), hasConflict: !model.notices(for: task.id).isEmpty,
                      timeZone: model.timeZone, now: model.now)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func sourceText(_ source: SourceRef) -> String {
        let sender = source.fromName ?? source.fromAddress ?? "Unbekannt"
        let subject = source.subject.map { " · \($0)" } ?? ""
        let more = task.sourceCount > 1 ? " (+\(task.sourceCount - 1))" : ""
        return sender + subject + more
    }
}

/// Statuswechsel als einfache Schaltflächen (iPhone) bzw. Menüeinträge.
public struct StatusButtons: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem

    public init(task: TaskItem) { self.task = task }

    public var body: some View {
        HStack(spacing: 8) {
            switch task.status {
            case .todo:
                Button("Starten", systemImage: "play") { model.setStatus(.doing, for: task.id) }
                Button("Erledigt", systemImage: "checkmark") { model.setStatus(.done, for: task.id) }
            case .doing:
                Button("Zurück zu To Do", systemImage: "arrow.uturn.backward") { model.setStatus(.todo, for: task.id) }
                Button("Erledigt", systemImage: "checkmark") { model.setStatus(.done, for: task.id) }
            case .done:
                Button("Wieder öffnen", systemImage: "arrow.uturn.backward") { model.setStatus(.todo, for: task.id) }
            case .dismissed:
                Button("Wiederherstellen", systemImage: "arrow.uturn.backward") { model.restore(task.id) }
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }
}

/// Menü mit allen Aktionen einer Aufgabe (Kontextmenü, Detailansicht).
public struct TaskActionsMenuContent: View {
    @Environment(AppModel.self) private var model
    let task: TaskItem
    let onWaiting: () -> Void
    let onCorrection: () -> Void

    public init(task: TaskItem, onWaiting: @escaping () -> Void, onCorrection: @escaping () -> Void) {
        self.task = task
        self.onWaiting = onWaiting
        self.onCorrection = onCorrection
    }

    public var body: some View {
        if task.status == .todo {
            Button("Starten", systemImage: "play") { model.setStatus(.doing, for: task.id) }
        }
        if task.isOpen {
            Button("Erledigt", systemImage: "checkmark") { model.setStatus(.done, for: task.id) }
        }
        if task.status == .doing {
            Button("Zurück zu To Do", systemImage: "arrow.uturn.backward") { model.setStatus(.todo, for: task.id) }
        }
        if task.status == .done {
            Button("Wieder öffnen", systemImage: "arrow.uturn.backward") { model.setStatus(.todo, for: task.id) }
        }
        Divider()
        if task.isOpen {
            Button("Heute einplanen", systemImage: "calendar.badge.plus") { model.planForToday(task.id) }
            Button("Auf morgen verschieben", systemImage: "arrow.right.to.line") { model.postponeToTomorrow(task.id) }
            Menu("Später anzeigen", systemImage: "moon.zzz") {
                ForEach(Planning.snoozeOptions(now: model.now, timeZone: model.timeZone)) { option in
                    Button(option.label) { model.snooze(task.id, until: option.until) }
                }
                if task.snoozedUntil != nil {
                    Button("Wieder anzeigen") { model.snooze(task.id, until: nil) }
                }
            }
            Button(task.waiting ? "Warten beenden" : "Warte auf Antwort …", systemImage: "hourglass") {
                if task.waiting { model.setWaiting(false, checkAt: nil, for: task.id) } else { onWaiting() }
            }
        }
        Divider()
        Button("Korrektur …", systemImage: "exclamationmark.bubble") { onCorrection() }
        if task.status == .dismissed {
            Button("Wiederherstellen", systemImage: "arrow.uturn.backward") { model.restore(task.id) }
        } else {
            Button("Nicht relevant", systemImage: "xmark.circle", role: .destructive) { model.dismiss(task.id) }
        }
    }
}

/// Hinweise aus der Synchronisierung (Konflikte, abgelehnte Änderungen).
struct NoticeList: View {
    @Environment(AppModel.self) private var model
    let notices: [SyncNotice]

    var body: some View {
        ForEach(notices) { notice in
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: notice.kind == .conflict ? "exclamationmark.triangle" : "xmark.octagon")
                    .foregroundStyle(notice.kind == .conflict ? .orange : .red)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(notice.kind == .conflict ? "Konflikt" : "Nicht übernommen").font(.caption.weight(.semibold))
                    Text(notice.message).font(.callout)
                }
                Spacer()
                Button("Ausblenden", systemImage: "xmark") { model.dismissNotice(notice.id) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Hinweis ausblenden")
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// Zeile mit Synchronisierungsstand für „Heute“ und Board.
struct SyncStatusLine: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let sync = model.state.syncState
        VStack(alignment: .leading, spacing: 4) {
            if model.isOffline {
                Label("Offline – Änderungen werden später übertragen.", systemImage: "wifi.slash")
                    .foregroundStyle(.orange)
            } else if case .failed(let message)? = model.lastReport?.outcome {
                Label(message, systemImage: "exclamationmark.icloud")
                    .foregroundStyle(.orange)
            }
            HStack(spacing: 12) {
                if let synced = sync.lastSuccessfulSyncAt {
                    Label("Aktualisiert \(GermanText.age(of: synced, now: model.now))", systemImage: "checkmark.icloud")
                } else {
                    Label("Noch nicht synchronisiert", systemImage: "icloud.slash")
                }
                if model.state.pendingCount > 0 {
                    Label(GermanText.count(model.state.pendingCount, "Änderung ausstehend", "Änderungen ausstehend"), systemImage: "arrow.triangle.2.circlepath")
                }
                if model.isSyncing {
                    ProgressView().controlSize(.small)
                }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// Unterer Hinweis mit optionalem „Rückgängig“.
public struct BannerOverlay: View {
    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        if let banner = model.banner {
            HStack(spacing: 12) {
                Image(systemName: banner.kind == .error ? "exclamationmark.triangle" : "info.circle")
                    .accessibilityHidden(true)
                Text(banner.message).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if let undo = banner.undo {
                    Button("Rückgängig") { Task { await model.performUndo(undo) } }
                        .buttonStyle(.borderedProminent)
                }
                Button("Schließen", systemImage: "xmark") { model.banner = nil }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
            }
            .padding(12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .padding()
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: banner.id) {
                try? await Task.sleep(for: .seconds(banner.undo == nil ? 6 : 10))
                if model.banner?.id == banner.id { model.banner = nil }
            }
        }
    }
}

extension View {
    /// Einheitlicher Abschnittstitel in Detailansichten.
    func sectionTitle(_ title: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            self
        }
    }
}
