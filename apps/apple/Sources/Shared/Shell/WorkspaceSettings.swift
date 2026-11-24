import NotiveloCore
import SwiftUI

// Workspace settings (Settings.tsx, the "Workspace" scope): General (rename, role, leave, delete), Teams, Tags, Activity.
// The look follows the web's cards and member rows; the calls are in `WorkspaceDialogs.swift` and the core
// (`renameWorkspace`, `createTeam` …, `renameTag` …, `activity`).

private let roleHelp = [
    "owner": "Full control, including deleting the workspace",
    "admin": "Manage members and all content",
    "member": "Create and edit pages and tasks",
    "viewer": "Read-only access to shared notebooks",
]

/// A small outlined button (the web's `.btn.btn-secondary`).
private struct SettingsButton: View {
    let title: String
    var icon: String?
    var danger = false
    var enabled = true
    let action: () -> Void
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let fg = danger ? Color.white : p.text.color
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Icon(icon, 15, fg) }
                Text(title).font(.web(14, 500)).foregroundStyle(fg)
            }
            .padding(.horizontal, 12).frame(height: 32)
            .background(danger ? p.danger.color : p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(danger ? Color.clear : p.border.color, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }
}

// MARK: General

struct WorkspaceGeneralSettings: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let ws = session.shownWorkspace
        let role = ws?.role ?? "member"
        let admin = role == "owner" || role == "admin"
        let changed = !name.trimmingCharacters(in: .whitespaces).isEmpty && name != ws?.name
        SettingsCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .bottom, spacing: 10) {
                    LetterTile(letter: ws?.name ?? "W", fill: AnyShapeStyle(p.accentSolid.color), size: 40, radius: 10, fontSize: 18)
                    DialogField(label: "Workspace name", placeholder: "Workspace name", text: $name, focused: $focused) { if admin && changed { rename() } }
                        .disabled(!admin).opacity(admin ? 1 : 0.7)
                    if admin { DialogButton(title: "Rename", style: .primary, enabled: changed && !busy) { rename() } }
                }
                if let error { SheetNote(text: error, danger: true) }
                (Text("Your role: ").foregroundStyle(p.textMuted.color) + Text(role).fontWeight(.semibold).foregroundStyle(p.text.color)
                    + Text(" — \(roleHelp[role] ?? "")").foregroundStyle(p.textMuted.color))
                    .font(.web(13))
            }
        }
        .onAppear { name = ws?.name ?? "" }
        .onChange(of: ws?.name) { _, new in name = new ?? "" }
        if role == "owner" {
            SettingsCard(title: "Danger zone", detail: "Deleting a workspace removes every notebook, page and task in it for everyone. This can’t be undone.") {
                SettingsButton(title: "Delete workspace", icon: "trash", danger: true) { shell.openSheet(.workspaceDialog(.deleteWorkspace), session, "Deleting a workspace") }
            }
        } else {
            SettingsCard(title: "Leave workspace", detail: "You lose access to its notebooks, pages and tasks until someone invites you again.") {
                SettingsButton(title: "Leave workspace", icon: "log-out") { shell.openSheet(.workspaceDialog(.leaveWorkspace), session, "Leaving a workspace") }
            }
        }
    }

    private func rename() {
        guard let ws = session.workspaceId else { return }
        let new = name.trimmingCharacters(in: .whitespaces)
        busy = true
        error = nil
        session.call({ try $0.renameWorkspace(workspaceId: ws, name: new) }) { r in
            busy = false
            switch r {
            case .success:
                session.refreshWorkspaces()
                shell.say("Workspace renamed")
            case let .failure(e):
                if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
            }
        }
    }
}

// MARK: Teams

struct TeamsSettings: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let admin = session.isAdmin
        let teams = session.orderedTeams
        SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                let desc = "A task can belong to a team, whoever it’s assigned to. Filter by team in All Tasks, group by team in Team, and type +team in quick add."
                    + (admin ? "" : " Owners and admins manage teams.")
                SettingsRow(title: "", detail: desc) {
                    if admin { SettingsButton(title: "New team", icon: "plus") { open(.newTeam(parent: nil)) } }
                }
                if teams.isEmpty {
                    emptyState("users-round", "No teams yet", admin ? "Create teams like “Elders” or “Staff”, with subteams one level deep." : "Owners and admins can create teams.", p)
                } else {
                    VStack(spacing: 0) {
                        ForEach(teams, id: \.id) { t in
                            TeamRow(team: t, admin: admin, open: open)
                        }
                    }
                }
            }
        }
        .onAppear { session.loadLookups() }
    }

    private func open(_ d: WorkspaceDialog) { shell.openSheet(.workspaceDialog(d), session, "Teams") }
}

private func emptyState(_ icon: String, _ title: String, _ detail: String, _ p: Palette) -> some View {
    VStack(spacing: 6) {
        Icon(icon, 22, p.textMuted.color)
        Text(title).font(.web(14, 600)).foregroundStyle(p.text.color)
        Text(detail).font(.web(13)).foregroundStyle(p.textMuted.color).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity).padding(.vertical, 20)
}

private struct TeamRow: View {
    let team: TaskTeam
    let admin: Bool
    let open: (WorkspaceDialog) -> Void
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let inTeam = session.shownMembers.filter { team.memberIds.contains($0.id) }
        HStack(spacing: 10) {
            if team.parentId != nil { Icon("corner-down-right", 14, p.textMuted.color) }
            Circle().fill(PlatformColor(css: team.color).color).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 1) {
                Text(team.name).font(.web(14, 500)).foregroundStyle(p.text.color).lineLimit(1)
                Text(inTeam.isEmpty ? "No members" : "\(inTeam.count) member\(inTeam.count == 1 ? "" : "s")")
                    .font(.web(12.5)).foregroundStyle(p.textMuted.color)
            }
            Spacer(minLength: 8)
            HStack(spacing: -6) {
                ForEach(inTeam.prefix(5), id: \.id) { m in
                    AvatarView(name: m.name, color: PlatformColor(css: m.color), size: 22)
                        .overlay(Circle().stroke(p.bgElevated.color, lineWidth: 2).padding(-1))
                }
            }
            if admin {
                SettingsButton(title: "Members") { open(.teamMembers(team.id)) }
                menu
            }
        }
        .padding(.leading, team.parentId == nil ? 0 : 20)
        .padding(.vertical, 8)
        .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    private var menu: some View {
        let p = theme.chrome
        return Menu {
            Button("Rename…") { open(.renameTeam(team.id)) }
            if team.parentId == nil { Button("Add subteam…") { open(.newTeam(parent: team.id)) } }
            Button("Move under…") { open(.moveTeam(team.id)) }
            Menu("Colour") {
                ForEach(workspaceColors, id: \.self) { c in
                    Button(c == team.color ? "✓ \(colourName(c))" : colourName(c)) { recolour(c) }
                }
            }
            Button("Delete team", role: .destructive) { open(.deleteTeam(team.id)) }
        } label: {
            Icon("ellipsis", 16, p.text2.color).frame(width: 32, height: 32).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private func recolour(_ c: String) {
        session.call({ try $0.recolorTeam(teamId: team.id, color: c) }) { r in
            if case .success = r { session.loadLookups() } else if case let .failure(e) = r, !(e is CancellationError) {
                shell.say(SessionModel.plainMessage(e))
            }
        }
    }
}

private func colourName(_ hex: String) -> String {
    let names = ["#6366f1": "Indigo", "#0ea5e9": "Sky", "#10b981": "Green", "#f59e0b": "Amber", "#ef4444": "Red",
                 "#ec4899": "Pink", "#8b5cf6": "Violet", "#14b8a6": "Teal", "#64748b": "Slate"]
    return names[hex.lowercased()] ?? hex
}

// MARK: Tags

struct TagsSettings: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let admin = session.isAdmin
        let tags = session.shownTags
        let open = session.shownTasks.filter { !session.isDone($0) }
        SettingsCard {
            VStack(alignment: .leading, spacing: 14) {
                Text("Tags are shared by everyone in the workspace. Anyone who can edit adds them from a task’s Tags field or with #tag in quick add."
                     + (admin ? " Here you can rename, recolour or delete them." : " Owners and admins can rename or delete them."))
                    .font(.web(13)).foregroundStyle(p.textMuted.color).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                if tags.isEmpty {
                    emptyState("tag", "No tags yet", "Add one from any task, e.g. “Waiting”.", p)
                } else {
                    VStack(spacing: 0) {
                        ForEach(tags, id: \.id) { t in
                            let n = open.filter { $0.tagIds.contains(t.id) }.count
                            tagRow(t, n, admin, p)
                        }
                    }
                }
            }
        }
        .onAppear { session.loadLookups() }
    }

    private func tagRow(_ t: TaskTag, _ n: Int, _ admin: Bool, _ p: Palette) -> some View {
        let c = PlatformColor(css: t.color).color
        return HStack(spacing: 10) {
            Text(t.name).font(.web(12.5, 500)).foregroundStyle(c)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(c.opacity(0.16), in: Capsule())
            Spacer(minLength: 8)
            if n > 0 { Text("\(n) open task\(n == 1 ? "" : "s")").font(.web(12.5)).foregroundStyle(p.textMuted.color) }
            if admin {
                Menu {
                    Button("Rename…") { shell.openSheet(.workspaceDialog(.renameTag(t.id)), session, "Tags") }
                    Menu("Colour") {
                        ForEach(workspaceColors, id: \.self) { col in
                            Button(col == t.color ? "✓ \(colourName(col))" : colourName(col)) { recolour(t, col) }
                        }
                    }
                    Button("Delete tag", role: .destructive) { shell.openSheet(.workspaceDialog(.deleteTag(t.id)), session, "Tags") }
                } label: {
                    Icon("ellipsis", 16, p.text2.color).frame(width: 32, height: 32).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        }
        .padding(.vertical, 6)
        .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    private func recolour(_ t: TaskTag, _ c: String) {
        session.call({ try $0.recolorTag(tagId: t.id, color: c) }) { r in
            if case .success = r { session.loadLookups() } else if case let .failure(e) = r, !(e is CancellationError) {
                shell.say(SessionModel.plainMessage(e))
            }
        }
    }
}

// MARK: Activity

struct ActivitySettings: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var items: [ActivityEntry] = []
    @State private var loaded = false
    @State private var more = false
    @State private var busy = false
    @State private var error: String?
    let theme = Theme.shared
    private static let pageSize: UInt32 = 50

    var body: some View {
        let p = theme.chrome
        VStack(alignment: .leading, spacing: 0) {
            if let error { SheetNote(text: error, danger: true).padding(.bottom, 8) }
            if loaded && items.isEmpty {
                Text("Nothing yet. Changes to pages, tasks and members will show up here.").font(.web(14)).foregroundStyle(p.textMuted.color)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i == 0 || dayLabel(items[i - 1]) != dayLabel(item) {
                    Text(dayLabel(item)).font(.web(12.5, 600)).foregroundStyle(p.textMuted.color)
                        .padding(.top, i == 0 ? 0 : 18).padding(.bottom, 6)
                }
                row(item, p)
            }
            if more {
                SettingsButton(title: busy ? "Loading…" : "Load older", enabled: !busy) { load(before: items.last?.id) }.padding(.top, 16)
            }
        }
        .onAppear { if !loaded { load(before: nil) } }
    }

    private func actor(_ item: ActivityEntry) -> (name: String, color: String) {
        if let id = item.actorId, let m = session.shownMembers.first(where: { $0.id == id }) { return (m.name, m.color) }
        return ("Former member", "#999999")
    }

    private func row(_ item: ActivityEntry, _ p: Palette) -> some View {
        let who = actor(item)
        let link = item.targetType == "page" || item.targetType == "task"
        return Button { if link { open(item) } } label: {
            HStack(alignment: .center, spacing: 10) {
                AvatarView(name: who.name, color: PlatformColor(css: who.color), size: 26)
                (Text(who.name).fontWeight(.semibold).foregroundStyle(p.text.color) + Text(" " + item.summary).foregroundStyle(p.text2.color))
                    .font(.web(14)).frame(maxWidth: .infinity, alignment: .leading)
                Text(timeLabel(item)).font(.web(12.5)).foregroundStyle(p.textMuted.color)
            }
            .padding(.vertical, 6).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!link)
    }

    private func open(_ item: ActivityEntry) {
        guard let ws = session.workspaceId else { return }
        let target: DeepLink.Target = item.targetType == "page" ? .page(item.targetId) : .task(item.targetId)
        session.pendingLink = DeepLink(workspaceId: ws, target: target)
    }

    private func load(before: Int64?) {
        guard let ws = session.workspaceId else {
            if session.preview { items = Self.demo; loaded = true }
            return
        }
        busy = true
        session.call({ try $0.activity(workspaceId: ws, limit: Self.pageSize, before: before) }) { r in
            busy = false
            switch r {
            case let .success(list):
                items = before == nil ? list : items + list
                more = list.count == Int(Self.pageSize)
                loaded = true
                error = nil
            case let .failure(e):
                if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
                loaded = true
            }
        }
    }

    private func date(_ item: ActivityEntry) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: item.createdAt) ?? ISO8601DateFormatter().date(from: item.createdAt)
    }

    private func dayLabel(_ item: ActivityEntry) -> String {
        guard let d = date(item) else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        let f = DateFormatter()
        f.dateFormat = "EEEE, d MMMM"
        return f.string(from: d)
    }

    private func timeLabel(_ item: ActivityEntry) -> String {
        guard let d = date(item) else { return "" }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    private static var demo: [ActivityEntry] {
        func e(_ id: Int64, _ actor: String, _ summary: String, _ type: String, _ minutes: Double) -> ActivityEntry {
            ActivityEntry(id: id, workspaceId: "demo-team", actorId: actor, verb: "edited", targetType: type, targetId: "x", summary: summary,
                          createdAt: LookData.iso(minutesAgo: minutes))
        }
        return [
            e(5, "ana", "edited page “Weekly sync”", "page", 12),
            e(4, "ben", "completed task “Draft the Q4 roadmap”", "task", 55),
            e(3, "demo", "created page “Canvas”", "page", 130),
            e(2, "chen", "joined the workspace", "member", 60 * 26),
            e(1, "ana", "renamed notebook “Product” to “Product 2026”", "notebook", 60 * 27),
        ]
    }
}
