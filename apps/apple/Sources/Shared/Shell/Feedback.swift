import NotiveloCore
import SwiftUI

// "Send feedback" (src/components/shell/FeedbackDialog.tsx): a small dialog that mails the team through the core's
// `sendFeedback`. The web opens it from the "?" shortcuts list ("Help") and the command palette; so does the app.
// The draft survives a failed send and closing the dialog; it is cleared only after a successful send.

extension Shell {
    static let feedbackMax = 4000

    /// The open screen as the web's in-app path (`location.pathname`: no query, no hash), for the feedback's "page" line.
    func feedbackPath(_ session: SessionModel) -> String? {
        guard let ws = session.workspaceId else { return nil }
        let base = "/w/\(ws)"
        switch route {
        case let .page(id): return "\(base)/p/\(id)"
        case .notes, .section: return "\(base)/notes"
        case let .tasks(list): return "\(base)/tasks/\(list.rawValue)"
        case .calendar: return "\(base)/tasks/calendar"
        case .settings: return "\(base)/settings"
        }
    }

    func openFeedback(_ session: SessionModel) {
        menu = nil
        searchOpen = false
        openSheet(.feedback, session, "Sending feedback")
    }
}

struct FeedbackCard: View {
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool
    let theme = Theme.shared

    var body: some View {
        @Bindable var shell = shell
        let draft = shell.feedbackDraft
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let tooLong = draft.count > Shell.feedbackMax
        let ok = !text.isEmpty && !tooLong && !busy
        DialogCard(title: "Send feedback", width: width, close: close) {
            VStack(alignment: .leading, spacing: 6) {
                field($shell.feedbackDraft, tooLong: tooLong)
                Text("\(draft.count) / \(Shell.feedbackMax)").font(.web(12.5))
                    .foregroundStyle((tooLong ? theme.chrome.danger : theme.chrome.textMuted).color)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                SheetNote(text: "This goes to the Notivelo team along with your name and email, the page you are on, and your app version and device type. We may reply by email.")
                    .padding(.top, 4)
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Cancel") { close() }
            DialogButton(title: busy ? "Sending…" : "Send", style: .primary, enabled: ok) { send(text) }
        }
        .onAppear { if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } } }
    }

    /// The `.input.feedback-text` textarea: "What's on your mind?" over a box at least 120 high.
    private func field(_ text: Binding<String>, tooLong: Bool) -> some View {
        let p = theme.chrome
        return VStack(alignment: .leading, spacing: 6) {
            Text("What’s on your mind?").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
            TextField("", text: text, prompt: Text("A bug, an idea, something confusing…").foregroundStyle(p.textPlaceholder.color), axis: .vertical)
                .font(.web(14)).foregroundStyle(p.text.color).tint(p.accent.color)
                .lineLimit(5...10)
                .focused($focused)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(minHeight: 120, alignment: .topLeading)
                .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused ? p.accent.color : p.border.color, lineWidth: 1))
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused ? p.accentSoft.color : .clear, lineWidth: 6))
        }
    }

    private func close() {
        if !busy { shell.sheet = nil }
    }

    private func send(_ text: String) {
        guard !busy else { return }
        busy = true
        error = nil
        let page = shell.feedbackPath(session)
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        #if os(macOS)
        let platform = "mac"
        #else
        let platform = "ios"
        #endif
        session.call({ try $0.sendFeedback(message: text, page: page, clientVersion: version, platform: platform) }) { result in
            busy = false
            switch result {
            case .success:
                // "delivered" false only means the server could not mail it (it logged the text): the web says sent either way.
                shell.feedbackDraft = ""
                shell.sheet = nil
                shell.say("Thanks, your feedback was sent.")
            case let .failure(e):
                error = SettingsMessage.text(e)
            }
        }
    }
}
