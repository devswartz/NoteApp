import NotiveloCore
import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// The dialogs that need the server: sharing a page or a notebook, version history, the Trash, and the locked pages' password.
// They look like the tree dialogs (`DialogCard`, `DialogField`, `DialogButton` in Dialogs.swift) and are shown by `DialogLayer`.
// Core calls: pageShares, sharePageWithMember, sharePageByEmail, setPageShareEdit, removePageShare, revokePageInvite,
// notebookShares, setNotebookShares, setNotebookVisibility, pageVersions, pageVersion, restoreVersion, trash,
// restoreFromTrash, deleteForever, emptyTrash, setLockedNotesPassword, lockPage, removePageLock.

enum LockMode: Equatable {
    case setPassword
    case changePassword
    case lockPage(String)
    case removeLock(String)
}

enum ShellSheet: Equatable {
    case sharePage(String)
    case shareNotebook(String)
    case history(String)
    case trash
    case lock(LockMode)
    case quickAdd(QuickAddSeed)
    case members
    /// Join by invite link: the token when a link was opened in the app, nil to paste one.
    case joinInvite(String?)
    /// Settings > Profile > Delete account.
    case deleteAccount
    /// Templates: save the open page as one, a new page from one, a section's default, rename and delete a saved one.
    case saveTemplate(String)
    case newFromTemplate(String)
    case defaultTemplate(String)
    case renameTemplate(String)
    case deleteTemplate(String)
    /// Workspace management: new, delete, leave; teams and tags (`WorkspaceDialogs.swift`).
    case workspaceDialog(WorkspaceDialog)
}

func copyToClipboard(_ text: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = text
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #endif
}

// MARK: Small parts

/// A list that scrolls when it is long and is just as tall as its rows when it is short.
struct ListBox<Content: View>: View {
    let count: Int
    let height: CGFloat
    @ViewBuilder let content: () -> Content

    var body: some View {
        if count > 4 {
            ScrollView { VStack(alignment: .leading, spacing: 0) { content() } }
                .frame(height: height)
        } else {
            VStack(alignment: .leading, spacing: 0) { content() }
        }
    }
}

struct SheetNote: View {
    let text: String
    var danger = false
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        Text(text).font(.web(12.5)).foregroundStyle((danger ? p.danger : p.textMuted).color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct Chip: View {
    let text: String
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        Text(text).font(.web(11, 500)).foregroundStyle(p.textMuted.color)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .overlay(Capsule().stroke(p.border.color, lineWidth: 1))
    }
}

/// "Can edit" | "Can view".
private struct LevelSegments: View {
    let canEdit: Bool
    let set: (Bool) -> Void
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        HStack(spacing: 2) {
            segment("Can edit", on: canEdit) { set(true) }
            segment("Can view", on: !canEdit) { set(false) }
        }
        .padding(2)
        .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
    }

    private func segment(_ title: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        let p = theme.chrome
        return Button(action: action) {
            Text(title).font(.web(12.5, 500)).foregroundStyle((on ? p.text : p.text2).color)
                .padding(.horizontal, 10).frame(height: 26)
                .background(on ? p.bg.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// A person: avatar, name and address.
struct PersonLine: View {
    let name: String
    let email: String
    let color: String
    var chip: String?
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        HStack(spacing: 10) {
            AvatarView(name: name, color: PlatformColor(css: color), size: 28)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(name).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                    if let chip { Chip(text: chip) }
                }
                Text(email).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}

func sheetIconButton(_ icon: String, _ label: String, _ p: Palette, _ action: @escaping () -> Void) -> some View {
    Button(action: action) { Icon(icon, 15, p.textMuted.color).frame(width: 32, height: 32) }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
        .accessibilityLabel(label)
}

// MARK: Share a page

/// The web's `PageShareDialog`: people with "Can view" or "Can edit" on this one page, by member or (owners and admins) by email.
struct PageShareCard: View {
    let pageId: String
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var data: PageShares?
    @State private var q = ""
    @State private var canEdit = true
    @State private var busy = false
    @State private var inviteUrl: String?
    @State private var error: String?
    @State private var copied = false
    @FocusState private var focused: Bool
    let theme = Theme.shared

    private var canShareOutside: Bool {
        let role = session.workspace?.role
        return role == "owner" || role == "admin"
    }

    /// Members matching the typed words who don't have the page yet.
    private func matches(_ needle: String) -> [WorkspaceMember] {
        if needle.isEmpty { return [] }
        var sharedIds = Set<String>()
        for s in data?.shares ?? [] { sharedIds.insert(s.userId) }
        var out: [WorkspaceMember] = []
        for m in session.members {
            if m.id == session.user?.id || sharedIds.contains(m.id) { continue }
            let text = (m.name + " " + m.email).lowercased()
            if text.contains(needle) { out.append(m) }
            if out.count == 6 { break }
        }
        return out
    }

    private static func looksLikeEmail(_ s: String) -> Bool {
        let parts = s.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !s.contains(" ") else { return false }
        let host = parts[1]
        return host.contains(".") && !host.hasPrefix(".") && !host.hasSuffix(".")
    }

    var body: some View {
        let p = theme.chrome
        let title = session.shownTree?.pages.first { $0.id == pageId }?.title
            ?? session.sharedPages.first { $0.id == pageId }?.title ?? ""
        let needle = q.trimmingCharacters(in: .whitespaces).lowercased()
        let suggestions = matches(needle)
        let isEmail = Self.looksLikeEmail(needle)
        let byEmail = session.members.first { $0.email.lowercased() == needle }
        let outside = isEmail && byEmail == nil
        let canSubmit = !busy && (suggestions.count == 1 || byEmail != nil || (outside && canShareOutside))
        DialogCard(title: "Share “\(title.isEmpty ? "Untitled" : title)”",
                   description: canShareOutside
                       ? "Only this page, not its notebook or other pages. You can also share it with people outside the workspace by email."
                       : "Only this page, not its notebook or other pages. You can share it with members of this workspace.",
                   width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 12) {
                DialogField(label: nil, placeholder: canShareOutside ? "Name or email" : "Name or email of a member", text: $q, icon: "search", focused: $focused) {
                    submit(suggestions, byEmail, outside, canSubmit)
                }
                HStack(spacing: 8) {
                    LevelSegments(canEdit: canEdit) { canEdit = $0 }
                    Spacer(minLength: 0)
                    DialogButton(title: "Share", style: .primary, enabled: canSubmit) { submit(suggestions, byEmail, outside, canSubmit) }
                }
                if outside && !canShareOutside {
                    SheetNote(text: "\(q.trimmingCharacters(in: .whitespaces)) isn’t a member of this workspace. Ask a workspace owner or admin to share with people outside it.")
                }
                if !suggestions.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(suggestions, id: \.id) { m in
                            Button { add(userId: m.id, email: nil, label: m.name) } label: {
                                HStack {
                                    PersonLine(name: m.name, email: m.email, color: m.color, chip: m.role == "viewer" ? "view only" : nil)
                                }
                                .padding(.vertical, 4).padding(.horizontal, 6)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                            .disabled(busy)
                        }
                    }
                }
                if let inviteUrl { inviteBox(inviteUrl, p) }
                if let error { SheetNote(text: error, danger: true) }
                peopleList(p)
                PublicLinkSection(pageId: pageId)
            }
        } foot: {
            DialogButton(title: "Done", style: .primary) { shell.sheet = nil }
        }
        .onAppear {
            load()
            if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } }
        }
    }

    private func inviteBox(_ url: String, _ p: Palette) -> some View {
        HStack(spacing: 8) {
            Text(url).font(.system(size: 12, design: .monospaced)).foregroundStyle(p.text2.color).lineLimit(2).truncationMode(.middle)
            Spacer(minLength: 0)
            Button {
                copyToClipboard(url)
                copied = true
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

    @ViewBuilder private func peopleList(_ p: Palette) -> some View {
        if let data {
            if data.shares.isEmpty && data.invites.isEmpty {
                SheetNote(text: "Not shared with anyone yet.")
            } else {
                ListBox(count: data.shares.count + data.invites.count, height: listHeight) {
                    ForEach(data.shares, id: \.userId) { s in shareRow(s, p) }
                    ForEach(data.invites, id: \.email) { i in inviteRow(i, p) }
                }
            }
        } else if error == nil {
            SheetNote(text: "Loading…")
        }
    }

    private func shareRow(_ s: PageShareEntry, _ p: Palette) -> some View {
        // A member's rights are the smaller of the share and their role: a viewer only views.
        let viewerOnly = s.member && session.members.first { $0.id == s.userId }?.role == "viewer"
        let edit = s.canEdit && !viewerOnly
        return HStack(spacing: 6) {
            PersonLine(name: s.name, email: s.email, color: s.color, chip: s.member ? nil : "outside the workspace")
            Button { setEdit(s, !edit) } label: {
                HStack(spacing: 4) {
                    Text(edit ? "Can edit" : "Can view").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                    if !viewerOnly { Icon("chevron-down", 12, p.textMuted.color) }
                }
                .padding(.horizontal, 8).frame(height: 28)
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(p.border.color, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(viewerOnly)
            sheetIconButton("x", "Stop sharing with \(s.name)", p) { remove(s) }
        }
        .padding(.vertical, 4)
    }

    private func inviteRow(_ i: PageInviteEntry, _ p: Palette) -> some View {
        HStack(spacing: 6) {
            Circle().fill(p.bgSubtle.color).frame(width: 28, height: 28)
                .overlay(Icon("mail", 14, p.textMuted.color))
            VStack(alignment: .leading, spacing: 1) {
                Text(i.email).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                Text("Invited: can \(i.canEdit ? "edit" : "view") once they sign up").font(.web(12)).foregroundStyle(p.textMuted.color)
            }
            Spacer(minLength: 0)
            sheetIconButton("x", "Cancel the invite for \(i.email)", p) { revoke(i) }
        }
        .padding(.vertical, 4)
    }

    private func fail(_ e: Error) {
        if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
    }

    private func load() {
        if session.preview {
            data = PageShares(shares: [
                PageShareEntry(userId: "ana", name: "Ana Silva", email: "ana@example.com", color: "#ec4899", canEdit: true, member: true),
                PageShareEntry(userId: "chen", name: "Chen Wei", email: "chen@example.com", color: "#10b981", canEdit: false, member: true),
            ], invites: [])
            return
        }
        session.call({ try $0.pageShares(pageId: pageId) }) { result in
            switch result {
            case let .success(shares): data = shares
            case let .failure(e): fail(e)
            }
        }
    }

    private func submit(_ suggestions: [WorkspaceMember], _ byEmail: WorkspaceMember?, _ outside: Bool, _ ok: Bool) {
        guard ok else { return }
        if let byEmail {
            add(userId: byEmail.id, email: nil, label: byEmail.name)
        } else if suggestions.count == 1, !outside {
            add(userId: suggestions[0].id, email: nil, label: suggestions[0].name)
        } else if outside {
            let email = q.trimmingCharacters(in: .whitespaces)
            add(userId: nil, email: email, label: email)
        }
    }

    private func add(userId: String?, email: String?, label: String) {
        busy = true
        error = nil
        let edit = canEdit
        session.call({ core -> PageShareResult in
            if let userId { return try core.sharePageWithMember(pageId: pageId, userId: userId, canEdit: edit) }
            return try core.sharePageByEmail(pageId: pageId, email: email ?? "", canEdit: edit)
        }) { result in
            busy = false
            switch result {
            case let .success(r):
                data = r.shares
                q = ""
                copied = false
                if r.status == "invited" {
                    // Always offered, in case the email lands in spam or the server sends none.
                    inviteUrl = r.inviteUrl
                    shell.say(r.emailed ? "Invite sent to \(label). You can also copy the link." : "Invite created for \(label): copy the link.")
                } else {
                    inviteUrl = nil
                    shell.say("Shared with \(label)")
                }
            case let .failure(e):
                fail(e)
            }
        }
    }

    private func setEdit(_ s: PageShareEntry, _ edit: Bool) {
        error = nil
        session.call({ try $0.setPageShareEdit(pageId: pageId, userId: s.userId, canEdit: edit) }) { result in
            switch result {
            case let .success(shares): data = shares
            case let .failure(e): fail(e)
            }
        }
    }

    private func remove(_ s: PageShareEntry) {
        error = nil
        session.call({ try $0.removePageShare(pageId: pageId, userId: s.userId) }) { result in
            switch result {
            case let .success(shares):
                data = shares
                shell.say("Stopped sharing with \(s.name)")
            case let .failure(e):
                fail(e)
            }
        }
    }

    private func revoke(_ i: PageInviteEntry) {
        error = nil
        session.call({ try $0.revokePageInvite(pageId: pageId, email: i.email) }) { result in
            switch result {
            case let .success(shares): data = shares
            case let .failure(e): fail(e)
            }
        }
    }
}

// MARK: Share a notebook

/// The web's `ShareDialog`: who sees a notebook: the whole workspace, or only its creator and the people picked.
struct NotebookShareCard: View {
    let notebookId: String
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var visibility = "shared"
    @State private var userIds: [String] = []
    @State private var createdBy = ""
    @State private var loaded = false
    @State private var error: String?
    let theme = Theme.shared

    private var isCreator: Bool { loaded && createdBy == session.user?.id }

    var body: some View {
        let p = theme.chrome
        let name = session.shownTree?.notebooks.first { $0.id == notebookId }?.name ?? "notebook"
        let others = session.members.filter { $0.id != createdBy }
        DialogCard(title: "Share “\(name)”", description: "Choose who can see this notebook.", width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 10) {
                choice("shared", "Everyone in the workspace", "Members can edit; viewers can read.", p)
                choice("private", "Only people I pick", "Only \(isCreator ? "you" : "its creator") and the people you pick below.", p)
                if visibility == "private" {
                    if others.isEmpty {
                        SheetNote(text: "No one else is in this workspace yet.")
                    } else {
                        ListBox(count: others.count, height: listHeight) {
                            ForEach(others, id: \.id) { m in
                                let on = userIds.contains(m.id)
                                Button { toggle(m.id) } label: {
                                    HStack(spacing: 8) {
                                        PersonLine(name: m.name, email: m.email, color: m.color, chip: m.role == "viewer" ? "view only" : nil)
                                        Mark(on: on, round: false, p: p)
                                    }
                                    .padding(.vertical, 4).padding(.horizontal, 6)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                                .disabled(!isCreator)
                            }
                        }
                    }
                }
                if loaded && !isCreator { SheetNote(text: "Only the notebook’s creator can change who sees it.") }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Done", style: .primary) { shell.sheet = nil }
        }
        .onAppear(perform: load)
    }

    private func choice(_ value: String, _ title: String, _ detail: String, _ p: Palette) -> some View {
        let active = visibility == value
        return Button { choose(value) } label: {
            HStack(alignment: .top, spacing: 10) {
                Mark(on: active, round: true, p: p)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.web(14, 600)).foregroundStyle(p.text.color)
                    Text(detail).font(.web(12)).foregroundStyle(p.textMuted.color).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? p.accentSoft.color : p.bg.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(active ? p.accent.color : p.border.color, lineWidth: active ? 2 : 1))
        }
        .buttonStyle(.plain)
        .disabled(!isCreator)
        .opacity(loaded && !isCreator ? 0.7 : 1)
    }

    private func fail(_ e: Error) {
        if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
    }

    private func load() {
        session.call({ try $0.notebookShares(notebookId: notebookId) }) { result in
            switch result {
            case let .success(s):
                visibility = s.visibility
                userIds = s.userIds
                createdBy = s.createdBy
                loaded = true
            case let .failure(e):
                fail(e)
            }
        }
    }

    private func choose(_ value: String) {
        guard isCreator, value != visibility else { return }
        error = nil
        session.changeTree({ core, _ in try core.setNotebookVisibility(notebookId: notebookId, visibility: value) }) { result in
            switch result {
            case .success:
                visibility = value
                load()
            case let .failure(e):
                fail(e)
            }
        }
    }

    private func toggle(_ id: String) {
        guard isCreator else { return }
        var next = userIds
        if let i = next.firstIndex(of: id) { next.remove(at: i) } else { next.append(id) }
        userIds = next
        error = nil
        session.changeTree({ core, _ in try core.setNotebookShares(notebookId: notebookId, userIds: next) }) { result in
            switch result {
            case let .success(ids):
                userIds = ids
            case let .failure(e):
                fail(e)
                load()
            }
        }
    }
}

// MARK: Version history

/// The web's version history: the page's earlier versions, a preview of the chosen one, and "Restore".
struct VersionHistoryCard: View {
    let pageId: String
    let width: CGFloat
    let listHeight: CGFloat
    let previewHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var versions: [PageVersion]?
    @State private var selected: String?
    @State private var preview: String?
    @State private var restoring = false
    @State private var error: String?
    let theme = Theme.shared

    /// Restoring goes through the open live page.
    private var live: LivePageModel? {
        guard let live = shell.openLive, live.pageId == pageId else { return nil }
        return live
    }

    private var canRestore: Bool { live != nil && session.workspace?.role != "viewer" }

    private static func when(_ iso: String) -> String {
        Due.instant(iso).map { Due.format($0, "d MMM yyyy, HH:mm") } ?? iso
    }

    var body: some View {
        let p = theme.chrome
        DialogCard(title: "Version history", width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 10) {
                if let versions {
                    if versions.isEmpty {
                        SheetNote(text: "No earlier versions yet. Snapshots are taken every few minutes while a page is being edited.")
                    } else {
                        ListBox(count: versions.count, height: listHeight) {
                            ForEach(versions, id: \.id) { v in row(v, p) }
                        }
                        previewBox(p)
                    }
                } else if error == nil {
                    SheetNote(text: "Loading…")
                }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Close") { shell.sheet = nil }
            if canRestore, selected != nil {
                DialogButton(title: restoring ? "Restoring…" : "Restore this version", style: .primary, enabled: !restoring && preview != nil) { restore() }
            }
        }
        .onAppear(perform: load)
    }

    private func row(_ v: PageVersion, _ p: Palette) -> some View {
        let active = selected == v.id
        let who = v.authorId == nil ? "Unknown" : session.personName(v.authorId)
        let tag = v.reason == "restore" ? " · before restore" : v.reason == "manual" ? " · saved" : ""
        return Button { select(v.id) } label: {
            VStack(alignment: .leading, spacing: 1) {
                Text(Self.when(v.at)).font(.web(14, 500)).foregroundStyle(p.text.color)
                Text("\(who) · \(Due.ago(v.at))\(tag)").font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? p.accentSoft.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
    }

    @ViewBuilder private func previewBox(_ p: Palette) -> some View {
        if selected != nil {
            ScrollView {
                Text(preview ?? "Loading…")
                    .font(.web(13)).foregroundStyle((preview == nil ? p.textMuted : p.text).color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(height: previewHeight)
            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
        } else {
            SheetNote(text: "Select a version.")
        }
    }

    private func fail(_ e: Error) {
        if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
    }

    private func load() {
        session.call({ try $0.pageVersions(pageId: pageId) }) { result in
            switch result {
            case let .success(list):
                versions = list
                if let first = list.first { select(first.id) }
            case let .failure(e):
                versions = []
                fail(e)
            }
        }
    }

    private func select(_ id: String) {
        selected = id
        preview = nil
        error = nil
        session.call({ core -> String in
            let doc = try core.pageVersion(pageId: pageId, versionId: id)
            let text = try pageMarkdown(update: doc.document, title: doc.version.title, tasks: [:])
            return text.isEmpty ? "(an empty page)" : text
        }) { result in
            guard selected == id else { return }
            switch result {
            case let .success(text): preview = text
            case let .failure(e):
                preview = "Can’t show this version."
                fail(e)
            }
        }
    }

    private func restore() {
        guard let live, let id = selected else { return }
        restoring = true
        error = nil
        live.restore(versionId: id) { result in
            restoring = false
            switch result {
            case let .success(before):
                shell.sheet = nil
                var undo: (() -> Void)?
                if let before {
                    undo = { live.restore(versionId: before) { _ in shell.say("Back to the version before") } }
                }
                shell.say("Version restored", undo: undo)
            case let .failure(e):
                fail(e)
            }
        }
    }
}

// MARK: Trash

/// The workspace's Trash: what was deleted in the last 60 days, with Restore and Delete forever.
struct TrashCard: View {
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var entries: [TrashEntry]?
    /// The entry whose "Delete forever" was tapped once, or "all".
    @State private var confirming: String?
    @State private var error: String?
    let theme = Theme.shared

    private var canEmpty: Bool {
        let role = session.workspace?.role
        return role == "owner" || role == "admin"
    }

    var body: some View {
        let p = theme.chrome
        DialogCard(title: "Trash", description: "Deleted pages, sections and notebooks stay here for 60 days.", width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 10) {
                if let entries {
                    if entries.isEmpty {
                        SheetNote(text: "The Trash is empty.")
                    } else {
                        ListBox(count: entries.count, height: listHeight) {
                            ForEach(entries, id: \.id) { e in row(e, p) }
                        }
                    }
                } else if error == nil {
                    SheetNote(text: "Loading…")
                }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            if canEmpty, let entries, !entries.isEmpty {
                if confirming == "all" {
                    DialogButton(title: "Empty it for good", style: .danger) { emptyAll() }
                } else {
                    DialogButton(title: "Empty Trash") { confirming = "all" }
                }
            }
            DialogButton(title: "Done", style: .primary) { shell.sheet = nil }
        }
        .onAppear(perform: load)
    }

    private func row(_ e: TrashEntry, _ p: Palette) -> some View {
        let icon = e.kind == .page ? "file-text" : e.kind == .section ? "folder" : "book-open"
        var detail = e.path.isEmpty ? "" : "\(e.path) · "
        detail += e.daysLeft == 1 ? "1 day left" : "\(e.daysLeft) days left"
        if e.pages > 1 || e.sections > 0 {
            detail += " · \(e.pages) \(e.pages == 1 ? "page" : "pages")"
        }
        return HStack(spacing: 8) {
            if let emoji = e.icon, !emoji.isEmpty, e.kind == .page {
                Text(emoji).font(.system(size: 15)).frame(width: 18)
            } else {
                Icon(icon, 15, p.textMuted.color).frame(width: 18)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(e.name.isEmpty ? "Untitled" : e.name).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                Text(detail).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
            }
            Spacer(minLength: 0)
            if confirming == e.id {
                DialogButton(title: "Delete forever", style: .danger) { deleteForever(e) }
            } else {
                Button { restore(e) } label: {
                    Text("Restore").font(.web(12.5, 500)).foregroundStyle(p.accent.color).padding(.horizontal, 8).frame(height: 28)
                }
                .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                sheetIconButton("trash", "Delete \(e.name) forever", p) { confirming = e.id }
            }
        }
        .padding(.vertical, 4)
    }

    private func fail(_ e: Error) {
        if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
    }

    private func load() {
        guard let ws = session.workspaceId else { return }
        session.call({ try $0.trash(workspaceId: ws) }) { result in
            switch result {
            case let .success(list): entries = list
            case let .failure(e):
                entries = []
                fail(e)
            }
        }
    }

    private func restore(_ e: TrashEntry) {
        error = nil
        session.changeTree({ core, ws in try core.restoreFromTrash(workspaceId: ws, kind: e.kind, id: e.id) }) { result in
            switch result {
            case let .success(place):
                entries?.removeAll { $0.id == e.id }
                shell.say(place.map { "Restored to \($0)" } ?? "Restored")
                session.scheduleTaskRefresh()
            case let .failure(err):
                fail(err)
            }
        }
    }

    private func deleteForever(_ e: TrashEntry) {
        error = nil
        confirming = nil
        session.changeTree({ core, ws -> Void in try core.deleteForever(workspaceId: ws, kind: e.kind, id: e.id) }) { result in
            switch result {
            case .success:
                entries?.removeAll { $0.id == e.id }
                session.scheduleTaskRefresh()
            case let .failure(err):
                fail(err)
            }
        }
    }

    private func emptyAll() {
        error = nil
        confirming = nil
        session.changeTree({ core, ws in try core.emptyTrash(workspaceId: ws) }) { result in
            switch result {
            case .success:
                entries = []
                session.scheduleTaskRefresh()
            case let .failure(err):
                fail(err)
            }
        }
    }
}

// MARK: Locked pages' password

/// Set or change the locked pages' password, lock a page, or take a page's lock off (it asks for the password).
struct LockCard: View {
    let mode: LockMode
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var current = ""
    @State private var first = ""
    @State private var again = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var f1: Bool
    @FocusState private var f2: Bool
    @FocusState private var f3: Bool
    let theme = Theme.shared

    /// Which fields the card shows.
    private enum Form { case newPassword(withCurrent: Bool), confirm, password }

    private var hasPassword: Bool { session.lockStatus?.hasPassword ?? true }

    private var form: Form {
        switch mode {
        case .setPassword: return .newPassword(withCurrent: false)
        case .changePassword: return .newPassword(withCurrent: true)
        case .lockPage: return hasPassword ? .confirm : .newPassword(withCurrent: false)
        case .removeLock: return .password
        }
    }

    private var title: String {
        switch mode {
        case .setPassword: return "Locked pages password"
        case .changePassword: return "Change locked pages password"
        case .lockPage: return "Lock this page"
        case .removeLock: return "Remove the lock"
        }
    }

    private var detail: String {
        switch (mode, form) {
        case (.lockPage, .confirm):
            return "Only you will be able to open it, with your locked pages password. A locked page can’t be shared or duplicated."
        case (.lockPage, _):
            return "Locked pages open with one password, separate from your sign-in password. Choose it now (6 characters or more)."
        case (.setPassword, _):
            return "One password opens all your locked pages. It is separate from your sign-in password (6 characters or more)."
        case (.changePassword, _):
            return "Changing it locks your other devices and removes their Face ID."
        case (.removeLock, _):
            return "The page becomes an ordinary page again. Enter your locked pages password."
        }
    }

    private var confirmLabel: String {
        switch mode {
        case .setPassword: return "Set password"
        case .changePassword: return "Change password"
        case .lockPage: return "Lock page"
        case .removeLock: return "Remove lock"
        }
    }

    private var ready: Bool {
        if busy { return false }
        switch form {
        case let .newPassword(withCurrent):
            let n = first.utf8.count
            return n >= 6 && n <= 72 && first == again && (!withCurrent || !current.isEmpty)
        case .confirm: return true
        case .password: return !current.isEmpty
        }
    }

    var body: some View {
        DialogCard(title: title, description: detail, width: width, close: { shell.sheet = nil }, hasBody: hasFields) {
            VStack(alignment: .leading, spacing: 10) {
                switch form {
                case let .newPassword(withCurrent):
                    if withCurrent {
                        DialogField(label: "Current password", placeholder: "", text: $current, secure: true, focused: $f1) { f2 = true }
                    }
                    DialogField(label: "New password", placeholder: "", text: $first, secure: true, focused: $f2) { f3 = true }
                    DialogField(label: "Repeat new password", placeholder: "", text: $again, secure: true, focused: $f3) { if ready { send() } }
                    if !again.isEmpty && first != again { SheetNote(text: "The two passwords differ.") }
                case .password:
                    DialogField(label: "Password", placeholder: "", text: $current, secure: true, focused: $f1) { if ready { send() } }
                case .confirm:
                    EmptyView()
                }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Cancel") { shell.sheet = nil }
            DialogButton(title: confirmLabel, style: .primary, enabled: ready) { send() }
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                switch form {
                case .newPassword(let withCurrent): if withCurrent { f1 = true } else { f2 = true }
                case .password: f1 = true
                case .confirm: break
                }
            }
        }
    }

    private var hasFields: Bool {
        if case .confirm = form { return error != nil }
        return true
    }

    private func finish(_ problem: String?, _ message: String) {
        busy = false
        if let problem {
            error = problem
        } else {
            shell.sheet = nil
            shell.say(message)
        }
    }

    private func send() {
        guard ready else { return }
        busy = true
        error = nil
        switch mode {
        case .setPassword:
            session.setLockPassword(first, current: nil) { finish($0, "Locked pages password set") }
        case .changePassword:
            session.setLockPassword(first, current: current) { finish($0, "Password changed") }
        case let .lockPage(id):
            if hasPassword {
                session.lock(page: id) { finish($0, "Page locked") }
            } else {
                session.setLockPassword(first, current: nil) { problem in
                    if let problem { finish(problem, "") } else { session.lock(page: id) { finish($0, "Page locked") } }
                }
            }
        case let .removeLock(id):
            session.removeLock(page: id, password: current) { finish($0, "Lock removed") }
        }
    }
}

/// A radio or tick box: the accent tick when on, an empty outline when off.
private struct Mark: View {
    let on: Bool
    let round: Bool
    let p: Palette

    var body: some View {
        Group {
            if on {
                Icon(round ? "circle-check" : "square-check", 18, p.accent.color)
            } else if round {
                Circle().stroke(p.textMuted.color, lineWidth: 1.5).frame(width: 16, height: 16)
            } else {
                RoundedRectangle(cornerRadius: 4, style: .continuous).stroke(p.textMuted.color, lineWidth: 1.5).frame(width: 16, height: 16)
            }
        }
        .frame(width: 18, height: 18)
    }
}
