import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// "Share to NoteApp": saves the shared text or link as a pending task or note
/// in the App Group. The app picks it up the next time it becomes active
/// (src/platform/capacitor.ts → NoteAppNative.getPendingShares) and opens quick
/// add, or creates the note.
class ShareViewController: UIViewController {
    private var text = ""
    private var url: String?
    private var title_: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        Task { @MainActor in
            await load()
            show()
        }
    }

    private func load() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            if text.isEmpty, let t = item.attributedContentText?.string, !t.isEmpty { text = t }
            if title_ == nil, let t = item.attributedTitle?.string, !t.isEmpty { title_ = t }
            for provider in item.attachments ?? [] {
                if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let u = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                   u.scheme == "http" || u.scheme == "https" {
                    url = u.absoluteString
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    if text.isEmpty { text = s } else if !text.contains(s) { text += "\n" + s }
                }
            }
        }
        // A plain-text share that is just a link counts as a link.
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if url == nil, let u = URL(string: trimmed), u.scheme == "http" || u.scheme == "https", !trimmed.contains(" ") {
            url = trimmed
            text = ""
        }
        if url != nil, text == url { text = "" }
    }

    private func show() {
        let preview = [title_, text.isEmpty ? nil : text, url].compactMap { $0 }.joined(separator: "\n")
        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "NoteApp"
        let root = ShareView(appName: appName, preview: preview.isEmpty ? "Nothing to share" : preview, canSave: !preview.isEmpty,
                             onPick: { [weak self] kind in self?.save(kind) },
                             onCancel: { [weak self] in self?.cancel() })
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    private func save(_ kind: String) {
        var item = ["kind": kind, "text": String(text.prefix(20_000)), "at": ISO8601DateFormatter().string(from: Date())]
        if let url { item["url"] = url }
        if let title_ { item["title"] = String(title_.prefix(300)) }
        SharedStore.appendShare(item)
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "NoteAppShare", code: NSUserCancelledError))
    }
}

private struct ShareView: View {
    let appName: String
    let preview: String
    let canSave: Bool
    let onPick: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationView {
            VStack(alignment: .leading, spacing: 14) {
                Text(preview)
                    .font(.body)
                    .lineLimit(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(12)
                Button { onPick("task") } label: {
                    Label("Add as task", systemImage: "checkmark.circle").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canSave)
                Button { onPick("note") } label: {
                    Label("Save as note", systemImage: "doc.text").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(!canSave)
                Text("It opens in \(appName) the next time you switch to it.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding()
            .navigationTitle(appName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
            }
        }
    }
}
