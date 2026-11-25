import NotiveloCore
import SwiftUI

// Workspace members and invites, and joining by invite link. They look like the sharing dialogs (Sheets.swift).
// Core calls: workspacePeople, inviteMember, resendInvite, revokeInvite, setMemberRole, removeMember, leaveWorkspace,
// inviteInfo, acceptInvite.

private func looksLikeEmail(_ s: String) -> Bool {
    let parts = s.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !s.contains(" ") else { return false }
    let host = parts[1]
    return host.contains(".") && !host.hasPrefix(".") && !host.hasSuffix(".")
}

/// The workspace's people (MembersPanel.tsx): members with their roles, pending invites (owners and admins), an invite
/// field, and "Leave workspace".
struct MembersCard: View {
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var data: WorkspacePeople?
    @State private var email = ""
    @State private var role = "member"
    @State private var busy = false
    @State private var error: String?
    @State private var inviteUrl: String?
    @State private var copied = false
    @State private var confirmLeave = false
    @FocusState private var focused: Bool
    let theme = Theme.shared

    private var myRole: String { session.workspace?.role ?? "member" }
    private var canManage: Bool { myRole == "owner" || myRole == "admin" }
    private var roles: [String] { myRole == "owner" ? ["owner", "admin", "member", "viewer"] : ["admin", "member", "viewer"] }

    /// In Settings (Workspace > Members) the list sits on the page; as a sheet it is a dialog with Done.
    var embedded = false

    private var intro: String {
        "People in “\(session.workspace?.name ?? "Workspace")”." + (canManage ? " Invite someone by email, or change what a member can do." : "")
    }

    @ViewBuilder private func inner(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if canManage { inviteRow(p) }
            if let inviteUrl { inviteBox(inviteUrl, p) }
            if let error { SheetNote(text: error, danger: true) }
            list(p)
        }
    }

    var body: some View {
        let p = theme.chrome
        let name = session.workspace?.name ?? "Workspace"
        if embedded {
            SettingsCard(detail: intro) {
                VStack(alignment: .leading, spacing: 12) {
                    inner(p)
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        if confirmLeave {
                            DialogButton(title: "Cancel") { confirmLeave = false }
                            DialogButton(title: "Leave “\(name)”", style: .danger, enabled: !busy) { leave() }
                        } else {
                            DialogButton(title: "Leave workspace") { confirmLeave = true }
                        }
                    }
                }
            }
            .onAppear { load() }
        } else {
            DialogCard(title: "Members", description: intro, width: width, close: { shell.sheet = nil }) {
                inner(p)
            } foot: {
                if confirmLeave {
                    DialogButton(title: "Cancel") { confirmLeave = false }
                    DialogButton(title: "Leave “\(name)”", style: .danger, enabled: !busy) { leave() }
                } else {
                    DialogButton(title: "Leave workspace") { confirmLeave = true }
                    DialogButton(title: "Done", style: .primary) { shell.sheet = nil }
                }
            }
            .onAppear { load() }
        }
    }

    private func inviteRow(_ p: Palette) -> some View {
        let ok = !busy && looksLikeEmail(email.trimmingCharacters(in: .whitespaces))
        return HStack(spacing: 8) {
            DialogField(label: nil, placeholder: "Email address", text: $email, icon: "mail", focused: $focused) { if ok { invite() } }
            roleMenu(role, p) { role = $0 }
            DialogButton(title: "Invite", style: .primary, enabled: ok) { invite() }
        }
    }

    private func roleMenu(_ current: String, _ p: Palette, enabled: Bool = true, _ pick: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(roles, id: \.self) { r in Button(r.capitalized) { pick(r) } }
        } label: {
            HStack(spacing: 4) {
                Text(current.capitalized).font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                if enabled { Icon("chevron-down", 12, p.textMuted.color) }
            }
            .padding(.horizontal, 8).frame(height: 28)
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(p.border.color, lineWidth: 1))
        }
        .disabled(!enabled)
        .buttonStyle(.plain)
        .fixedSize()
    }

    @ViewBuilder private func list(_ p: Palette) -> some View {
        if let data {
            ListBox(count: data.members.count + data.invites.count, height: listHeight) {
                ForEach(data.members, id: \.id) { m in memberRow(m, p) }
                if !data.invites.isEmpty {
                    Text("PENDING INVITES").font(.web(11, 600)).tracking(0.5).foregroundStyle(p.textMuted.color)
                        .padding(.top, 10).padding(.bottom, 2)
                    ForEach(data.invites, id: \.email) { i in inviteLine(i, p) }
                }
            }
        } else if error == nil {
            SheetNote(text: "Loading…")
        }
    }

    private func memberRow(_ m: WorkspaceMember, _ p: Palette) -> some View {
        let me = m.id == session.user?.id
        // Only an owner changes or removes an owner.
        let editable = canManage && !me && (m.role != "owner" || myRole == "owner")
        return HStack(spacing: 6) {
            PersonLine(name: m.name, email: m.email, color: m.color, chip: me ? "you" : nil)
            roleMenu(m.role, p, enabled: editable) { setRole(m, $0) }
            if editable { sheetIconButton("x", "Remove \(m.name)", p) { remove(m) } }
        }
        .padding(.vertical, 4)
    }

    private func inviteLine(_ i: PendingInvite, _ p: Palette) -> some View {
        HStack(spacing: 6) {
            Circle().fill(p.bgSubtle.color).frame(width: 28, height: 28).overlay(Icon("mail", 14, p.textMuted.color))
            VStack(alignment: .leading, spacing: 1) {
                Text(i.email).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                Text("Invited as \(i.role)").font(.web(12)).foregroundStyle(p.textMuted.color)
            }
            Spacer(minLength: 0)
            Button { resend(i) } label: {
                Text("Resend").font(.web(12.5, 500)).foregroundStyle(p.text2.color).padding(.horizontal, 8).frame(height: 28)
            }
            .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
            sheetIconButton("x", "Cancel the invite for \(i.email)", p) { revoke(i) }
        }
        .padding(.vertical, 4)
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

    private func fail(_ e: Error) {
        busy = false
        if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
    }

    private func load() {
        guard let ws = session.workspaceId else { return }
        session.call({ try $0.workspacePeople(workspaceId: ws) }) { result in
            switch result {
            case let .success(d): data = d
            case let .failure(e): fail(e)
            }
        }
    }

    /// The list again, and the session's own members (the assignee and share pickers read them).
    private func refresh() {
        busy = false
        load()
        session.loadLookups()
    }

    private func invite() {
        guard let ws = session.workspaceId else { return }
        let to = email.trimmingCharacters(in: .whitespaces)
        let r = role
        busy = true
        error = nil
        copied = false
        session.call({ try $0.inviteMember(workspaceId: ws, email: to, role: r) }) { result in
            switch result {
            case let .success(res):
                email = ""
                if res.status == "invited" {
                    // Always offered, in case the email lands in spam or the server sends none.
                    inviteUrl = res.inviteUrl
                    shell.say(res.emailed ? "Invite sent to \(to). You can also copy the link." : "Invite created for \(to): copy the link.")
                } else {
                    inviteUrl = nil
                    shell.say("\(to) is a member now")
                }
                refresh()
            case let .failure(e): fail(e)
            }
        }
    }

    private func resend(_ i: PendingInvite) {
        guard let ws = session.workspaceId else { return }
        error = nil
        copied = false
        session.call({ try $0.resendInvite(workspaceId: ws, email: i.email) }) { result in
            switch result {
            case let .success(res):
                inviteUrl = res.inviteUrl
                shell.say(res.emailed ? "Invite sent again to \(i.email)" : "New link made for \(i.email): copy it.")
                load()
            case let .failure(e): fail(e)
            }
        }
    }

    private func revoke(_ i: PendingInvite) {
        guard let ws = session.workspaceId else { return }
        error = nil
        session.call({ try $0.revokeInvite(workspaceId: ws, email: i.email) }) { result in
            switch result {
            case .success: load()
            case let .failure(e): fail(e)
            }
        }
    }

    private func setRole(_ m: WorkspaceMember, _ r: String) {
        guard let ws = session.workspaceId, r != m.role else { return }
        error = nil
        session.call({ try $0.setMemberRole(workspaceId: ws, userId: m.id, role: r) }) { result in
            switch result {
            case .success:
                shell.say("\(m.name) is \(r) now")
                refresh()
            case let .failure(e): fail(e)
            }
        }
    }

    private func remove(_ m: WorkspaceMember) {
        guard let ws = session.workspaceId else { return }
        error = nil
        session.call({ try $0.removeMember(workspaceId: ws, userId: m.id) }) { result in
            switch result {
            case .success:
                shell.say("Removed \(m.name)")
                refresh()
            case let .failure(e): fail(e)
            }
        }
    }

    private func leave() {
        guard let ws = session.workspaceId else { return }
        busy = true
        error = nil
        session.call({ try $0.leaveWorkspace(workspaceId: ws) }) { result in
            switch result {
            case .success:
                shell.sheet = nil
                shell.say("You left the workspace")
                session.leftWorkspace(ws)
            case let .failure(e):
                confirmLeave = false
                fail(e)
            }
        }
    }
}

// MARK: Join by invite link

/// An invite link (InvitePage.tsx): paste the link or its last part, see what it is for, accept. The account's email
/// must be the invited one (the server says so otherwise).
struct JoinInviteCard: View {
    let token: String?
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var text = ""
    @State private var info: InviteInfo?
    @State private var shownToken = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool
    let theme = Theme.shared

    /// The token of a pasted link (`…/invite/<token>`) or the token itself.
    static func token(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let path = URL(string: trimmed)?.pathComponents.filter { $0 != "/" } ?? []
        if let i = path.firstIndex(where: { $0 == "invite" || $0 == "invites" }), i + 1 < path.count { return path[i + 1] }
        return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    }

    var body: some View {
        let p = theme.chrome
        DialogCard(title: "Join with an invite link", width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 12) {
                if let info {
                    infoBox(info, p)
                } else {
                    DialogField(label: "Invite link", placeholder: "Paste the link from your email", text: $text, icon: "link-2", focused: $focused) { look() }
                }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Cancel") { shell.sheet = nil }
            if let info {
                DialogButton(title: busy ? "Joining…" : (info.page != nil ? "Open the page" : "Join"), style: .primary, enabled: !busy && !info.expired) { accept() }
            } else {
                DialogButton(title: busy ? "Looking…" : "Continue", style: .primary,
                             enabled: !busy && !text.trimmingCharacters(in: .whitespaces).isEmpty) { look() }
            }
        }
        .onAppear {
            if let token, !token.isEmpty {
                text = token
                look()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true }
            }
        }
    }

    private func infoBox(_ i: InviteInfo, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let page = i.page {
                Text("\(i.invitedByName) shared “\(page.title.isEmpty ? "Untitled" : page.title)” with you")
                    .font(.web(14, 500)).foregroundStyle(p.text.color)
                Text("In “\(i.workspaceName)”. You can \(page.canEdit ? "edit" : "view") it.").font(.web(13)).foregroundStyle(p.text2.color)
            } else {
                Text("\(i.invitedByName) invited you to “\(i.workspaceName)”").font(.web(14, 500)).foregroundStyle(p.text.color)
                Text("You join as \(i.role).").font(.web(13)).foregroundStyle(p.text2.color)
            }
            Text("Sent to \(i.email). Only that account can accept it.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
            if i.expired { SheetNote(text: "This invite has expired. Ask for a new one.", danger: true) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
    }

    private func look() {
        let t = Self.token(from: text)
        guard !t.isEmpty, !busy else { return }
        busy = true
        error = nil
        session.call({ try $0.inviteInfo(token: t) }) { result in
            busy = false
            switch result {
            case let .success(i):
                info = i
                shownToken = t
            case let .failure(e):
                if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
            }
        }
    }

    private func accept() {
        busy = true
        error = nil
        let t = shownToken
        let name = info?.workspaceName ?? "the workspace"
        let isPage = info?.page != nil
        session.call({ try $0.acceptInvite(token: t) }) { result in
            busy = false
            switch result {
            case let .success(a):
                shell.sheet = nil
                session.joined(a)
                if let pageId = a.pageId { shell.open(page: pageId) }
                shell.say(isPage ? "The page is shared with you" : "You joined “\(name)”")
            case let .failure(e):
                if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
            }
        }
    }
}
