import NotiveloCore
import SwiftUI

// Workspace management dialogs: a new workspace, delete (typed name) and leave; teams (new, rename, delete, move under,
// members) and tags (rename, delete). The web's `promptDialog` / `confirmDialog` over the same calls (Settings.tsx,
// TeamsSettings.tsx). All of it needs the server: offline the core says so and nothing changes.

enum WorkspaceDialog: Equatable {
    case newWorkspace
    case deleteWorkspace
    case leaveWorkspace
    case newTeam(parent: String?)
    case renameTeam(String)
    case deleteTeam(String)
    case moveTeam(String)
    case teamMembers(String)
    case renameTag(String)
    case deleteTag(String)
}

extension SessionModel {
    var shownTeams: [TaskTeam] { preview ? LookData.teams : teams }
    var shownTags: [TaskTag] { preview ? LookData.tags : tags }
    var shownMembers: [WorkspaceMember] { preview ? LookData.members : members }
    var isAdmin: Bool { preview || ["owner", "admin"].contains(workspace?.role ?? "") }

    /// Top-level teams in order, each followed by its subteams (`orderedTeams` in src/lib/taskViews.ts).
    var orderedTeams: [TaskTeam] {
        let all = shownTeams
        let ids = Set(all.map(\.id))
        var out: [TaskTeam] = []
        for top in all where top.parentId == nil || !ids.contains(top.parentId ?? "") {
            out.append(top)
            out += all.filter { $0.parentId == top.id }
        }
        return out
    }
}

extension LookData {
    static let members: [WorkspaceMember] = [
        WorkspaceMember(id: "demo", name: "Demo User", email: "demo@example.com", color: "#f59e0b", role: "owner"),
        WorkspaceMember(id: "ana", name: "Ana Silva", email: "ana@example.com", color: "#ec4899", role: "admin"),
        WorkspaceMember(id: "ben", name: "Ben Okafor", email: "ben@example.com", color: "#0ea5e9", role: "member"),
        WorkspaceMember(id: "chen", name: "Chen Wei", email: "chen@example.com", color: "#10b981", role: "member"),
    ]
    static let teams: [TaskTeam] = [
        TaskTeam(id: "team-design", name: "Design", color: "#ec4899", parentId: nil, memberIds: ["ana", "demo"]),
        TaskTeam(id: "team-brand", name: "Brand", color: "#8b5cf6", parentId: "team-design", memberIds: ["ana"]),
        TaskTeam(id: "team-eng", name: "Engineering", color: "#0ea5e9", parentId: nil, memberIds: ["ben", "chen", "demo"]),
        TaskTeam(id: "team-ops", name: "Operations", color: "#10b981", parentId: nil, memberIds: []),
    ]
    static let tags: [TaskTag] = [
        TaskTag(id: "tag-waiting", name: "Waiting", color: "#f59e0b"),
        TaskTag(id: "tag-bug", name: "Bug", color: "#ef4444"),
        TaskTag(id: "tag-idea", name: "Idea", color: "#6366f1"),
    ]
}

/// The colours of the web's colour menu for teams and tags.
let workspaceColors = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6", "#64748b"]

struct WorkspaceDialogCard: View {
    let kind: WorkspaceDialog
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool
    let theme = Theme.shared

    private var wsName: String { session.workspace?.name ?? "" }
    private func team(_ id: String) -> TaskTeam? { session.teams.first { $0.id == id } }
    private func tag(_ id: String) -> TaskTag? { session.tags.first { $0.id == id } }
    private func close() { shell.sheet = nil }
    private func fail(_ e: Error) {
        busy = false
        if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
    }

    var body: some View {
        switch kind {
        case .newWorkspace: prompt("New workspace", "Workspace name", "Create")
        case let .newTeam(parent): prompt(parent.flatMap(team).map { "New subteam of \($0.name)" } ?? "New team", "Name", "Create")
        case let .renameTeam(id): prompt("Rename team", "Name", "Rename", initial: team(id)?.name)
        case let .renameTag(id): prompt("Rename tag", "Name", "Rename", initial: tag(id)?.name)
        case .deleteWorkspace: deleteWorkspace()
        case .leaveWorkspace:
            confirm("Leave “\(wsName)”?", "You will lose access to its notebooks, pages and tasks until someone invites you again.", "Leave workspace")
        case let .deleteTeam(id):
            let sub = team(id)?.parentId == nil ? " Its subteams are deleted too." : ""
            confirm("Delete \(team(id)?.name ?? "team")?", "Its tasks stay, without a team." + sub, "Delete team")
        case let .deleteTag(id):
            confirm("Delete “\(tag(id)?.name ?? "tag")”?", "It’s removed from every task. The tasks stay.", "Delete tag")
        case let .moveTeam(id): MoveTeamList(teamId: id, width: width)
        case let .teamMembers(id): TeamMembersList(teamId: id, width: width)
        }
    }

    // MARK: Parts

    private func prompt(_ title: String, _ label: String, _ confirm: String, initial: String? = nil) -> some View {
        let name = text.trimmingCharacters(in: .whitespaces)
        let ok = !name.isEmpty && !busy
        return DialogCard(title: title, width: width, close: close) {
            VStack(alignment: .leading, spacing: 8) {
                DialogField(label: label, placeholder: label, text: $text, focused: $focused) { if ok { send(name) } }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Cancel") { close() }
            DialogButton(title: confirm, style: .primary, enabled: ok) { send(name) }
        }
        .onAppear {
            if let initial, text.isEmpty { text = initial }
            if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } }
        }
    }

    private func confirm(_ title: String, _ message: String, _ label: String) -> some View {
        DialogCard(title: title, description: message, width: width, close: close, hasBody: error != nil) {
            if let error { SheetNote(text: error, danger: true) }
        } foot: {
            DialogButton(title: "Cancel") { close() }
            DialogButton(title: label, style: .danger, enabled: !busy) { send("") }
        }
    }

    private func deleteWorkspace() -> some View {
        let ok = text == wsName && !busy
        return DialogCard(title: "Delete this workspace?",
                          description: "This deletes every notebook, page and task in it, for everyone. It can’t be undone. Type the workspace name (“\(wsName)”) to confirm.",
                          width: width, close: close) {
            VStack(alignment: .leading, spacing: 8) {
                DialogField(label: "Workspace name", placeholder: wsName, text: $text, focused: $focused) { if ok { send("") } }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Cancel") { close() }
            DialogButton(title: "Delete workspace", style: .danger, enabled: ok) { send("") }
        }
        .onAppear { if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } } }
    }

    // MARK: Actions

    private func send(_ name: String) {
        guard let ws = session.workspaceId else { return }
        busy = true
        error = nil
        switch kind {
        case .newWorkspace:
            session.call({ try $0.createWorkspace(name: name) }) { r in
                switch r {
                case let .success(id):
                    close()
                    shell.route = .notes
                    session.createdWorkspace(id)
                    shell.say("Workspace created")
                case let .failure(e): fail(e)
                }
            }
        case .deleteWorkspace:
            session.call({ try $0.deleteWorkspace(workspaceId: ws) }) { r in leftAfter(r, ws, "Workspace deleted") }
        case .leaveWorkspace:
            session.call({ try $0.leaveWorkspace(workspaceId: ws) }) { r in leftAfter(r, ws, "You left the workspace") }
        case let .newTeam(parent):
            session.call({ try $0.createTeam(workspaceId: ws, name: name, color: nil, parentId: parent, memberIds: []) }) { done($0) }
        case let .renameTeam(id):
            session.call({ try $0.renameTeam(teamId: id, name: name) }) { done($0) }
        case let .deleteTeam(id):
            session.call({ try $0.deleteTeam(teamId: id) }) { done($0, "Team deleted") }
        case let .renameTag(id):
            session.call({ try $0.renameTag(tagId: id, name: name) }) { done($0) }
        case let .deleteTag(id):
            session.call({ try $0.deleteTag(tagId: id) }) { done($0) }
        case .moveTeam, .teamMembers:
            break
        }
    }

    /// The workspace is gone for this person (deleted or left): back to the notes of the next one.
    private func leftAfter(_ r: Result<Void, Error>, _ ws: String, _ message: String) {
        switch r {
        case .success:
            close()
            shell.route = .notes
            shell.settingsSection = nil
            session.leftWorkspace(ws)
            shell.say(message)
        case let .failure(e): fail(e)
        }
    }

    private func done<T>(_ r: Result<T, Error>, _ message: String? = nil) {
        switch r {
        case .success:
            close()
            session.loadLookups()
            if let message { shell.say(message) }
        case let .failure(e): fail(e)
        }
    }
}

/// "Move under": Top level or another top-level team (a team with subteams can't go under one).
private struct MoveTeamList: View {
    let teamId: String
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var error: String?
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let team = session.teams.first { $0.id == teamId }
        let hasSubs = session.teams.contains { $0.parentId == teamId }
        let tops = session.teams.filter { $0.parentId == nil && $0.id != teamId }
        DialogCard(title: "Move \(team?.name ?? "team") under…", width: width, close: { shell.sheet = nil }, hasFoot: false) {
            VStack(alignment: .leading, spacing: 2) {
                row("Top level", nil, team?.parentId == nil, p)
                if !hasSubs { ForEach(tops, id: \.id) { t in row(t.name, t, team?.parentId == t.id, p) } }
                if hasSubs { SheetNote(text: "A team that has subteams can’t go under another.") }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            EmptyView()
        }
    }

    private func row(_ title: String, _ parent: TaskTeam?, _ current: Bool, _ p: Palette) -> some View {
        Button { move(parent?.id) } label: {
            HStack(spacing: 8) {
                if let parent { Circle().fill(PlatformColor(css: parent.color).color).frame(width: 10, height: 10) }
                Text(title).font(.web(14)).foregroundStyle((current ? p.accent : p.text).color).lineLimit(1)
                Spacer(minLength: 0)
                if current { Icon("check", 14, p.accent.color) }
            }
            .padding(.horizontal, 8).frame(height: 34).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
    }

    private func move(_ parent: String?) {
        session.call({ try $0.moveTeam(teamId: teamId, parentId: parent) }) { r in
            switch r {
            case .success:
                shell.sheet = nil
                session.loadLookups()
            case let .failure(e):
                if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
            }
        }
    }
}

/// "Members of <team>": everyone in the workspace with a check; a tap adds or removes them at once.
private struct TeamMembersList: View {
    let teamId: String
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var error: String?
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let team = session.teams.first { $0.id == teamId }
        let ids = team?.memberIds ?? []
        DialogCard(title: "Members of \(team?.name ?? "team")", width: width, close: { shell.sheet = nil }) {
            VStack(alignment: .leading, spacing: 4) {
                ListBox(count: session.members.count, height: 300) {
                    ForEach(session.members, id: \.id) { m in
                        let on = ids.contains(m.id)
                        Button { toggle(m.id, on) } label: {
                            HStack(spacing: 10) {
                                AvatarView(name: m.name, color: PlatformColor(css: m.color), size: 22)
                                Text(m.name).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                                Spacer(minLength: 0)
                                if on { Icon("check", 14, p.accent.color) }
                            }
                            .padding(.horizontal, 8).frame(height: 36).contentShape(Rectangle())
                        }
                        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                    }
                }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Done", style: .primary) { shell.sheet = nil }
        }
    }

    private func toggle(_ user: String, _ on: Bool) {
        guard let ws = session.workspaceId else { return }
        session.call({ core -> TaskTeam in
            if on { return try core.removeTeamMember(workspaceId: ws, teamId: teamId, userId: user) }
            return try core.addTeamMember(workspaceId: ws, teamId: teamId, userId: user)
        }) { r in
            switch r {
            case .success: session.loadLookups()
            case let .failure(e): if !(e is CancellationError) { error = SessionModel.plainMessage(e) }
            }
        }
    }
}
