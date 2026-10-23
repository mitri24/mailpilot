import MailPilotKit
import SwiftUI
import WidgetKit

// Widget-Extension für iOS und macOS. Liest nur den lokalen Snapshot aus dem App-Group-Container;
// keine Mailimporte, keine KI-Aufrufe. Aktionen laufen über App Intents (Shared/Intents).

@main
struct MailPilotWidgetBundle: WidgetBundle {
    var body: some Widget {
        TasksWidget()
    }
}

struct TasksEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct TasksProvider: TimelineProvider {
    func placeholder(in context: Context) -> TasksEntry {
        TasksEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (TasksEntry) -> Void) {
        completion(TasksEntry(date: Date(), snapshot: context.isPreview ? .placeholder : Self.loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TasksEntry>) -> Void) {
        let now = Date()
        let snapshot = Self.loadSnapshot()
        // Alle 30 Minuten ein Eintrag, damit Altersangabe und „veraltet“ stimmen; neu laden bestimmt das System.
        let entries = (0..<8).map { TasksEntry(date: now.addingTimeInterval(Double($0) * 1800), snapshot: snapshot) }
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    static func loadSnapshot() -> WidgetSnapshot? {
        let configuration = AppConfiguration.fromBundle(allowDebugOverride: false)
        let location = LocalStore.databaseURL(appGroup: configuration.appGroupIdentifier)
        guard FileManager.default.fileExists(atPath: location.url.path),
              let store = try? LocalStore.open(at: location.url, isShared: location.isShared) else { return nil }
        return try? store.widgetSnapshot()
    }
}

struct TasksWidget: Widget {
    let kind = "MailPilotTasks"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TasksProvider()) { entry in
            TasksWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("MailPilot")
        .description("Die nächsten Aufgaben aus deinen Mails.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct TasksWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TasksEntry

    private var presentation: WidgetPresentation { WidgetPresentation(snapshot: entry.snapshot, now: entry.date) }

    var body: some View {
        if let snapshot = entry.snapshot, snapshot.signedIn, presentation.hasData {
            switch family {
            case .systemSmall: small(snapshot)
            case .systemLarge: list(snapshot, limit: 7, showsClarifications: true)
            default: list(snapshot, limit: 3, showsClarifications: false)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Label("MailPilot", systemImage: "envelope.badge").font(.headline)
                Text(presentation.emptyText ?? "MailPilot öffnen").font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(DeepLink.today.url)
        }
    }

    // Klein: wichtigste Aufgabe und Anzahl offener Aufgaben.
    @ViewBuilder
    private func small(_ snapshot: WidgetSnapshot) -> some View {
        let first = snapshot.allTasks.first
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(snapshot.openTaskCount) offen").font(.caption.weight(.semibold))
                Spacer()
                statusIcons(snapshot)
            }
            if let first {
                Text(first.title).font(.headline).lineLimit(3)
                priority(first)
                if let deadline = first.deadline {
                    Text(GermanText.deadline(deadline, in: snapshot.timeZone, now: entry.date)).font(.caption2)
                }
            } else {
                Text(presentation.emptyText ?? "").font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            footer(snapshot)
        }
        .widgetURL(first.map { DeepLink.task($0.id).url } ?? DeepLink.today.url)
    }

    // Mittel: bis zu drei Aufgaben. Groß: zusätzliche Aufgaben und Hinweis auf Rückfragen.
    @ViewBuilder
    private func list(_ snapshot: WidgetSnapshot, limit: Int, showsClarifications: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("MailPilot", systemImage: "envelope.badge").font(.caption.weight(.semibold))
                Spacer()
                Text("\(snapshot.openTaskCount) offen").font(.caption)
                statusIcons(snapshot)
            }
            let tasks = Array(snapshot.allTasks.prefix(limit))
            if tasks.isEmpty {
                Text(presentation.emptyText ?? "").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(tasks) { task in
                row(task, timeZone: snapshot.timeZone)
            }
            if showsClarifications, let text = presentation.clarificationText {
                Link(destination: DeepLink.clarifications.url) {
                    Label(text, systemImage: "questionmark.bubble").font(.caption)
                }
            }
            Spacer(minLength: 0)
            footer(snapshot)
        }
    }

    private func row(_ task: WidgetTaskItem, timeZone: TimeZone) -> some View {
        HStack(spacing: 6) {
            Link(destination: DeepLink.task(task.id).url) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(task.title).font(.subheadline).lineLimit(1)
                    HStack(spacing: 4) {
                        priority(task)
                        if let deadline = task.deadline {
                            Text(GermanText.deadline(deadline, in: timeZone, now: entry.date)).font(.caption2).lineLimit(1)
                        }
                        if task.hasPendingChanges {
                            Image(systemName: "arrow.triangle.2.circlepath").font(.caption2).accessibilityLabel("Noch nicht synchronisiert")
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if task.status == .todo {
                Button(intent: StartTaskIntent(taskID: task.id)) {
                    Image(systemName: "play.fill").accessibilityLabel("Starten: \(task.title)")
                }
                .buttonStyle(.bordered)
            }
            Button(intent: CompleteTaskIntent(taskID: task.id)) {
                Image(systemName: "checkmark").accessibilityLabel("Erledigt: \(task.title)")
            }
            .buttonStyle(.bordered)
        }
    }

    private func priority(_ task: WidgetTaskItem) -> some View {
        Label(GermanText.priority(task.priority), systemImage: GermanText.prioritySymbol(task.priority))
            .font(.caption2)
            .foregroundStyle(task.priority == .critical ? .red : .secondary)
    }

    @ViewBuilder
    private func statusIcons(_ snapshot: WidgetSnapshot) -> some View {
        if snapshot.lastSyncFailedOffline {
            Image(systemName: "wifi.slash").font(.caption2).accessibilityLabel("Offline")
        }
        if snapshot.failedChangeCount > 0 {
            Image(systemName: "exclamationmark.triangle").font(.caption2).foregroundStyle(.orange).accessibilityLabel("Änderung nicht übernommen")
        }
    }

    @ViewBuilder
    private func footer(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            if let failed = presentation.failedText {
                Text(failed).font(.caption2).foregroundStyle(.orange).lineLimit(1)
            } else if let pending = presentation.pendingText {
                Text(pending).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            if let synced = snapshot.lastSuccessfulSyncAt {
                (Text(presentation.isStale ? "Veraltet, Stand vor " : "Stand vor ") + Text(synced, style: .relative))
                    .font(.caption2)
                    .foregroundStyle(presentation.isStale ? .orange : .secondary)
                    .lineLimit(1)
            } else {
                Text("Noch nicht synchronisiert").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

extension WidgetSnapshot {
    /// Für die Widget-Galerie (keine echten Daten).
    static var placeholder: WidgetSnapshot {
        let now = Date()
        let tasks = [
            WidgetTaskItem(id: UUID(), title: "Studienbescheinigung schicken", status: .todo, priority: .critical,
                           deadline: .onDate(LocalDate(now, in: .current).adding(days: 1)), hasPendingChanges: false, hasConflict: false),
            WidgetTaskItem(id: UUID(), title: "Formular unterschreiben", status: .doing, priority: .important, deadline: nil, hasPendingChanges: false, hasConflict: false),
            WidgetTaskItem(id: UUID(), title: "Rückmeldung an das Sekretariat", status: .todo, priority: .canWait, deadline: nil, hasPendingChanges: false, hasConflict: false),
        ]
        return WidgetSnapshot(generatedAt: now, signedIn: true, lastSuccessfulSyncAt: now, lastSyncFailedOffline: false, timeZoneIdentifier: TimeZone.current.identifier,
                              next: tasks, moreUrgent: [], additional: [], openTaskCount: 3, openClarifications: 1, pendingChangeCount: 0,
                              failedChangeCount: 0, pendingAnalysisCount: 0)
    }
}
