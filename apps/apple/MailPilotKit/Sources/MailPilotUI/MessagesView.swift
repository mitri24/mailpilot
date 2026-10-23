import MailPilotKit
import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Durchsuchbare importierte Mails: übersehene Mail „Als Aufgabe aufnehmen“ oder mit einer Aufgabe verknüpfen.
public struct MessagesView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @State private var withoutTask = false
    @State private var accountId: UUID?
    @State private var messages: [MessageSummary] = []
    @State private var isLoading = false
    @State private var reachedEnd = false

    public init() {}

    public var body: some View {
        List {
            Section {
                Text("Hier findest du alle importierten Mails. Das Teilen-Menü von Apple Mail liefert nicht zuverlässig die ganze Mail – suche sie stattdessen hier und nimm sie als Aufgabe auf.")
                    .font(.callout).foregroundStyle(.secondary)
                Toggle("Nur Mails ohne Aufgabe", isOn: $withoutTask)
                if model.state.accounts.count > 1 {
                    Picker("Konto", selection: $accountId) {
                        Text("Alle Konten").tag(UUID?.none)
                        ForEach(model.state.sortedAccounts) { Text($0.displayName).tag(UUID?.some($0.id)) }
                    }
                }
            }
            Section {
                if messages.isEmpty && !isLoading {
                    Text(search.isEmpty ? "Keine importierten Mails." : "Keine Mail zu „\(search)“.").foregroundStyle(.secondary)
                }
                ForEach(messages) { message in
                    NavigationLink {
                        MessageDetailView(messageId: message.id)
                    } label: {
                        MessageRow(message: message)
                    }
                }
                if !messages.isEmpty && !reachedEnd {
                    Button("Ältere laden") { Task { await load(append: true) } }
                        .disabled(isLoading)
                }
                if isLoading { ProgressView() }
            }
        }
        .navigationTitle("Mails")
        .searchable(text: $search, prompt: "Betreff, Absender, Inhalt")
        .onSubmit(of: .search) { Task { await load(append: false) } }
        .task(id: "\(withoutTask)-\(accountId?.uuidString ?? "")") { await load(append: false) }
        .refreshable { await load(append: false) }
    }

    private func load(append: Bool) async {
        isLoading = true
        defer { isLoading = false }
        let before = append ? messages.last?.sentAt : nil
        let query = MessageQuery(search: search.isEmpty ? nil : search, accountId: accountId, withoutTask: withoutTask ? true : nil, limit: 50, before: before)
        guard let page = await model.messages(query) else { return }
        messages = append ? messages + page.filter { item in !messages.contains { $0.id == item.id } } : page
        reachedEnd = page.count < 50
    }
}

struct MessageRow: View {
    @Environment(AppModel.self) private var model
    let message: MessageSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(message.subject ?? "Ohne Betreff").font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                if let sent = message.sentAt {
                    Text(GermanText.dateTime(sent, in: model.timeZone, now: model.now)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(message.from?.display ?? "Unbekannter Absender").font(.caption).foregroundStyle(.secondary)
            if let snippet = message.snippet { Text(snippet).font(.caption).lineLimit(2) }
            HStack(spacing: 8) {
                Label(GermanText.analysisStatus(message.analysisStatus), systemImage: "wand.and.stars")
                if message.hasAttachments { Label("Anhang", systemImage: "paperclip") }
                if !message.taskIds.isEmpty { Label(GermanText.count(message.taskIds.count, "Aufgabe", "Aufgaben"), systemImage: "checklist") }
                if message.deleted { Label("Beim Anbieter gelöscht", systemImage: "trash") }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Sichere Mailansicht: Text als garantierte Darstellung, keine Skripte, keine Remote-Inhalte.
public struct MessageDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let messageId: UUID
    @State private var detail: MessageDetail?
    @State private var loadFailed = false
    @State private var formatted = false
    @State private var appleMailFailed = false
    @State private var showsTakeOver = false

    public init(messageId: UUID) {
        self.messageId = messageId
    }

    public var body: some View {
        Group {
            if let detail {
                content(detail)
            } else if loadFailed {
                ContentUnavailableView("Mail nicht verfügbar", systemImage: "envelope.badge.shield.half.filled",
                                       description: Text("Die sichere Ansicht braucht eine Verbindung zum Server."))
            } else {
                ProgressView("Mail wird geladen …")
            }
        }
        .navigationTitle(detail?.message.subject ?? "Mail")
        .task(id: messageId) {
            detail = await model.message(messageId)
            loadFailed = detail == nil
        }
        .sheet(isPresented: $showsTakeOver) {
            if let detail { TakeOverSheet(message: detail.message) }
        }
    }

    @ViewBuilder
    private func content(_ detail: MessageDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header(detail)
                openOriginal(detail)
                if !detail.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Anhänge (nur Angaben, nicht geladen)").font(.subheadline.weight(.semibold))
                        ForEach(Array(detail.attachments.enumerated()), id: \.offset) { _, attachment in
                            Label("\(attachment.filename ?? "ohne Namen") · \(attachment.contentType ?? "Typ unbekannt") · \(GermanText.bytes(attachment.size))\(attachment.inline ? " · eingebettet" : "")",
                                  systemImage: "paperclip")
                                .font(.callout)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    if detail.bodyHtml != nil {
                        Picker("Darstellung", selection: $formatted) {
                            Text("Text").tag(false)
                            Text("Formatiert").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .fixedSize()
                    }
                    if detail.remoteContentBlocked > 0 {
                        Label("\(GermanText.count(detail.remoteContentBlocked, "externer Inhalt", "externe Inhalte")) blockiert", systemImage: "shield")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if formatted, let html = detail.bodyHtml {
                        SafeHTMLView(html: html)
                            .frame(minHeight: 360)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    } else {
                        Text(detail.bodyText)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                actions(detail)
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func header(_ detail: MessageDetail) -> some View {
        let message = detail.message
        VStack(alignment: .leading, spacing: 4) {
            Text(message.subject ?? "Ohne Betreff").font(.title3.weight(.semibold)).textSelection(.enabled)
            Text("Von: \(message.from?.display ?? "unbekannt")").textSelection(.enabled)
            if !detail.to.isEmpty { Text("An: \(detail.to.map(\.display).joined(separator: ", "))").textSelection(.enabled) }
            if !detail.cc.isEmpty { Text("Cc: \(detail.cc.map(\.display).joined(separator: ", "))").textSelection(.enabled) }
            if let sent = message.sentAt { Text(GermanText.dateTime(sent, in: model.timeZone, now: model.now)) }
            HStack(spacing: 8) {
                if let account = model.state.accounts[message.accountId] { Text(account.displayName) }
                if !message.folders.isEmpty { Text(message.folders.joined(separator: ", ")) }
                if let language = message.language { Text("Sprache: \(language)") }
                Text(GermanText.analysisStatus(message.analysisStatus))
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .font(.callout)
    }

    /// Wege zur Originalmail; Apple Mail nur als Versuch, mit kopierbaren Suchangaben als Ersatz.
    @ViewBuilder
    private func openOriginal(_ detail: MessageDetail) -> some View {
        let open = detail.open
        VStack(alignment: .leading, spacing: 8) {
            Text("Originalmail").font(.subheadline.weight(.semibold))
            HStack {
                if let web = open.webLinkURL {
                    Link(destination: web) { Label("Im Webmail öffnen", systemImage: "safari") }
                }
                if let appleMail = open.appleMailURL {
                    Button("In Apple Mail öffnen (Versuch)", systemImage: "envelope.open") {
                        openURL(appleMail) { accepted in appleMailFailed = !accepted }
                    }
                }
            }
            .buttonStyle(.bordered)
            if open.appleMailURL != nil || appleMailFailed {
                Text(open.appleMailNote).font(.caption).foregroundStyle(.secondary)
            }
            if appleMailFailed {
                Text("Apple Mail konnte die Mail nicht öffnen. Suche sie dort mit diesen Angaben:").font(.caption).foregroundStyle(.orange)
            }
            DisclosureGroup("Suchangaben für Apple Mail") {
                VStack(alignment: .leading, spacing: 6) {
                    hint("Absender", open.searchHints.from)
                    hint("Betreff", open.searchHints.subject)
                    hint("Datum", open.searchHints.date)
                    hint("Message-ID", open.searchHints.messageIdHeader)
                }
                .padding(.top, 4)
            }
        }
    }

    @ViewBuilder
    private func hint(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            HStack {
                Text("\(label): ").foregroundStyle(.secondary)
                Text(value).textSelection(.enabled).lineLimit(2)
                Spacer()
                Button("Kopieren", systemImage: "doc.on.doc") { Pasteboard.copy(value) }
                    .labelStyle(.iconOnly).buttonStyle(.borderless)
                    .accessibilityLabel("\(label) kopieren")
            }
            .font(.callout)
        }
    }

    @ViewBuilder
    private func actions(_ detail: MessageDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            let tasks = detail.message.taskIds.compactMap { model.task($0) }
            if !tasks.isEmpty {
                Text("Zugehörige Aufgaben").font(.subheadline.weight(.semibold))
                ForEach(tasks) { task in
                    NavigationLink(value: task.id) { Label(task.title, systemImage: "checklist") }
                }
            }
            Button(tasks.isEmpty ? "Als Aufgabe aufnehmen" : "Weitere Aufgabe oder Verknüpfung", systemImage: "plus.rectangle.on.rectangle") {
                showsTakeOver = true
            }
            .buttonStyle(.borderedProminent)
        }
    }
}

/// „Als Aufgabe aufnehmen“ mit frei bearbeitbarem Titel oder Verknüpfen mit bestehender Aufgabe.
struct TakeOverSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let message: MessageSummary
    @State private var linkExisting = false
    @State private var title = ""
    @State private var target: UUID?
    @State private var isSending = false
    /// Ein Key pro Vorgang: doppeltes Tippen oder Wiederholung legt keine zweite Aufgabe an.
    @State private var idempotencyKey = UUID()

    var body: some View {
        NavigationStack {
            Form {
                Picker("Aktion", selection: $linkExisting) {
                    Text("Neue Aufgabe").tag(false)
                    Text("Mit bestehender Aufgabe verknüpfen").tag(true)
                }
                .pickerStyle(.inline)
                .labelsHidden()
                if linkExisting {
                    Picker("Aufgabe", selection: $target) {
                        Text("Bitte wählen").tag(UUID?.none)
                        ForEach(model.state.visibleTasks.filter(\.isOpen).sorted { $0.title < $1.title }) { Text($0.title).tag(UUID?.some($0.id)) }
                    }
                } else {
                    TextField("Titel", text: $title, prompt: Text("z. B. Formular abgeben"))
                    Text("Ohne Titel formuliert der Server einen Vorschlag aus der Mail.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Mail übernehmen")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Abbrechen") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(linkExisting ? "Verknüpfen" : "Aufnehmen") {
                        isSending = true
                        Task {
                            let result = await model.takeOver(message: message.id, title: linkExisting ? nil : title,
                                                              linkTo: linkExisting ? target : nil, idempotencyKey: idempotencyKey)
                            isSending = false
                            if result != nil { dismiss() }
                        }
                    }
                    .disabled(isSending || (linkExisting && target == nil))
                }
            }
            .onAppear { if title.isEmpty { title = message.subject ?? "" } }
        }
        .frame(minWidth: 380, minHeight: 300)
    }
}

/// Bereinigtes HTML ohne JavaScript, ohne Netzwerkzugriffe (CSP) und ohne Navigation; Links öffnen nur auf Klick extern.
struct SafeHTMLView {
    let html: String

    static func document(_ html: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>:root { color-scheme: light dark; } body { font: -apple-system-body; font-family: -apple-system, sans-serif; margin: 12px; word-wrap: break-word; } img { max-width: 100%; height: auto; }</style>
        </head><body>\(html)</body></html>
        """
    }

    @MainActor
    func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.loadHTMLString(Self.document(html), baseURL: nil)
        return webView
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            if navigationAction.navigationType == .other, navigationAction.request.url?.scheme == "about" {
                return .allow
            }
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" {
                #if os(iOS)
                _ = await UIApplication.shared.open(url)
                #elseif os(macOS)
                NSWorkspace.shared.open(url)
                #endif
            }
            return .cancel
        }
    }

    @MainActor func makeCoordinator() -> Coordinator { Coordinator() }
}

#if os(iOS)
extension SafeHTMLView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func updateUIView(_ webView: WKWebView, context: Context) {}
}
#elseif os(macOS)
extension SafeHTMLView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { makeWebView(coordinator: context.coordinator) }
    func updateNSView(_ webView: WKWebView, context: Context) {}
}
#endif
