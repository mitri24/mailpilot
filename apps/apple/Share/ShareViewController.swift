import MailPilotKit
import Observation
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import AppKit
typealias PlatformViewController = NSViewController
#endif

// Share Extension (iOS und macOS): Text oder Link als Aufgabe mit Notiz anlegen.
// Apple Mail liefert über das Teilen-Menü nicht zuverlässig die vollständige Mail; dafür gibt es in der App „Mails“.

final class ShareViewController: PlatformViewController {
    #if os(iOS)
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(model: makeModel()))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
    #elseif os(macOS)
    override func loadView() {
        let host = NSHostingView(rootView: ShareView(model: makeModel()))
        host.frame = NSRect(x: 0, y: 0, width: 440, height: 420)
        view = host
    }
    #endif

    private func makeModel() -> ShareModel {
        let context = extensionContext
        return ShareModel(items: (context?.inputItems as? [NSExtensionItem]) ?? [],
                          finish: { context?.completeRequest(returningItems: nil, completionHandler: nil) },
                          cancel: { context?.cancelRequest(withError: CocoaError(.userCancelled)) })
    }
}

@MainActor
@Observable
final class ShareModel {
    var title = ""
    var note = ""
    var isLoading = true
    var isSaving = false
    var message: String?
    let isSignedIn: Bool
    private let environment: AppEnvironment?
    private let items: [NSExtensionItem]
    private let finish: () -> Void
    private let cancelAction: () -> Void

    #if DEBUG
    private static let allowDebugOverride = true
    #else
    private static let allowDebugOverride = false
    #endif

    init(items: [NSExtensionItem], finish: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.items = items
        self.finish = finish
        self.cancelAction = cancel
        environment = try? AppEnvironment.live(allowDebugOverride: Self.allowDebugOverride)
        isSignedIn = environment?.isSignedIn ?? false
    }

    func load() async {
        defer { isLoading = false }
        var texts: [String] = []
        var links: [URL] = []
        var suggestedTitle: String?
        for item in items {
            if let attributed = item.attributedContentText?.string, !attributed.isEmpty { texts.append(attributed) }
            if suggestedTitle == nil, let heading = item.attributedTitle?.string, !heading.isEmpty { suggestedTitle = heading }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = await Self.loadURL(provider) {
                    links.append(url)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let text = await Self.loadText(provider) {
                    texts.append(text)
                }
            }
        }
        let uniqueTexts = texts.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        note = (uniqueTexts + links.map(\.absoluteString)).joined(separator: "\n\n")
        let firstLine = uniqueTexts.first?.split(whereSeparator: \.isNewline).first.map(String.init)
        title = String((suggestedTitle ?? firstLine ?? links.first?.host() ?? "").prefix(120))
        if note.isEmpty {
            message = "Dieser Inhalt lässt sich nicht übernehmen. Für eine Mail: in MailPilot unter „Mails“ suchen und „Als Aufgabe aufnehmen“."
        }
    }

    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { text, _ in continuation.resume(returning: text) }
        }
    }

    func save() async {
        guard let environment else { return }
        isSaving = true
        do {
            _ = try environment.actions(origin: .share).createTask(title: title, note: note)
            environment.refreshWidgetSnapshot()
            // Kurzer Versuch zu übertragen; sonst übernimmt die App das später aus der gemeinsamen Outbox.
            await withTaskGroup(of: Void.self) { group in
                group.addTask { _ = await environment.engine.sync() }
                group.addTask { try? await Task.sleep(for: .seconds(5)) }
                await group.next()
                group.cancelAll()
            }
            finish()
        } catch {
            message = (error as? LocalizedError)?.errorDescription ?? "Speichern nicht möglich."
            isSaving = false
        }
    }

    func cancel() { cancelAction() }
}

struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                if !model.isSignedIn {
                    Section {
                        Text("Bitte zuerst in der MailPilot-App anmelden.")
                    }
                } else if model.isLoading {
                    ProgressView()
                } else {
                    Section("Aufgabe") {
                        TextField("Titel", text: $model.title)
                    }
                    Section("Notiz") {
                        TextField("Geteilter Inhalt", text: $model.note, axis: .vertical)
                            .lineLimit(3...10)
                    }
                    if let message = model.message {
                        Section { Text(message).foregroundStyle(.secondary) }
                    }
                    Section {
                        Text("Hinweis: Apple Mail stellt über das Teilen-Menü nicht immer die ganze Mail bereit. Mails findest du in MailPilot unter „Mails“ und kannst sie dort als Aufgabe aufnehmen.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("In MailPilot sichern")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { model.cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { Task { await model.save() } }
                        .disabled(!model.isSignedIn || model.isSaving || model.title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .task { await model.load() }
    }
}
