import NotiveloCore
import Observation
import SwiftUI

/// How the task views are filtered, sorted and grouped (src/pages/tasks/taskViewState.ts and src/lib/taskViews.ts): one state
/// for the ribbon (iPad, Mac) and the in-page controls (iPhone). Kept while the app runs; another workspace starts clean.
/// Only the tasks the app already has are filtered here; "Completed" is the ones finished in the last 30 days the list carries.

enum TaskStatusFilter: String, CaseIterable {
    case open, done, any
    var label: String { self == .open ? "Open" : self == .done ? "Completed" : "All" }
}

enum TaskDueFilter: String, CaseIterable {
    case any, overdue, today, week, none
    var label: String {
        switch self {
        case .any: return "Any"
        case .overdue: return "Overdue"
        case .today: return "Today or earlier"
        case .week: return "Next 7 days"
        case .none: return "No date"
        }
    }
}

enum TaskSort: String, CaseIterable {
    case due, priority, created, title
    var label: String {
        switch self {
        case .due: return "Due date"
        case .priority: return "Priority"
        case .created: return "Newest"
        case .title: return "Name"
        }
    }
}

enum TaskGrouping: String, CaseIterable {
    case none, due, assignee, team, note, priority
    var label: String {
        switch self {
        case .none: return "None"
        case .due: return "Due date"
        case .assignee: return "Assignee"
        case .team: return "Team"
        case .note: return "Page"
        case .priority: return "Priority"
        }
    }
}

enum TaskFilterKind: String, CaseIterable {
    case status, assignee, tags, team, priority, due, source
    var label: String {
        switch self {
        case .status: return "Status"
        case .assignee: return "Assignee"
        case .tags: return "Tags"
        case .team: return "Team"
        case .priority: return "Priority"
        case .due: return "Due"
        case .source: return "Source"
        }
    }
    var icon: String {
        switch self {
        case .status: return "eye"
        case .assignee: return "user"
        case .tags: return "tag"
        case .team: return "users-round"
        case .priority: return "flag"
        case .due: return "calendar-days"
        case .source: return "file-text"
        }
    }
}

/// One group of tasks in a list: a heading and its rows.
struct TaskBlock {
    var key: String
    var title: String
    var overdue = false
    /// The day the group stands for (new tasks added inside it get it).
    var dueDate: String?
    /// "Add task" shows under the group.
    var canAdd = false
    var tasks: [CoreTask]
}

@Observable
final class TaskViewState {
    var status: TaskStatusFilter = .open
    /// Values: me, others, unassigned, or a user id.
    var assignee: Set<String> = []
    var tags: Set<String> = []
    /// Team ids, or "none".
    var teams: Set<String> = []
    var priority: Set<Int> = []
    var due: TaskDueFilter = .any
    /// notes, standalone.
    var source: Set<String> = []
    var includeSubteams = true
    var q = ""
    var sort: TaskSort = .due
    var group: TaskGrouping = .none
    var myGroup: TaskGrouping = .due
    var upcomingEveryone = false
    /// Team: by person (the cards) or by team.
    var teamByTeam = false
    /// Team by person: the one person shown ("none": unassigned); nil: everyone.
    var teamFocus: String?

    func isOn(_ kind: TaskFilterKind) -> Bool {
        switch kind {
        case .status: return status != .open
        case .assignee: return !assignee.isEmpty
        case .tags: return !tags.isEmpty
        case .team: return !teams.isEmpty
        case .priority: return !priority.isEmpty
        case .due: return due != .any
        case .source: return !source.isEmpty
        }
    }

    /// The conditions that are on (search text is separate).
    var activeKinds: [TaskFilterKind] { TaskFilterKind.allCases.filter { isOn($0) } }
    /// The conditions other than Status (the views other than All tasks are always Open).
    var activeFilters: [TaskFilterKind] { activeKinds.filter { $0 != .status } }

    func clear(_ kind: TaskFilterKind) {
        switch kind {
        case .status: status = .open
        case .assignee: assignee = []
        case .tags: tags = []
        case .team: teams = []
        case .priority: priority = []
        case .due: due = .any
        case .source: source = []
        }
    }

    func clearAll() {
        for k in TaskFilterKind.allCases where k != .status { clear(k) }
    }

    func reset() {
        clearAll()
        status = .open
        q = ""
        sort = .due
        group = .none
        myGroup = .due
        upcomingEveryone = false
        teamByTeam = false
        teamFocus = nil
    }

    // MARK: Filtering

    /// `list` with the conditions applied (not Status: the caller picks open or done tasks first).
    func filter(_ list: [CoreTask], session: SessionModel, includeSearch: Bool = false) -> [CoreTask] {
        let me = session.shownUser?.id
        let today = SessionModel.todayString
        let weekEnd = SessionModel.dayString(Calendar.current.date(byAdding: .day, value: 7, to: Date()) ?? Date())
        let query = includeSearch ? q.trimmingCharacters(in: .whitespaces).lowercased() : ""
        var scope: [String: Set<String>] = [:]
        for id in teams where id != "none" {
            var ids: Set<String> = [id]
            if includeSubteams { for t in session.teams where t.parentId == id { ids.insert(t.id) } }
            scope[id] = ids
        }
        return list.filter { t in
            if !query.isEmpty, !t.title.lowercased().contains(query), !t.description.lowercased().contains(query) { return false }
            if !assignee.isEmpty {
                let hit = assignee.contains { v in
                    switch v {
                    case "me": return t.assigneeId != nil && t.assigneeId == me
                    case "unassigned": return t.assigneeId == nil
                    case "others": return t.assigneeId != nil && t.assigneeId != me
                    default: return t.assigneeId == v
                    }
                }
                if !hit { return false }
            }
            if !priority.isEmpty, !priority.contains(Int(t.priority)) { return false }
            switch due {
            case .any: break
            case .overdue: guard let d = t.dueDate, d < today else { return false }
            case .today: guard let d = t.dueDate, d <= today else { return false }
            case .week: guard let d = t.dueDate, d <= weekEnd else { return false }
            case .none: if t.dueDate != nil { return false }
            }
            if !source.isEmpty {
                let hit = source.contains { $0 == "notes" ? t.pageId != nil : t.pageId == nil }
                if !hit { return false }
            }
            if !tags.isEmpty, !t.tagIds.contains(where: { tags.contains($0) }) { return false }
            if !teams.isEmpty {
                let team = session.details[t.id]?.teamId
                let hit = teams.contains { v in
                    if v == "none" { return team == nil }
                    guard let team else { return false }
                    return scope[v]?.contains(team) ?? false
                }
                if !hit { return false }
            }
            return true
        }
    }

    // MARK: Sorting and grouping

    static func sorted(_ list: [CoreTask], by key: TaskSort) -> [CoreTask] {
        list.sorted { a, b in
            switch key {
            case .due:
                return (a.dueDate ?? "9999", a.dueTime ?? "99", a.priority, a.createdAt) < (b.dueDate ?? "9999", b.dueTime ?? "99", b.priority, b.createdAt)
            case .priority:
                return (a.priority, a.dueDate ?? "9999") < (b.priority, b.dueDate ?? "9999")
            case .created:
                return a.createdAt > b.createdAt
            case .title:
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
        }
    }

    /// The heading of a day: "Today · Sat 21 Nov", "Tomorrow · Sun 22 Nov", a weekday, then "30 Nov".
    static func dayTitle(_ date: String) -> String {
        guard let d = Due.date(date), let n = Due.days(date) else { return date }
        switch n {
        case 0: return "Today · " + Due.format(d, "EEE d MMM")
        case 1: return "Tomorrow · " + Due.format(d, "EEE d MMM")
        case 2...6: return Due.format(d, "EEEE")
        default: return Due.format(d, "EEE d MMM")
        }
    }

    /// `list` sorted, then grouped as the web's `groupBy`: Overdue first, "No date", "Unassigned", "No team" and "Not on a page" last.
    static func grouped(_ list: [CoreTask], by key: TaskGrouping, sort: TaskSort, session: SessionModel) -> [TaskBlock] {
        let items = sorted(list, by: sort)
        if key == .none { return [TaskBlock(key: "all", title: "", tasks: items)] }
        var order: [String] = []
        var blocks: [String: TaskBlock] = [:]
        func add(_ k: String, _ title: String, _ t: CoreTask, overdue: Bool = false, due: String? = nil, canAdd: Bool = false) {
            if blocks[k] == nil {
                blocks[k] = TaskBlock(key: k, title: title, overdue: overdue, dueDate: due, canAdd: canAdd, tasks: [])
                order.append(k)
            }
            blocks[k]?.tasks.append(t)
        }
        let today = SessionModel.todayString
        let teamOrder = orderedTeams(session.teams)
        for t in items {
            switch key {
            case .none:
                break
            case .due:
                if let d = t.dueDate {
                    if d < today { add("!overdue", "Overdue", t, overdue: true) } else { add(d, dayTitle(d), t, due: d, canAdd: true) }
                } else {
                    add("~none", "No date", t, canAdd: true)
                }
            case .assignee:
                if let m = session.members.first(where: { $0.id == t.assigneeId }) { add("a" + m.name + m.id, m.name, t) } else { add("~", "Unassigned", t) }
            case .priority:
                add(String(t.priority), t.priority == 4 ? "No priority" : "Priority \(t.priority)", t)
            case .team:
                if let id = session.details[t.id]?.teamId, let i = teamOrder.firstIndex(where: { $0.team.id == id }) {
                    add("t" + String(format: "%05d", i), teamLabel(teamOrder[i].team, session.teams), t)
                } else {
                    add("~", "No team", t)
                }
            case .note:
                if let id = t.pageId, let page = session.shownTree?.pages.first(where: { $0.id == id }) {
                    add("p" + page.title + page.id, page.title.isEmpty ? "Untitled" : page.title, t)
                } else {
                    add("~", "Not on a page", t)
                }
            }
        }
        func rank(_ k: String) -> Int { k.hasPrefix("!") ? 0 : k.hasPrefix("~") ? 2 : 1 }
        return order.sorted { a, b in rank(a) != rank(b) ? rank(a) < rank(b) : a < b }.compactMap { blocks[$0] }
    }

    // MARK: Words

    /// "Assignee: Me, Ann" for a chip or the summary line.
    func summary(_ kind: TaskFilterKind, session: SessionModel) -> String {
        let values: [String]
        switch kind {
        case .status: values = [status.label]
        case .assignee:
            values = assignee.sorted().map { v in
                switch v {
                case "me": return "Me"
                case "others": return "Someone else"
                case "unassigned": return "Unassigned"
                default: return session.member(v)?.name ?? "Someone"
                }
            }
        case .tags: values = tags.compactMap { id in session.tags.first { $0.id == id }?.name }.sorted()
        case .team:
            values = teams.map { id in id == "none" ? "No team" : (session.teams.first { $0.id == id }.map { teamLabel($0, session.teams) } ?? "Team") }.sorted()
        case .priority: values = priority.sorted().map { $0 == 4 ? "No priority" : "Priority \($0)" }
        case .due: values = [due.label]
        case .source: values = source.sorted().map { $0 == "notes" ? "On pages" : "Standalone" }
        }
        return "\(kind.label): " + values.joined(separator: ", ")
    }
}

extension SessionModel {
    /// A task's team, once the full tasks are read (`taskDetails`): the list carries no team.
    func teamId(of task: CoreTask) -> String? { details[task.id]?.teamId }
}
