import NotiveloCore
import Observation
import SwiftUI

/// The comment threads of the open page (src/editor/collabComments.ts): the list the panel shows, the thread that is
/// being started (its text is already marked in the page), and the thread open in the panel.
///
/// Starting a comment (the web's `beginComment`): the selection is marked with a fresh thread id through the editor
/// engine (`setComment`), the panel asks for the first comment, and only then does the core create the thread
/// (`Core.addCommentThread`). Cancelling, or deleting a thread, takes the mark off again (`unsetComment`).
@Observable
final class CommentsModel {
    static let shared = CommentsModel()
    /// Posted when marks must be drawn again (threads loaded, resolved, focused).
    static let changed = Notification.Name("NotiveloCommentsChanged")
    /// Posted with a thread id (the object) whose mark must come off the page.
    static let unset = Notification.Name("NotiveloCommentUnset")

    struct Pending: Equatable {
        let threadId: String
        let quote: String
    }

    /// The panel is shown.
    var open = false
    private(set) var pageId: String?
    private(set) var threads: [CommentThread] = []
    private(set) var loaded = false
    private(set) var pending: Pending?
    /// The thread open in the panel (and drawn stronger in the page).
    private(set) var activeId: String?
    var showResolved = false
    private(set) var busy = false
    var failure: String?

    @ObservationIgnored private weak var session: SessionModel?

    var openThreads: [CommentThread] { threads.filter { !$0.resolved } }
    var resolvedThreads: [CommentThread] { threads.filter { $0.resolved } }

    // MARK: Page

    /// The page is shown: read its threads.
    func attach(_ session: SessionModel, pageId: String) {
        if self.pageId != pageId { reset() }
        self.session = session
        self.pageId = pageId
        reload()
    }

    /// The page is left.
    func detach(pageId: String) {
        guard self.pageId == pageId else { return }
        cancel()
        reset()
    }

    private func reset() {
        threads = []
        loaded = false
        pending = nil
        activeId = nil
        open = false
        showResolved = false
        failure = nil
        pageId = nil
        EditorMarks.resolvedThreads = []
        EditorMarks.activeThread = nil
    }

    func reload() {
        guard let session, let pid = pageId else { return }
        session.call({ try $0.pageComments(pageId: pid) }) { result in
            guard pid == self.pageId else { return }
            switch result {
            case let .success(list):
                self.threads = list
                self.loaded = true
                self.publish()
            case let .failure(e):
                if !(e is CancellationError) {
                    self.loaded = true
                    self.failure = CoreBridge.message(e)
                }
            }
        }
    }

    /// Draw the marks again: resolved threads plain, the open one stronger.
    private func publish() {
        EditorMarks.resolvedThreads = Set(threads.filter { $0.resolved }.map { $0.id })
        EditorMarks.activeThread = activeId
        NotificationCenter.default.post(name: Self.changed, object: nil)
    }

    private func fail(_ e: Error) {
        if !(e is CancellationError) { failure = CoreBridge.message(e) }
    }

    // MARK: Starting a comment

    /// Mark the selection of `box` with a new thread and open the panel for the comment.
    func begin(box: EditorTarget, quote: String) {
        guard pageId != nil, !quote.isEmpty else { return }
        cancel()
        let id = newCommentThreadId()
        guard box.command("setComment", "{\"threadId\":\"\(id)\"}") else { return }
        pending = Pending(threadId: id, quote: String(quote.prefix(500)))
        activeId = id
        open = true
        failure = nil
        publish()
    }

    /// Give up the comment being started: its mark comes off.
    func cancel() {
        guard let p = pending else { return }
        pending = nil
        if activeId == p.threadId { activeId = nil }
        NotificationCenter.default.post(name: Self.unset, object: p.threadId)
        publish()
    }

    /// The first comment is written: the core makes the thread.
    func submit(_ body: String) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let p = pending, let pid = pageId, let session, !text.isEmpty, !busy else { return }
        busy = true
        failure = nil
        session.call({ try $0.addCommentThread(pageId: pid, threadId: p.threadId, quote: p.quote, body: text) }) { result in
            self.busy = false
            switch result {
            case let .success(t):
                self.pending = nil
                self.threads.removeAll { $0.id == t.id }
                self.threads.append(t)
                self.activeId = t.id
                self.publish()
            case let .failure(e):
                self.fail(e)
            }
        }
    }

    /// Open a thread in the panel (a tap on its text in the page, or its card).
    func focus(_ id: String) {
        guard let t = threads.first(where: { $0.id == id }) else {
            if pending?.threadId == id { open = true }
            return
        }
        if t.resolved { showResolved = true }
        activeId = id
        open = true
        publish()
    }

    // MARK: Threads

    private func upsert(_ t: CommentThread) {
        if let i = threads.firstIndex(where: { $0.id == t.id }) { threads[i] = t } else { threads.append(t) }
        publish()
    }

    func reply(_ threadId: String, _ body: String, done: @escaping () -> Void) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let session, !text.isEmpty else { return }
        session.call({ try $0.replyToCommentThread(threadId: threadId, body: text) }) { result in
            switch result {
            case let .success(t):
                self.upsert(t)
                done()
            case let .failure(e): self.fail(e)
            }
        }
    }

    func setResolved(_ threadId: String, _ resolved: Bool) {
        guard let session else { return }
        session.call({ core -> CommentThread in
            if resolved { return try core.resolveCommentThread(threadId: threadId) }
            return try core.reopenCommentThread(threadId: threadId)
        }) { result in
            switch result {
            case let .success(t):
                if resolved && self.activeId == threadId { self.activeId = nil }
                self.upsert(t)
            case let .failure(e): self.fail(e)
            }
        }
    }

    func edit(_ commentId: String, _ body: String, done: @escaping () -> Void) {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let session, !text.isEmpty else { return }
        session.call({ try $0.editComment(commentId: commentId, body: text) }) { result in
            switch result {
            case let .success(t):
                self.upsert(t)
                done()
            case let .failure(e): self.fail(e)
            }
        }
    }

    func deleteThread(_ threadId: String) {
        guard let session else { return }
        session.call({ try $0.deleteCommentThread(threadId: threadId) }) { result in
            switch result {
            case .success: self.removed(threadId)
            case let .failure(e): self.fail(e)
            }
        }
    }

    func deleteComment(_ threadId: String, _ commentId: String) {
        guard let session else { return }
        session.call({ try $0.deleteComment(commentId: commentId) }) { result in
            switch result {
            case let .success(threadGone):
                if threadGone { self.removed(threadId) } else { self.reload() }
            case let .failure(e): self.fail(e)
            }
        }
    }

    /// The thread is gone: its mark comes off the page.
    private func removed(_ threadId: String) {
        threads.removeAll { $0.id == threadId }
        if activeId == threadId { activeId = nil }
        NotificationCenter.default.post(name: Self.unset, object: threadId)
        publish()
    }
}

// MARK: Panel

/// The page's comments (collabCommentsPanel.tsx; LOOK.md 4.11): the iPad's side panel (320 wide, `--bg-subtle`, 1 pt
/// left border) and the phone's bottom sheet (`--bg-elevated`, radius 16 16 0 0, a grab handle).
struct CommentsPanel: View {
    let palette: Palette
    let phone: Bool
    var maxHeight: CGFloat = 400
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    private let model = CommentsModel.shared

    var body: some View {
        let p = palette
        let canComment = !session.preview && session.workspace?.role != "viewer"
        let shape = UnevenRoundedRectangle(cornerRadii: .init(topLeading: phone ? 16 : 0, bottomLeading: 0, bottomTrailing: 0, topTrailing: phone ? 16 : 0), style: .continuous)
        VStack(spacing: 0) {
            if phone {
                Capsule().fill(p.borderStrong.color).frame(width: 36, height: 4).padding(.top, 8).padding(.bottom, 2)
            }
            head(p)
            if shell.pageTasksTab {
                PageTasksList(palette: p)
            } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let pending = model.pending { Composer(palette: p, quote: pending.quote) }
                    if model.loaded && model.threads.isEmpty && model.pending == nil {
                        HStack(spacing: 6) {
                            Icon("message-square", 14, p.textMuted.color)
                            Text("No comments yet." + (canComment ? " Select text and choose Comment to start a thread." : ""))
                                .font(.web(12.5)).foregroundStyle(p.textMuted.color)
                        }
                        .padding(.horizontal, 4)
                    }
                    ForEach(model.openThreads, id: \.id) { t in
                        ThreadCard(palette: p, thread: t, canComment: canComment)
                    }
                    if !model.resolvedThreads.isEmpty {
                        Button { model.showResolved.toggle() } label: {
                            Text("\(model.showResolved ? "Hide" : "Show") \(model.resolvedThreads.count) resolved")
                                .font(.web(13, 500)).foregroundStyle(p.text2.color)
                                .padding(.horizontal, 10).frame(height: 30)
                        }
                        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    }
                    if model.showResolved {
                        ForEach(model.resolvedThreads, id: \.id) { t in
                            ThreadCard(palette: p, thread: t, canComment: canComment)
                        }
                    }
                    if let failure = model.failure {
                        Text(failure).font(.web(12.5)).foregroundStyle(p.danger.color).padding(.horizontal, 4)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .noEdgeEffect()
            .dismissKeyboardOnScroll()
            }
        }
        .frame(width: phone ? nil : 320)
        .frame(maxWidth: phone ? .infinity : nil, maxHeight: phone ? maxHeight : .infinity)
        .background((phone ? p.bgElevated : p.bgSubtle).color)
        .clipShape(shape)
        .overlay(alignment: phone ? .top : .leading) {
            if phone { Rectangle().fill(p.border.color).frame(height: 1) } else { Rectangle().fill(p.border.color).frame(width: 1) }
        }
        .shadow(color: phone ? Color.black.opacity(0.18) : .clear, radius: 12, y: -4)
    }

    private func tab(_ icon: String, _ title: String, active: Bool, _ p: Palette, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Icon(icon, 14, (active ? p.text : p.text2).color)
                Text(title).font(.web(13, 500)).foregroundStyle((active ? p.text : p.text2).color)
            }
            .padding(.horizontal, 10).frame(height: 28)
            .background(active ? p.bgElevated.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .shadow(color: active ? Color.black.opacity(0.1) : .clear, radius: 1, y: 1)
        }
        .buttonStyle(.plain)
    }

    /// Head 48: the Tasks / Comments switch and the close button.
    private func head(_ p: Palette) -> some View {
        HStack(spacing: 8) {
            HStack(spacing: 2) {
                tab("circle-check", "Tasks", active: shell.pageTasksTab, p) { shell.pageTasksTab = true }
                tab("message-square", "Comments", active: !shell.pageTasksTab, p) {
                    shell.pageTasksTab = false
                    if model.pageId != nil { model.reload() }
                }
            }
            .padding(2)
            .background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Spacer(minLength: 0)
            Button {
                model.cancel()
                model.open = false
            } label: {
                Icon("x", 18, p.text2.color).frame(width: 32, height: 32)
            }
            .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
            .accessibilityLabel("Close panel")
        }
        .padding(.horizontal, 12)
        .frame(height: 48)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
    }
}

private func agoText(_ iso: String) -> String {
    guard let d = Due.instant(iso) else { return "" }
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .full
    return f.localizedString(for: d, relativeTo: Date())
}

/// The thread being started: its quote, a field, Cancel and Comment.
private struct Composer: View {
    let palette: Palette
    let quote: String
    @State private var text = ""
    private let model = CommentsModel.shared

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 8) {
            QuoteLine(palette: p, text: quote)
            MentionField(palette: p, prompt: "Add a comment… (@ to mention)", text: $text, autoFocus: true)
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button { model.cancel() } label: {
                    Text("Cancel").font(.web(13, 500)).foregroundStyle(p.text.color).padding(.horizontal, 12).frame(height: 30)
                        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                }
                .buttonStyle(.plain)
                let ready = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.busy
                Button { model.submit(text) } label: {
                    Text("Comment").font(.web(13, 500)).foregroundStyle(.white).padding(.horizontal, 12).frame(height: 30)
                        .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .opacity(ready ? 1 : 0.5)
                }
                .buttonStyle(.plain)
                .disabled(!ready)
            }
        }
        .padding(10)
        .background(p.bg.color, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(p.accent.color, lineWidth: 2))
    }
}

/// The selected text a thread is about: 3 pt gold bar, 12 muted, one line.
private struct QuoteLine: View {
    let palette: Palette
    let text: String

    var body: some View {
        Text(text.isEmpty ? "(text removed)" : text)
            .font(.web(12)).foregroundStyle(palette.textMuted.color).lineLimit(1)
            .padding(.leading, 8)
            .overlay(alignment: .leading) {
                Rectangle().fill(Color(red: 234 / 255, green: 179 / 255, blue: 8 / 255, opacity: 0.8)).frame(width: 3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ThreadCard: View {
    let palette: Palette
    let thread: CommentThread
    let canComment: Bool
    @Environment(SessionModel.self) private var session
    @State private var reply = ""
    @State private var editing: String?
    @State private var draft = ""
    @State private var menu: String?
    @State private var confirmDelete = false
    private let model = CommentsModel.shared

    var body: some View {
        let p = palette
        let t = thread
        let active = model.activeId == t.id
        let me = session.user?.id
        let admin = ["owner", "admin"].contains(session.workspace?.role ?? "")
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                QuoteLine(palette: p, text: t.quote)
                if canComment {
                    Button { model.setResolved(t.id, !t.resolved) } label: {
                        Icon(t.resolved ? "rotate-ccw" : "check", 15, p.text2.color).frame(width: 32, height: 32)
                    }
                    .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                    .accessibilityLabel(t.resolved ? "Reopen thread" : "Resolve thread")
                }
                if canComment && (t.createdBy == me || admin) {
                    Button { confirmDelete = true } label: { Icon("trash", 15, p.text2.color).frame(width: 32, height: 32) }
                        .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                        .accessibilityLabel("Delete thread")
                }
            }
            if confirmDelete {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Delete this whole thread?").font(.web(13, 600)).foregroundStyle(p.text.color)
                    Text("The comment and all its replies are removed.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                    HStack(spacing: 8) {
                        Button { confirmDelete = false } label: { Text("Cancel").font(.web(13, 500)).foregroundStyle(p.text.color).padding(.horizontal, 12).frame(height: 30) }
                            .buttonStyle(.plain)
                        Button { model.deleteThread(t.id) } label: {
                            Text("Delete thread").font(.web(13, 500)).foregroundStyle(.white).padding(.horizontal, 12).frame(height: 30)
                                .background(p.danger.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if let at = t.resolvedAt {
                let by = t.resolvedBy.flatMap { session.member($0)?.name }
                Text("Resolved \(by.map { "by \($0) " } ?? "")\(agoText(at))").font(.web(12.5)).foregroundStyle(p.textMuted.color)
            }
            ForEach(t.comments, id: \.id) { c in comment(c, p, mine: c.authorId == me, admin: admin) }
            if canComment && active {
                VStack(alignment: .leading, spacing: 6) {
                    MentionField(palette: p, prompt: t.resolved ? "Reply to reopen…" : "Reply… (@ to mention)", text: $reply)
                    if !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        HStack {
                            Spacer(minLength: 0)
                            Button { model.reply(t.id, reply) { reply = "" } } label: {
                                Text("Reply").font(.web(13, 500)).foregroundStyle(.white).padding(.horizontal, 12).frame(height: 30)
                                    .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.bg.color, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(active ? p.accent.color : p.border.color, lineWidth: active ? 2 : 1))
        .opacity(t.resolved ? 0.7 : 1)
        .contentShape(Rectangle())
        .onTapGesture { if !active { model.focus(t.id) } }
    }

    private func comment(_ c: ThreadComment, _ p: Palette, mine: Bool, admin: Bool) -> some View {
        let author = session.member(c.authorId)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AvatarView(name: author?.name ?? "Former member", color: author.map { PlatformColor(css: $0.color) } ?? PlatformColor(css: "#999999"), size: 20)
                Text(author?.name ?? "Former member").font(.web(13, 600)).foregroundStyle(p.text.color).lineLimit(1)
                Text(agoText(c.createdAt) + (c.editedAt != nil ? " · edited" : "")).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
                Spacer(minLength: 0)
                if canComment && (mine || admin) {
                    Button { menu = menu == c.id ? nil : c.id } label: { Icon("ellipsis", 14, p.text2.color).frame(width: 30, height: 30) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Comment actions")
                }
            }
            if menu == c.id {
                HStack(spacing: 8) {
                    if mine {
                        Button { editing = c.id; draft = c.body; menu = nil } label: { Text("Edit").font(.web(13, 500)).foregroundStyle(p.text2.color).padding(.horizontal, 8).frame(height: 28) }
                            .buttonStyle(.plain)
                    }
                    Button { model.deleteComment(thread.id, c.id); menu = nil } label: { Text("Delete").font(.web(13, 500)).foregroundStyle(p.danger.color).padding(.horizontal, 8).frame(height: 28) }
                        .buttonStyle(.plain)
                }
                .padding(.leading, 28)
            }
            if editing == c.id {
                VStack(alignment: .leading, spacing: 6) {
                    MentionField(palette: p, prompt: "", text: $draft, autoFocus: true)
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        Button { editing = nil } label: { Text("Cancel").font(.web(13, 500)).foregroundStyle(p.text.color).padding(.horizontal, 12).frame(height: 30) }
                            .buttonStyle(.plain)
                        Button { model.edit(c.id, draft) { editing = nil } } label: {
                            Text("Save").font(.web(13, 500)).foregroundStyle(.white).padding(.horizontal, 12).frame(height: 30)
                                .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            } else {
                Text(commentText(c.body, p))
                    .font(.web(14)).foregroundStyle(p.text.color)
                    .padding(.leading, 28)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The text with `@[Name](id)` shown as "@Name" chips (yours in the accent).
    private func commentText(_ body: String, _ p: Palette) -> AttributedString {
        var out = AttributedString()
        let me = session.user?.id
        guard let re = try? NSRegularExpression(pattern: "@\\[([^\\]\\n]{1,100})\\]\\(([0-9a-fA-F-]{36})\\)") else { return AttributedString(body) }
        let ns = body as NSString
        var last = 0
        for m in re.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            out += AttributedString(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            var chip = AttributedString("@" + ns.substring(with: m.range(at: 1)))
            chip.foregroundColor = p.accent.color
            chip.backgroundColor = p.accentSoft.color
            if ns.substring(with: m.range(at: 2)) == me { chip.font = .web(14, 600) }
            out += chip
            last = m.range.location + m.range.length
        }
        out += AttributedString(ns.substring(from: last))
        return out
    }
}

/// A text field with "@" completion over the workspace's members (`MentionTextarea`): picking one writes `@[Name](id) `.
private struct MentionField: View {
    let palette: Palette
    let prompt: String
    @Binding var text: String
    var autoFocus = false
    @Environment(SessionModel.self) private var session
    @FocusState private var focused: Bool

    /// The `@word` at the end of the text.
    private var query: String? {
        guard let re = try? NSRegularExpression(pattern: "(^|\\s)@([\\w.-]{0,30})$") else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 2))
    }

    private func options(_ q: String) -> [WorkspaceMember] {
        let needle = q.lowercased()
        return Array(session.members.filter { needle.isEmpty || $0.name.lowercased().contains(needle) || $0.email.lowercased().hasPrefix(needle) }.prefix(6))
    }

    private func insert(_ m: WorkspaceMember, _ q: String) {
        let token = "@[\(m.name)](\(m.id)) "
        text = String(text.dropLast(q.count + 1)) + token
    }

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 4) {
            TextField("", text: $text, prompt: Text(prompt).foregroundStyle(p.textPlaceholder.color), axis: .vertical)
                .lineLimit(2...8)
                .font(.web(14))
                .foregroundStyle(p.text.color)
                .tint(p.accent.color)
                .focused($focused)
                .padding(8)
                .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                .onAppear { if autoFocus { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { focused = true } } }
            if let q = query {
                let list = options(q)
                if !list.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(list, id: \.id) { m in
                            Button { insert(m, q) } label: {
                                HStack(spacing: 8) {
                                    colorDot(m.color, 8)
                                    Text(m.name).font(.web(13.5)).foregroundStyle(p.text.color).lineLimit(1)
                                    Text(m.email).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 10).frame(minHeight: 36)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                        }
                    }
                    .padding(4)
                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(p.border.color, lineWidth: 1))
                }
            }
        }
    }
}
