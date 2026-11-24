import NotiveloCore
import SwiftUI

// The task views' controls: the ribbon's menus (iPad, Mac) and the phone's filter sheets and chips, the Team view, and the
// rows of grouped tasks. The state is `TaskViewState` (`shell.tv`); the web's are src/pages/tasks/*.

/// The Tasks ribbon's menus: Group, Sort, and the filter kinds. On the phone the same cards open as bottom sheets.
struct TaskFilterMenu: View {
    let menu: Shell.Menu
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    private var list: Shell.TaskList? {
        if case let .tasks(l) = shell.route { return l }
        return nil
    }

    private func toggle<T: Hashable>(_ set: inout Set<T>, _ v: T) {
        if set.contains(v) { set.remove(v) } else { set.insert(v) }
    }

    @ViewBuilder
    var body: some View {
        let p = palette
        let tv = shell.tv
        switch menu {
        case .taskGroup:
            let options: [TaskGrouping] = list == .my ? [.due, .note, .priority] : TaskGrouping.allCases
            MenuCard(palette: p, width: 200) {
                ForEach(options, id: \.self) { g in
                    MenuItem(palette: p, title: g.label, checked: (list == .my ? tv.myGroup : tv.group) == g) {
                        if list == .my { tv.myGroup = g } else { tv.group = g }
                        if g == .team { session.loadAllDetails() }
                        shell.menu = nil
                    }
                }
            }
        case .taskSort:
            MenuCard(palette: p, width: 200) {
                ForEach(TaskSort.allCases, id: \.self) { s in
                    MenuItem(palette: p, title: s.label, checked: tv.sort == s) {
                        tv.sort = s
                        shell.menu = nil
                    }
                }
            }
        case .taskKinds:
            MenuCard(palette: p, width: 240) {
                ForEach(TaskFilterKind.allCases.filter { $0 != .status || list == .all }, id: \.self) { k in
                    MenuItem(palette: p, title: k.label, icon: k.icon, checked: false, trailingChevron: true) { shell.menu = Self.menu(for: k) }
                }
            }
        case .taskStatus:
            MenuCard(palette: p, width: 200) {
                ForEach(TaskStatusFilter.allCases, id: \.self) { s in
                    MenuItem(palette: p, title: s.label, checked: tv.status == s) {
                        tv.status = s
                        shell.menu = nil
                    }
                }
            }
        case .taskAssignee:
            MenuCard(palette: p, width: 220, maxHeight: 380) {
                if list == .upcoming {
                    MenuItem(palette: p, title: "Me", checked: !tv.upcomingEveryone) { tv.upcomingEveryone = false; shell.menu = nil }
                    MenuItem(palette: p, title: "Everyone", checked: tv.upcomingEveryone) { tv.upcomingEveryone = true; shell.menu = nil }
                } else {
                    MenuItem(palette: p, title: "Me", checked: tv.assignee.contains("me")) { toggle(&tv.assignee, "me") }
                    MenuItem(palette: p, title: "Someone else", checked: tv.assignee.contains("others")) { toggle(&tv.assignee, "others") }
                    MenuItem(palette: p, title: "Unassigned", icon: "user-minus", checked: tv.assignee.contains("unassigned")) { toggle(&tv.assignee, "unassigned") }
                    ForEach(session.members.filter { $0.id != session.shownUser?.id }, id: \.id) { m in
                        MenuItem(palette: p, title: m.name, dot: m.color, checked: tv.assignee.contains(m.id)) { toggle(&tv.assignee, m.id) }
                    }
                    remove(.assignee, p)
                }
            }
        case .taskTags:
            MenuCard(palette: p, width: 220, maxHeight: 380) {
                if session.tags.isEmpty {
                    Text("Nothing to pick yet.").font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.horizontal, 10).padding(.vertical, 8)
                }
                ForEach(session.tags, id: \.id) { t in
                    MenuItem(palette: p, title: t.name, dot: t.color, checked: tv.tags.contains(t.id)) { toggle(&tv.tags, t.id) }
                }
                remove(.tags, p)
            }
        case .taskTeam:
            MenuCard(palette: p, width: 240, maxHeight: 380) {
                if session.teams.isEmpty {
                    Text("No teams yet. Owners and admins add them in Settings → Teams.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                        .padding(.horizontal, 10).padding(.vertical, 8).frame(width: 216, alignment: .leading)
                } else {
                    ForEach(orderedTeams(session.teams)) { entry in
                        MenuItem(palette: p, title: teamLabel(entry.team, session.teams), dot: entry.team.color, checked: tv.teams.contains(entry.team.id)) {
                            toggle(&tv.teams, entry.team.id)
                            session.loadAllDetails()
                        }
                    }
                    MenuItem(palette: p, title: "No team", checked: tv.teams.contains("none")) {
                        toggle(&tv.teams, "none")
                        session.loadAllDetails()
                    }
                }
                remove(.team, p)
            }
        case .taskPriority:
            MenuCard(palette: p, width: 200) {
                ForEach(1...4, id: \.self) { n in
                    MenuItem(palette: p, title: n == 4 ? "No priority" : "Priority \(n)", icon: "flag", checked: tv.priority.contains(n)) { toggle(&tv.priority, n) }
                }
                remove(.priority, p)
            }
        case .taskMore:
            MenuCard(palette: p, width: 220) {
                MenuLabel(palette: p, text: "Due")
                ForEach(TaskDueFilter.allCases.filter { $0 != .any }, id: \.self) { d in
                    MenuItem(palette: p, title: d.label, checked: tv.due == d) { tv.due = tv.due == d ? .any : d }
                }
                MenuLabel(palette: p, text: "Source")
                MenuItem(palette: p, title: "On pages", checked: tv.source.contains("notes")) { toggle(&tv.source, "notes") }
                MenuItem(palette: p, title: "Standalone", checked: tv.source.contains("standalone")) { toggle(&tv.source, "standalone") }
                if tv.isOn(.due) || tv.isOn(.source) {
                    MenuSeparator(palette: p)
                    MenuItem(palette: p, title: "Remove these filters", icon: "filter-x") {
                        tv.clear(.due)
                        tv.clear(.source)
                        shell.menu = nil
                    }
                }
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func remove(_ kind: TaskFilterKind, _ p: Palette) -> some View {
        if shell.tv.isOn(kind) {
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Remove \(kind.label) filter", icon: "filter-x") {
                shell.tv.clear(kind)
                shell.menu = nil
            }
        }
    }

    static func menu(for kind: TaskFilterKind) -> Shell.Menu {
        switch kind {
        case .status: return .taskStatus
        case .assignee: return .taskAssignee
        case .tags: return .taskTags
        case .team: return .taskTeam
        case .priority: return .taskPriority
        case .due, .source: return .taskMore
        }
    }
}

/// The phone's filter bar (the web's `FilterChips`): "Add filter" and one chip per condition that is on; a chip's x removes it.
struct TaskFilterBar: View {
    let list: Shell.TaskList
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        let p = palette
        let tv = shell.tv
        let kinds = list == .all ? tv.activeKinds : tv.activeFilters
        FlowLayout(spacing: 6, lineSpacing: 6) {
            Button { shell.menu = .taskKinds } label: {
                HStack(spacing: 6) {
                    Icon("plus", 15, p.text.color)
                    Text("Add filter").font(.web(13.5, 500)).foregroundStyle(p.text.color)
                }
                .padding(.horizontal, 10).frame(height: 28)
                .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                .shadowSm(p)
            }
            .buttonStyle(.plain)
            ForEach(kinds, id: \.self) { k in
                HStack(spacing: 6) {
                    Button { shell.menu = TaskFilterMenu.menu(for: k) } label: {
                        Text(tv.summary(k, session: session)).font(.web(13)).foregroundStyle(p.text.color).lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    Button { tv.clear(k) } label: {
                        Icon("x", 13, p.textMuted.color).frame(width: 20, height: 20)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(k.label) filter")
                }
                .padding(.leading, 10).padding(.trailing, 4).frame(height: 28)
                .background(p.accentSoft.color, in: Capsule())
            }
        }
    }
}

/// The line under the heading on iPad and Mac: what is filtered, and Clear filters (the web's `ViewFilterBar`).
struct TaskFilterLine: View {
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        let p = palette
        let tv = shell.tv
        let kinds = tv.activeFilters
        if !kinds.isEmpty {
            HStack(spacing: 8) {
                Text("Filtered by " + kinds.map { tv.summary($0, session: session) }.joined(separator: " · "))
                    .font(.web(13)).foregroundStyle(p.textMuted.color).lineLimit(2)
                Button { tv.clearAll() } label: {
                    Text("Clear filters").font(.web(13, 500)).foregroundStyle(p.text2.color)
                        .padding(.horizontal, 8).frame(height: 24)
                }
                .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                Spacer(minLength: 0)
            }
        }
    }
}

/// The web's `.segmented`: a few choices in one rounded track, the current one raised.
struct SegmentedPick: View {
    let options: [String]
    let selected: Int
    let palette: Palette
    let pick: (Int) -> Void

    var body: some View {
        let p = palette
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { i, label in
                let active = i == selected
                Button { pick(i) } label: {
                    Text(label).font(.web(13.5, 500)).foregroundStyle(p.text.color)
                        .padding(.horizontal, 12).frame(height: 26)
                        .background(active ? p.bgElevated.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .shadow(color: active ? Color.black.opacity(0.08) : .clear, radius: 1, x: 0, y: 1)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .fixedSize()
    }
}

/// Grouped tasks: a heading with its count, the rows, and "Add task" under a day (the web's `TaskGroups`).
struct TaskBlocksView: View {
    let blocks: [TaskBlock]
    var emptyText = ""
    let palette: Palette
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 22) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, g in
                VStack(alignment: .leading, spacing: 0) {
                    if !g.title.isEmpty {
                        HStack(spacing: 8) {
                            Text(g.title).font(.web(13.5, 650)).foregroundStyle(g.overdue ? p.danger.color : p.text.color)
                            Text("\(g.tasks.count)").font(.web(12, 500)).foregroundStyle(p.textMuted.color)
                        }
                        .padding(.top, 8).padding(.bottom, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                    }
                    ForEach(g.tasks, id: \.id) { t in TaskRowView(task: t) }
                    if g.canAdd {
                        Button { shell.openQuickAdd(session, due: g.dueDate) } label: {
                            HStack(spacing: 8) {
                                Icon("plus", 15, p.textMuted.color)
                                Text("Add task").font(.web(13.5)).foregroundStyle(p.textMuted.color)
                            }
                            .padding(.vertical, 8).padding(.horizontal, 6)
                        }
                        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                        .padding(.top, 2)
                    }
                }
            }
        }
    }
}

/// Team: who is working on what (cards per person with their numbers, then their open tasks), or the open tasks by team.
struct TeamTasks: View {
    let palette: Palette
    @Environment(\.phoneLayout) private var phone
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell

    var body: some View {
        let p = palette
        let tv = shell.tv
        let hasTeams = !session.teams.isEmpty
        let byTeam = tv.teamByTeam && hasTeams
        VStack(alignment: .leading, spacing: 0) {
            if hasTeams {
                SegmentedPick(options: ["By person", "By team"], selected: byTeam ? 1 : 0, palette: p) { i in
                    tv.teamByTeam = i == 1
                    if i == 1 { session.loadAllDetails() }
                }
                .padding(.top, 16)
            }
            if byTeam { teams(p) } else { people(p) }
        }
        .onAppear { if hasTeams { session.loadAllDetails() } }
    }

    private var open: [CoreTask] { session.shownTasks.filter { !session.isDone($0) && !$0.locked } }

    @ViewBuilder
    private func teams(_ p: Palette) -> some View {
        let blocks = TaskViewState.grouped(shell.tv.filter(open, session: session), by: .team, sort: .due, session: session)
        if blocks.isEmpty {
            Text("No open tasks.").font(.web(14)).foregroundStyle(p.textMuted.color).frame(maxWidth: .infinity).padding(.vertical, 40)
        } else {
            TaskBlocksView(blocks: blocks, palette: p).padding(.top, 20)
        }
    }

    private struct Person: Identifiable {
        let id: String
        let member: WorkspaceMember?
        var name: String { member?.name ?? "Unassigned" }
    }

    @ViewBuilder
    private func people(_ p: Palette) -> some View {
        let tv = shell.tv
        let all = session.shownTasks.filter { !$0.locked }
        let weekAgo = Date().addingTimeInterval(-7 * 86400)
        let persons: [Person] = session.members
            .filter { m in m.role != "viewer" || all.contains { $0.assigneeId == m.id } }
            .map { m in Person(id: m.id, member: m) } + [Person(id: "none", member: nil)]
        let assigned: (Person) -> [CoreTask] = { person in all.filter { person.member == nil ? $0.assigneeId == nil : $0.assigneeId == person.id } }
        let stats: (Person) -> (open: Int, overdue: Int, done: Int) = { person in
            let mine = assigned(person)
            let openOnes = mine.filter { !session.isDone($0) }
            let overdue = openOnes.filter { t in t.dueDate != nil && (Due.days(t.dueDate) ?? 0) < 0 }.count
            let done = mine.filter { t in
                guard session.isDone(t), let at = t.completedAt, let d = Due.instant(at) else { return false }
                return d > weekAgo
            }.count
            return (openOnes.count, overdue, done)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: phone ? 150 : 210), spacing: 10)], spacing: 10) {
            ForEach(persons) { person in
                let s = stats(person)
                let total = s.open + s.done
                let active = tv.teamFocus == person.id
                Button { tv.teamFocus = active ? nil : person.id } label: {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            AvatarView(name: person.name, color: person.member.map { PlatformColor(css: $0.color) } ?? p.textMuted, size: 28)
                            Text(person.name).font(.web(14, 650)).foregroundStyle(p.text.color).lineLimit(1)
                        }
                        HStack(spacing: 10) {
                            Text("\(s.open) open").font(.web(12.5)).foregroundStyle(p.text2.color)
                            if s.overdue > 0 { Text("\(s.overdue) overdue").font(.web(12.5)).foregroundStyle(p.danger.color) }
                            Text("\(s.done) done this week").font(.web(12.5)).foregroundStyle(p.text2.color).lineLimit(1)
                        }
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Capsule().fill(p.bgHover.color)
                                Capsule().fill(p.success.color).frame(width: total > 0 ? g.size.width * CGFloat(s.done) / CGFloat(total) : 0)
                            }
                        }
                        .frame(height: 4)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(active ? p.accent.color : p.border.color, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 16)
        VStack(alignment: .leading, spacing: 22) {
            ForEach(persons.filter { tv.teamFocus == nil || tv.teamFocus == $0.id }) { person in
                let rows = TaskViewState.sorted(tv.filter(assigned(person).filter { !session.isDone($0) }, session: session), by: .due)
                if !(tv.teamFocus == nil && rows.isEmpty) {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 8) {
                            Text(person.name).font(.web(13.5, 650)).foregroundStyle(p.text.color)
                            if !rows.isEmpty { Text("\(rows.count)").font(.web(12, 500)).foregroundStyle(p.textMuted.color) }
                        }
                        .padding(.top, 8).padding(.bottom, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                        ForEach(rows, id: \.id) { t in TaskRowView(task: t) }
                        if rows.isEmpty {
                            Text("No open tasks.").font(.web(13)).foregroundStyle(p.textMuted.color).padding(.vertical, 10).padding(.horizontal, 6)
                        }
                    }
                }
            }
        }
        .padding(.top, 20)
    }
}
