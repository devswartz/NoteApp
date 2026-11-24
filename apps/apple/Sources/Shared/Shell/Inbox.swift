import NotiveloCore
import Observation
import SwiftUI

/// The notification inbox behind the bell (src/components/sharing/inbox.ts and NotificationBell.tsx): the newest
/// notifications, how many are unread, and "load more" for older ones. Online only (nothing is kept on the device).
@Observable
final class InboxModel {
    private(set) var items: [AppNotification] = []
    private(set) var unread = 0
    private(set) var nextBefore: String?
    private(set) var loaded = false
    private(set) var loadingMore = false
    private(set) var error: String?
    @ObservationIgnored private var generation = 0
    private static let pageSize: UInt32 = 30

    /// Forget everything (another account signed in).
    func reset() {
        generation += 1
        items = []
        unread = 0
        nextBefore = nil
        loaded = false
        loadingMore = false
        error = nil
    }

    /// Ask the server again: the bell's count, and with `list` (the inbox is open) the newest page too, unless older
    /// pages were loaded below it (they stay as they are; only the count follows).
    func refresh(_ session: SessionModel, list: Bool) {
        guard !session.preview else { return }
        let gen = generation
        if list && (!loaded || items.count <= Int(Self.pageSize)) {
            session.call({ try $0.notifications(limit: Self.pageSize, before: nil) }) { [weak self] result in
                guard let self, gen == self.generation else { return }
                switch result {
                case let .success(page):
                    self.items = page.items
                    self.unread = Int(page.unread)
                    self.nextBefore = page.nextBefore
                    self.loaded = true
                    self.error = nil
                case let .failure(e):
                    if !(e is CancellationError), !self.loaded { self.error = SessionModel.plainMessage(e) }
                }
            }
        } else {
            session.call({ try $0.unreadNotificationCount() }) { [weak self] result in
                guard let self, gen == self.generation, case let .success(n) = result else { return }
                self.unread = Int(n)
            }
        }
    }

    func loadMore(_ session: SessionModel) {
        guard let before = nextBefore, !loadingMore, !session.preview else { return }
        loadingMore = true
        let gen = generation
        session.call({ try $0.notifications(limit: Self.pageSize, before: before) }) { [weak self] result in
            guard let self, gen == self.generation else { return }
            self.loadingMore = false
            if case let .success(page) = result {
                let have = Set(self.items.map(\.id))
                self.items += page.items.filter { !have.contains($0.id) }
                self.nextBefore = page.nextBefore
                self.unread = Int(page.unread)
            }
        }
    }

    private static func now() -> String { ISO8601DateFormatter().string(from: Date()) }

    func markRead(_ id: String, _ session: SessionModel) {
        guard let i = items.firstIndex(where: { $0.id == id }), !items[i].isRead else { return }
        items[i].isRead = true
        items[i].readAt = Self.now()
        unread = max(0, unread - 1)
        session.call({ try $0.markNotificationRead(id: id) }) { _ in }
    }

    func markAll(_ session: SessionModel) {
        let ts = Self.now()
        items = items.map { n in
            var m = n
            if !m.isRead { m.isRead = true; m.readAt = ts }
            return m
        }
        unread = 0
        session.call({ try $0.markAllNotificationsRead() }) { _ in }
    }

    /// Open what a notification is about (its task, else its page), and mark it read.
    func open(_ n: AppNotification, _ session: SessionModel, _ shell: Shell) {
        markRead(n.id, session)
        shell.menu = nil
        if session.preview { return }
        if let id = n.taskId {
            session.pendingLink = DeepLink(workspaceId: n.workspaceId, target: .task(id))
        } else if let id = n.pageId {
            session.pendingLink = DeepLink(workspaceId: n.workspaceId, target: .page(id))
        } else if let link = n.link, let url = URL(string: SessionModel.production + link), let parsed = DeepLink.parse(url) {
            session.pendingLink = parsed
        }
    }

    /// `-lookState inbox` (CI screenshots): a few notifications from the demo people.
    func seedLook() {
        func n(_ id: String, _ kind: String, _ actor: String?, _ title: String, _ body: String, _ minutes: Double, read: Bool = false) -> AppNotification {
            AppNotification(id: id, kind: kind, workspaceId: "demo-team", actorId: actor, title: title, body: body, link: nil, pageId: nil,
                            taskId: nil, createdAt: LookData.iso(minutesAgo: minutes), readAt: read ? LookData.iso(minutesAgo: minutes - 1) : nil,
                            isRead: read)
        }
        items = [
            n("n1", "mention", "ana", "Ana Silva mentioned you in “Weekly sync”", "@Demo can you take the launch checklist?", 6),
            n("n2", "assigned", "ben", "Ben Okafor assigned you “Review the launch checklist”", "", 42),
            n("n3", "comment", "ana", "Ana Silva commented on “Canvas”", "Looks good, moving the table up.", 3 * 60),
            n("n4", "shared", "chen", "Chen Wei shared “Q4 roadmap” with you", "", 26 * 60, read: true),
            n("n5", "reminder", nil, "Reminder: Send the meeting notes to the team", "Due today", 2 * 24 * 60, read: true),
        ]
        unread = 3
        loaded = true
    }
}

/// The bell with its unread badge (the web's `.bell-btn` and `.bell-badge`): a red pill at the top right, ringed in the
/// background it sits on.
struct BellButton: View {
    let size: CGFloat
    let box: CGFloat
    let color: Color
    let ring: Color
    let anchorId: String
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let unread = shell.inbox.unread
        Button {
            if shell.menu == .inbox { shell.menu = nil } else { shell.menu = .inbox }
        } label: {
            Icon("bell", size, color).frame(width: box, height: box)
                .overlay(alignment: .topTrailing) {
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)").font(.web(10, 600)).foregroundStyle(Color.white)
                            .padding(.horizontal, 4).frame(minWidth: 16, minHeight: 16)
                            .background(Capsule().fill(Color(red: 0.937, green: 0.267, blue: 0.267)))
                            .overlay(Capsule().stroke(ring, lineWidth: 2))
                            .offset(x: 2, y: 4)
                    }
                }
        }
        .buttonStyle(PressStyle(radius: 9, pressed: p.bgPressed.color))
        .accessibilityLabel(unread > 0 ? "Notifications, \(unread) unread" : "Notifications")
        .anchor(anchorId, shell)
    }
}

/// The inbox popover (a bottom sheet on the phone): title, "Mark all read", the list, an empty note.
struct InboxCard: View {
    let palette: Palette
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone

    var body: some View {
        let p = palette
        let inbox = shell.inbox
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("Notifications").font(.web(phone ? 15 : 14, 600)).foregroundStyle(p.text.color)
                Spacer(minLength: 0)
                if inbox.unread > 0 {
                    Button { inbox.markAll(session) } label: {
                        HStack(spacing: 4) {
                            Icon("check-check", 14, p.text2.color)
                            Text("Mark all read").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                        }
                        .padding(.horizontal, 8).frame(height: phone ? 36 : 28)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            Rectangle().fill(p.border.color).frame(height: 1)
            content(inbox, p).padding(4)
        }
        .frame(width: width, alignment: .leading)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .shadowLg(p)
        .onAppear { inbox.refresh(session, list: true) }
    }

    @ViewBuilder private func content(_ inbox: InboxModel, _ p: Palette) -> some View {
        if !inbox.loaded {
            Text(inbox.error ?? "Loading…").font(.web(12.5)).foregroundStyle((inbox.error == nil ? p.textMuted : p.danger).color)
                .padding(.horizontal, 12).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if inbox.items.isEmpty {
            Text("You’re all caught up. Mentions, replies and shares show up here.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ListBox(count: inbox.items.count + (inbox.nextBefore == nil ? 0 : 2), height: listHeight) {
                ForEach(inbox.items, id: \.id) { n in row(n, inbox, p) }
                if inbox.nextBefore != nil {
                    Button { inbox.loadMore(session) } label: {
                        Text(inbox.loadingMore ? "Loading…" : "Load more").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                            .frame(maxWidth: .infinity).frame(height: 36).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle(radius: 8, pressed: p.bgHover.color))
                    .disabled(inbox.loadingMore)
                }
            }
        }
    }

    private static let icons = ["mention": "at-sign", "comment": "message-square", "shared": "share-2", "invite": "user-plus",
                                "assigned": "user-plus", "reminder": "alarm-clock"]

    private func person(_ id: String?) -> (name: String, color: String)? {
        guard let id else { return nil }
        if let m = session.members.first(where: { $0.id == id }) { return (m.name, m.color) }
        return session.preview ? LookData.people[id] : nil
    }

    private func row(_ n: AppNotification, _ inbox: InboxModel, _ p: Palette) -> some View {
        Button { inbox.open(n, session, shell) } label: {
            HStack(alignment: .top, spacing: 10) {
                if let who = person(n.actorId) {
                    AvatarView(name: who.name, color: PlatformColor(css: who.color), size: 28)
                } else {
                    Circle().fill(p.bgSubtle.color).frame(width: 28, height: 28)
                        .overlay(Icon(Self.icons[n.kind] ?? "bell", 15, p.text2.color))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(n.title).font(.web(13, n.isRead ? 400 : 600)).foregroundStyle(p.text.color)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    if !n.body.isEmpty {
                        Text(n.body).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
                    }
                    Text(Self.ago(n.createdAt)).font(.web(12)).foregroundStyle(p.textMuted.color)
                }
                Spacer(minLength: 0)
                if !n.isRead {
                    Circle().fill(p.accent.color).frame(width: 8, height: 8).padding(.top, 6)
                        .accessibilityLabel("unread")
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 8, pressed: p.bgHover.color))
    }

    /// "6 minutes ago" (the web's `formatDistanceToNow(…, { addSuffix: true })`).
    private static func ago(_ iso: String) -> String {
        guard let d = Due.instant(iso) else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: d, relativeTo: Date())
    }
}
