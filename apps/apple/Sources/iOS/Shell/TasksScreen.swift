import NotiveloCore
import SwiftUI

/// Dates as the web app words them (LOOK.md 6): "Today", "Tomorrow", "Yesterday", weekday names
/// within 6 days, else "30 Nov" (with the year when it isn't this year).
enum Due {
    static let parse: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func date(_ s: String?) -> Date? { s.flatMap { parse.date(from: $0) } }

    /// Days from today (negative: past).
    static func days(_ s: String?) -> Int? {
        guard let d = date(s) else { return nil }
        let cal = Calendar.current
        return cal.dateComponents([.day], from: cal.startOfDay(for: Date()), to: cal.startOfDay(for: d)).day
    }

    static func format(_ d: Date, _ pattern: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = pattern
        return f.string(from: d)
    }

    static func words(_ s: String?, time: String? = nil) -> String? {
        guard let d = date(s), let n = days(s) else { return nil }
        var w: String
        switch n {
        case 0: w = "Today"
        case 1: w = "Tomorrow"
        case -1: w = "Yesterday"
        case 2...6: w = format(d, "EEEE")
        default:
            w = Calendar.current.component(.year, from: d) == Calendar.current.component(.year, from: Date())
                ? format(d, "d MMM") : format(d, "d MMM yyyy")
        }
        if let time { w += " \(time)" }
        return w
    }

    /// The tone of a due date: overdue danger, today success, ≤ 6 days warn, later text-2.
    static func tone(_ s: String?, _ p: Palette) -> UIColor {
        guard let n = days(s) else { return p.text2 }
        if n < 0 { return p.danger }
        if n == 0 { return p.success }
        if n <= 6 { return p.warn }
        return p.text2
    }

    static func instant(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// "3m ago", "2h ago", "4d ago", then a short date.
    static func ago(_ iso: String) -> String {
        guard let d = instant(iso) else { return "" }
        let s = Date().timeIntervalSince(d)
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60))m ago" }
        if s < 86400 { return "\(Int(s / 3600))h ago" }
        if s < 7 * 86400 { return "\(Int(s / 86400))d ago" }
        return format(d, "d MMM")
    }
}

/// The task lists' contents and counts.
struct TaskBuckets {
    let tasks: [CoreTask]
    let session: SessionModel

    private var me: String? { session.shownUser?.id }
    private var open: [CoreTask] { tasks.filter { !session.isDone($0) && !$0.locked } }
    private var mine: [CoreTask] { open.filter { $0.assigneeId == me } }

    var overdue: Int { mine.filter { (Due.days($0.dueDate) ?? 0) < 0 && $0.dueDate != nil }.count }

    func list(_ l: Shell.TaskList) -> [CoreTask] {
        switch l {
        case .today: return mine.filter { $0.dueDate != nil && (Due.days($0.dueDate) ?? 1) <= 0 }
        case .my: return mine
        case .upcoming: return mine.filter { if let n = Due.days($0.dueDate) { return n > 0 && n <= 14 } else { return false } }
        case .all, .team: return open
        }
    }

    func count(_ l: Shell.TaskList) -> Int {
        switch l {
        case .all, .team: return 0
        default: return list(l).count
        }
    }

    var doneToday: Int {
        tasks.filter { t in
            guard session.isDone(t), t.assigneeId == me, let at = t.completedAt, let d = Due.instant(at) else { return false }
            return Calendar.current.isDateInToday(d)
        }.count
    }

    /// Groups by due day: Overdue, "Today · Sat 21 Nov", "Tomorrow · Sun 22 Nov", weekdays, dates, then No date.
    func groups(_ l: Shell.TaskList) -> [(title: String, overdue: Bool, tasks: [CoreTask])] {
        let items = list(l).sorted { a, b in
            switch (a.dueDate, b.dueDate) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (a.priority, a.title) < (b.priority, b.title)
            }
        }
        var out: [(title: String, overdue: Bool, tasks: [CoreTask])] = []
        for t in items {
            let title: String
            var late = false
            if let n = Due.days(t.dueDate), let d = Due.date(t.dueDate) {
                switch n {
                case ..<0: title = "Overdue"; late = true
                case 0: title = "Today · " + Due.format(d, "EEE d MMM")
                case 1: title = "Tomorrow · " + Due.format(d, "EEE d MMM")
                case 2...6: title = Due.format(d, "EEEE")
                default: title = Due.format(d, "EEE d MMM")
                }
            } else {
                title = "No date"
            }
            if let i = out.indices.last, out[i].title == title {
                out[i].tasks.append(t)
            } else {
                out.append((title, late, [t]))
            }
        }
        return out
    }
}

/// Today / My Tasks / Upcoming / All tasks (LOOK.md 4.10).
struct TasksScreen: View {
    let list: Shell.TaskList
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let buckets = TaskBuckets(tasks: session.shownTasks, session: session)
        let groups = buckets.groups(list)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(list.title).font(.web(26, 700)).tracking(-0.52).foregroundStyle(p.text.color)
                Text(list.subtitle).font(.web(14)).foregroundStyle(p.textMuted.color).padding(.top, 4)
                if list == .today {
                    StatsCard(done: buckets.doneToday, left: buckets.list(.today).count)
                        .padding(.top, 20)
                }
                if groups.isEmpty {
                    emptyState(p).padding(.top, 20)
                } else {
                    VStack(alignment: .leading, spacing: 22) {
                        ForEach(Array(groups.enumerated()), id: \.offset) { _, g in
                            VStack(alignment: .leading, spacing: 0) {
                                HStack(spacing: 8) {
                                    Text(g.title).font(.web(13.5, 650)).foregroundStyle(g.overdue ? p.danger.color : p.text.color)
                                    Text("\(g.tasks.count)").font(.web(12, 500)).foregroundStyle(p.textMuted.color)
                                }
                                .padding(.top, 8).padding(.bottom, 6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                                ForEach(g.tasks, id: \.id) { t in TaskRowView(task: t) }
                                if !g.overdue {
                                    Button { shell.notYet("Adding tasks") } label: {
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
                    .padding(.top, 20)
                }
            }
            .padding(.top, 36).padding(.horizontal, 40).padding(.bottom, 120)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await session.refresh() }
        .onAppear { session.refreshTasks() }
    }

    @ViewBuilder
    private func emptyState(_ p: Palette) -> some View {
        if list == .today {
            VStack(spacing: 6) {
                Text("☀️").font(.system(size: 34))
                Text("You’re all caught up").font(.web(15, 700)).foregroundStyle(p.text.color)
                Text("Nothing due today. Enjoy it — or plan ahead in Upcoming.").font(.web(14)).foregroundStyle(p.textMuted.color)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40).padding(.horizontal, 16)
        } else {
            Text(list == .my ? "No tasks assigned to you." : list == .upcoming ? "Nothing scheduled." : "No tasks match these filters.")
                .font(.web(14)).foregroundStyle(p.textMuted.color)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
        }
    }
}

/// Today's stats card: done today, left, day streak, a week of bars, the progress line.
struct StatsCard: View {
    let done: Int
    let left: Int
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let total = max(done + left, 1)
        HStack(alignment: .center, spacing: 24) {
            stat("\(done)", "done today", p)
            stat("\(left)", "left", p)
            stat(done > 0 ? "1" : "0", "day streak", p)
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 6) {
                let today = (Calendar.current.component(.weekday, from: Date()) + 6) % 7 // Monday 0
                ForEach(0..<7, id: \.self) { i in
                    VStack(spacing: 3) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(i == (today + 1) % 7 ? p.accent.color : p.bgHover.color)
                            .frame(width: 10, height: 32)
                        Text(["S", "M", "T", "W", "T", "F", "S"][i]).font(.web(10.5)).foregroundStyle(p.textMuted.color)
                    }
                }
            }
        }
        .padding(.vertical, 14).padding(.horizontal, 16)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .overlay(alignment: .bottomLeading) {
            GeometryReader { g in
                Rectangle().fill(p.success.color)
                    .frame(width: g.size.width * CGFloat(done) / CGFloat(total), height: 3)
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func stat(_ n: String, _ label: String, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(n).font(.web(22, 700)).foregroundStyle(p.text.color)
            Text(label).font(.web(12)).foregroundStyle(p.textMuted.color)
        }
    }
}

/// A task row (src/components/TaskRow.tsx): circle, title, meta line, avatar.
struct TaskRowView: View {
    let task: CoreTask
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let done = session.isDone(task)
        HStack(alignment: .top, spacing: 10) {
            TaskCircle(priority: task.priority, done: done, size: 18, palette: p) {
                session.setDone(task, !done)
            }
            .padding(.top, 1)
            .disabled(task.locked)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.locked ? "Locked task" : task.title)
                    .font(.web(14)).lineSpacing(14 * 0.4 / 2)
                    .strikethrough(done)
                    .foregroundStyle(done ? p.textMuted.color : p.text.color)
                meta(p)
            }
            Spacer(minLength: 0)
            if let me = session.shownUser, task.assigneeId == me.id {
                AvatarView(name: me.name, color: UIColor(css: me.color), size: 20)
            }
        }
        .padding(.vertical, 12).padding(.horizontal, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    @ViewBuilder
    private func meta(_ p: Palette) -> some View {
        let due = Due.words(task.dueDate, time: task.dueTime)
        let pageTitle = task.pageId.flatMap { id in
            session.shownTree?.pages.first(where: { $0.id == id })?.title ?? LookData.otherPageTitles[id]
        }
        if due != nil || task.priority < 4 || pageTitle != nil {
            HStack(spacing: 6) {
                if let due {
                    let tone = Due.tone(task.dueDate, p).color
                    HStack(spacing: 4) {
                        Icon("calendar-days", 13, tone)
                        Text(due).font(.web(12)).foregroundStyle(tone)
                    }
                }
                if task.priority < 4 {
                    Icon("flag-filled", 13, priorityColor(task.priority, p).color)
                }
                if let pageTitle {
                    HStack(spacing: 4) {
                        Icon("file-text", 13, p.textMuted.color)
                        Text(pageTitle).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
                    }
                }
            }
        }
    }
}

func priorityColor(_ priority: UInt8, _ p: Palette) -> UIColor {
    switch priority {
    case 1: return p.p1
    case 2: return p.p2
    case 3: return p.p3
    default: return p.textMuted
    }
}

/// The task circle (`.task-check`): ring in the priority colour with a 10 % fill; done: filled with a white check.
struct TaskCircle: View {
    let priority: UInt8
    let done: Bool
    var size: CGFloat = 18
    let palette: Palette
    let action: () -> Void

    var body: some View {
        let ring = priorityColor(priority, palette)
        Button(action: action) {
            ZStack {
                Circle().fill(done ? ring.color : (priority < 4 ? ring.withAlphaComponent(0.10).color : Color.clear))
                Circle().stroke(ring.color, lineWidth: 1.6).padding(0.8)
                if done { Icon("check", size * 0.6, .white) }
            }
            .frame(width: size, height: size)
            .contentShape(Rectangle().inset(by: -12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(done ? "Mark as not done" : "Mark as done")
    }
}
