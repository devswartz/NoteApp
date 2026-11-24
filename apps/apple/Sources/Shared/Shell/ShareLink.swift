import NotiveloCore
import SwiftUI

/// "Anyone with the link can view" in the page's Share dialog (the web's `PublicLinkSection`): a switch that makes a
/// read-only web page at `/s/<token>`, the link with Copy and Open, and a confirmation before turning it off (the old
/// link stops working at once; turning it on again makes a new one).
struct PublicLinkSection: View {
    let pageId: String
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.openURL) private var openURL
    @State private var link: LinkState = .loading
    @State private var busy = false
    @State private var confirmOff = false
    @State private var copied = false
    @State private var error: String?
    let theme = Theme.shared

    enum LinkState: Equatable { case loading, off, on(String) }

    private static let sampleURL = SessionModel.production + "/s/3f9c2b7e61d84a0f9b25c7e18a4d6f03"

    var body: some View {
        let p = theme.chrome
        let isOn: Bool = { if case .on = link { return true }; return false }()
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(p.border.color).frame(height: 1).padding(.top, 4)
            HStack(spacing: 10) {
                Icon("globe", 18, p.textMuted.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Anyone with the link can view").font(.web(14)).foregroundStyle(p.text.color)
                    Text(isOn ? "A read-only web page that opens in any browser, no account needed. It always shows the latest version."
                         : "Off. Turn it on to send this page to someone who doesn’t use Notivelo.")
                        .font(.web(12.5)).foregroundStyle(p.textMuted.color).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Toggle("Anyone with the link can view", isOn: Binding(get: { isOn }, set: { _ in toggle() }))
                    .labelsHidden().toggleStyle(.switch).tint(p.accentSolid.color)
                    .disabled(busy || link == .loading)
            }
            if case let .on(url) = link {
                HStack(spacing: 8) {
                    Text(url).font(.system(size: 12, design: .monospaced)).foregroundStyle(p.text2.color).lineLimit(2).truncationMode(.middle)
                    Spacer(minLength: 0)
                    sheetIconButton("external-link", "Open the page as others see it", p) {
                        if let u = URL(string: url) { openURL(u) }
                    }
                    Button {
                        copyToClipboard(url)
                        copied = true
                        shell.say("Link copied")
                    } label: {
                        HStack(spacing: 4) {
                            Icon(copied ? "check" : "copy", 14, p.text.color)
                            Text(copied ? "Copied" : "Copy link").font(.web(12.5, 500)).foregroundStyle(p.text.color)
                        }
                        .padding(.horizontal, 8).frame(height: 28)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                }
                .padding(8)
                .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
            }
            if confirmOff {
                VStack(alignment: .leading, spacing: 8) {
                    SheetNote(text: "Turn off the link? The old link stops working at once, and turning it on again makes a new one.")
                    HStack(spacing: 8) {
                        DialogButton(title: "Cancel") { confirmOff = false }
                        DialogButton(title: "Turn off link", style: .danger) { turnOff() }
                    }
                }
            }
            if let error { SheetNote(text: error, danger: true) }
        }
        .onAppear(perform: load)
    }

    private func message(_ e: Error) -> String {
        if case let .Server(status, text, _)? = e as? CoreError {
            if status == 409 { return text.isEmpty ? "Locked pages can’t be shared by link" : text }
            if status == 403 { return text.isEmpty ? "You don’t have permission to share this page by link" : text }
        }
        return SessionModel.plainMessage(e)
    }

    private func load() {
        if session.preview {
            link = LookData.state == "share-link" ? .on(Self.sampleURL) : .off
            return
        }
        session.call({ try $0.pageShareLink(pageId: pageId) }) { result in
            switch result {
            case let .success(l): link = l.map { LinkState.on($0.url) } ?? LinkState.off
            case let .failure(e):
                // 403 and 409 mean the switch can't be used here: it stays off, with the reason shown.
                link = .off
                if !(e is CancellationError) { error = message(e) }
            }
        }
    }

    private func toggle() {
        guard !busy else { return }
        error = nil
        if case .on = link { confirmOff = true; return }
        busy = true
        session.call({ try $0.createPageShareLink(pageId: pageId) }) { result in
            busy = false
            switch result {
            case let .success(l):
                link = .on(l.url)
                copied = true
                copyToClipboard(l.url)
                shell.say("Link copied")
            case let .failure(e):
                if !(e is CancellationError) { error = message(e) }
            }
        }
    }

    private func turnOff() {
        confirmOff = false
        busy = true
        session.call({ try $0.deletePageShareLink(pageId: pageId) }) { result in
            busy = false
            switch result {
            case .success:
                link = .off
                copied = false
                shell.say("Link turned off. The old link no longer works.")
            case let .failure(e):
                if !(e is CancellationError) { error = message(e) }
            }
        }
    }
}
