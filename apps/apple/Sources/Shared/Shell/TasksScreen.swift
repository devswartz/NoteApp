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
    static func tone(_ s: String?, _ p: Palette) -> PlatformColor {
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

    func list(_ l: Shell.TaskList, everyone: Bool = false) -> [CoreTask] {
        switch l {
        case .today: return mine.filter { $0.dueDate != nil && (Due.days($0.dueDate) ?? 1) <= 0 }
        case .my: return mine
        case .upcoming: return (everyone ? open : mine).filter { if let n = Due.days($0.dueDate) { return n <= 14 } else { return false } }
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
    func groups(_ l: Shell.TaskList, everyone: Bool = false, filter: (([CoreTask]) -> [CoreTask])? = nil) -> [TaskBlock] {
        let base = list(l, everyone: everyone)
        let items = (filter?(base) ?? base).sorted { a, b in
            switch (a.dueDate, b.dueDate) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.priority < b.priority
            }
        }
        var out: [TaskBlock] = []
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
                out.append(TaskBlock(key: title, title: title, overdue: late, dueDate: title == "No date" ? nil : t.dueDate, canAdd: !late, tasks: [t]))
            }
        }
        return out
    }
}

/// Today / My Tasks / Upcoming / Team / All tasks (LOOK.md 4.10), filtered, sorted and grouped by `shell.tv`.
struct TasksScreen: View {
    let list: Shell.TaskList
    @Environment(\.phoneLayout) private var phone
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let tv = shell.tv
        let buckets = TaskBuckets(tasks: session.shownTasks, session: session)
        let blocks = listBlocks(buckets, tv)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(list.title).font(.web(phone ? 24 : 26, 700)).tracking(phone ? -0.48 : -0.52).foregroundStyle(p.text.color).frame(height: phone ? 38 : 34)
                Text(list.subtitle).font(.web(14)).foregroundStyle(p.textMuted.color).frame(height: 21).padding(.top, 4)
                if list != .all {
                    if phone {
                        // The ribbon's filter buttons, as one button (Add filter) with a chip for each filter that is on.
                        TaskFilterBar(list: list, palette: p).padding(.top, 16)
                    } else {
                        TaskFilterLine(palette: p).padding(.top, 12)
                    }
                }
                if phone && list == .upcoming {
                    SegmentedPick(options: ["Mine", "Everyone"], selected: tv.upcomingEveryone ? 1 : 0, palette: p) { tv.upcomingEveryone = $0 == 1 }
                        .padding(.top, 12)
                }
                if phone && list == .my {
                    SegmentedPick(options: ["By date", "By page", "By priority"], selected: [TaskGrouping.due, .note, .priority].firstIndex(of: tv.myGroup) ?? 0, palette: p) {
                        tv.myGroup = [TaskGrouping.due, .note, .priority][$0]
                    }
                    .padding(.top, 12)
                }
                if list == .today {
                    StatsCard(done: buckets.doneToday, left: buckets.list(.today).count)
                        .padding(.top, phone ? 12 : 20)
                }
                if list == .team {
                    TeamTasks(palette: p)
                } else if list == .all {
                    allBody(p, tv)
                } else if blocks.isEmpty || blocks.allSatisfy({ $0.tasks.isEmpty }) {
                    if list == .today && tv.activeFilters.isEmpty {
                        // The empty Today still lists its day, with Add task, above the message.
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Today · " + Due.format(Date(), "EEE d MMM")).font(.web(13.5, 650)).foregroundStyle(p.text.color)
                                .padding(.top, 8).padding(.bottom, 6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                            Button { shell.openQuickAdd(session, due: SessionModel.todayString) } label: {
                                HStack(spacing: 8) {
                                    Icon("plus", 15, p.textMuted.color)
                                    Text("Add task").font(.web(13.5)).foregroundStyle(p.textMuted.color)
                                }
                                .padding(.vertical, 8).padding(.horizontal, 6)
                            }
                            .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                            .padding(.top, 2)
                        }
                        .padding(.top, 20)
                    }
                    emptyState(p).padding(.top, list == .today ? 36 : 20)
                } else {
                    TaskBlocksView(blocks: blocks, palette: p).padding(.top, 20)
                }
            }
            .padding(.top, phone ? 20 : 36).padding(.horizontal, phone ? 16 : 40).padding(.bottom, phone ? 96 : 120)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await session.refresh() }
        .noEdgeEffect()
        .onAppear {
            session.refreshTasks()
            if !session.teams.isEmpty { session.loadAllDetails() }
        }
    }

    /// The groups of the lists that have them (Today, My Tasks, Upcoming).
    private func listBlocks(_ buckets: TaskBuckets, _ tv: TaskViewState) -> [TaskBlock] {
        let filter: ([CoreTask]) -> [CoreTask] = { tv.filter($0, session: session) }
        switch list {
        case .today:
            return buckets.groups(.today, filter: filter)
        case .upcoming:
            return buckets.groups(.upcoming, everyone: tv.upcomingEveryone, filter: filter)
        case .my:
            if tv.myGroup == .due { return buckets.groups(.my, filter: filter) }
            return TaskViewState.grouped(filter(buckets.list(.my)), by: tv.myGroup, sort: .due, session: session)
        case .all, .team:
            return []
        }
    }

    /// All tasks: search, status, filters, sort and group; finished tasks (Status Completed or All) under the open ones.
    @ViewBuilder
    private func allBody(_ p: Palette, _ tv: TaskViewState) -> some View {
        let open = session.shownTasks.filter { !session.isDone($0) && !$0.locked }
        let filtered = tv.status == .done ? [] : tv.filter(open, session: session, includeSearch: true)
        let blocks = TaskViewState.grouped(filtered, by: tv.group, sort: tv.sort, session: session)
        let finished = session.shownTasks.filter { session.isDone($0) && !$0.locked }
        let done = (tv.status == .open ? [] : tv.filter(finished, session: session, includeSearch: true))
            .sorted { ($0.completedAt ?? "") > ($1.completedAt ?? "") }
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                TextField("Filter tasks…", text: Bindable(tv).q)
                    .font(.web(phone ? 16 : 14)).foregroundStyle(p.text.color).tint(p.accent.color)
                    .padding(.horizontal, 10).frame(height: phone ? 38 : 32)
                    .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                    .autocorrectionDisabled()
                if phone {
                    SelectMenu(palette: p, label: "Sort", value: tv.sort.label) {
                        ForEach(TaskSort.allCases, id: \.self) { s in Button(s.label) { tv.sort = s } }
                    }
                    SelectMenu(palette: p, label: "Group", value: tv.group.label) {
                        ForEach(TaskGrouping.allCases, id: \.self) { g in Button(g.label) { tv.group = g; if g == .team { session.loadAllDetails() } } }
                    }
                }
            }
            .padding(.top, 16)
            if phone { TaskFilterBar(list: list, palette: p).padding(.top, 10) }
            if phone { SavedViewChips(palette: p).padding(.top, 10) }
            HStack(spacing: 8) {
                if tv.status != .done {
                    Text("\(filtered.count) task\(filtered.count == 1 ? "" : "s")").font(.web(13)).foregroundStyle(p.textMuted.color)
                }
                if !phone && !tv.activeKinds.isEmpty {
                    Text(tv.activeKinds.map { tv.summary($0, session: session) }.joined(separator: " · ")).font(.web(13)).foregroundStyle(p.textMuted.color).lineLimit(2)
                    Button { tv.clearAll(); tv.status = .open } label: {
                        Text("Clear").font(.web(13, 500)).foregroundStyle(p.text2.color).padding(.horizontal, 8).frame(height: 24)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 12)
            if tv.status != .done {
                if blocks.allSatisfy({ $0.tasks.isEmpty }) {
                    if tv.status == .open { emptyState(p).padding(.top, 20) }
                } else {
                    TaskBlocksView(blocks: blocks, palette: p).padding(.top, 14)
                }
            }
            if tv.status != .open {
                if done.isEmpty {
                    if tv.status == .done {
                        Text("No completed tasks match these filters.").font(.web(14)).foregroundStyle(p.textMuted.color)
                            .frame(maxWidth: .infinity).padding(.vertical, 40)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        if tv.status == .any {
                            HStack(spacing: 8) {
                                Text("Completed").font(.web(13.5, 650)).foregroundStyle(p.text.color)
                                Text("\(done.count)").font(.web(12, 500)).foregroundStyle(p.textMuted.color)
                            }
                            .padding(.top, 8).padding(.bottom, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
                        }
                        ForEach(done, id: \.id) { t in TaskRowView(task: t) }
                    }
                    .padding(.top, tv.status == .any ? 22 : 14)
                }
            }
        }
    }

    @ViewBuilder
    private func emptyState(_ p: Palette) -> some View {
        if list == .today {
            VStack(spacing: 6) {
                Text("☀️").font(.system(size: 40))
                Text("You’re all caught up").font(.web(15, 700)).foregroundStyle(p.text.color).padding(.top, 6)
                Text("Nothing due today. Enjoy it — or plan ahead in Upcoming.").font(.web(phone ? 15 : 14)).foregroundStyle(p.textMuted.color)
                    .multilineTextAlignment(.center).lineSpacing(phone ? 4 : 0).padding(.top, 8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40).padding(.horizontal, 16)
        } else {
            Text(!shell.tv.activeFilters.isEmpty ? "No tasks match these filters." : list == .my ? "No tasks assigned to you." : list == .upcoming ? "Nothing scheduled." : "No tasks match these filters.")
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
                // The last seven days, today at the right.
                let today = Calendar.current.component(.weekday, from: Date()) - 1 // Sunday 0
                ForEach(0..<7, id: \.self) { i in
                    VStack(spacing: 3) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(i == 6 ? p.accent.color : p.bgHover.color)
                            .frame(width: 10, height: 32)
                        Text(["S", "M", "T", "W", "T", "F", "S"][((today - (6 - i)) % 7 + 7) % 7]).font(.web(10.5)).foregroundStyle(p.textMuted.color)
                    }
                }
            }
            .fixedSize()
        }
        .padding(.vertical, 16).padding(.horizontal, 16)
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
            Text(label).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
        }
        .fixedSize()
    }
}

/// A task row (src/components/TaskRow.tsx): circle, title, meta line, avatar.
struct TaskRowView: View {
    let task: CoreTask
    @Environment(\.phoneLayout) private var phone
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        #if os(iOS)
        // On a touch screen: swipe right to complete (or reopen), left to move to tomorrow (the web's SwipeRow).
        let done = session.isDone(task)
        SwipeRow(
            right: .init(label: done ? "Reopen" : "Complete", icon: done ? "rotate-ccw" : "check", success: true) { session.setDone(task, !done) },
            left: .init(label: "Tomorrow", icon: "calendar-clock") { moveToTomorrow() },
            disabled: task.locked || session.workspace?.role == "viewer" || session.preview
        ) { rowBody }
        #else
        rowBody
        #endif
    }

    /// Swipe left: due tomorrow, with Undo.
    private func moveToTomorrow() {
        let was = (date: task.dueDate, time: task.dueTime)
        let tomorrow = SessionModel.dayString(Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
        session.update(task.id, TaskChanges(dueDate: tomorrow)) { shell.say($0) }
        shell.say("Moved to tomorrow") {
            session.update(task.id, TaskChanges(dueDate: was.date, clearDueDate: was.date == nil, dueTime: was.time, clearDueTime: was.time == nil)) { shell.say($0) }
        }
    }

    private var rowBody: some View {
        let p = theme.chrome
        let done = session.isDone(task)
        return HStack(alignment: .top, spacing: phone ? 16 : 10) {
            TaskCircle(priority: task.priority, done: done, size: phone ? 22 : 18, palette: p) {
                session.setDone(task, !done)
            }
            .padding(.top, 1)
            .disabled(task.locked)
            VStack(alignment: .leading, spacing: phone ? 6 : 3) {
                Text(task.locked ? "Locked task" : task.title)
                    .font(.web(14))
                    .lineSpacing(phone ? 4 : 0)
                    .strikethrough(done)
                    .foregroundStyle(done ? p.textMuted.color : p.text.color)
                    .frame(minHeight: 19.6)
                meta(p)
            }
            Spacer(minLength: 0)
            if let me = session.shownUser, task.assigneeId == me.id {
                AvatarView(name: me.name, color: PlatformColor(css: me.color), size: 20)
            }
        }
        .padding(.vertical, phone ? 12 : 13).padding(.horizontal, phone ? 12 : 6)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
        .contentShape(Rectangle())
        .onTapGesture { if !task.locked { shell.openTask(task.id) } }
    }

    @ViewBuilder
    private func meta(_ p: Palette) -> some View {
        let due = Due.words(task.dueDate, time: task.dueTime)
        let pageTitle = task.pageId.flatMap { id in
            session.shownTree?.pages.first(where: { $0.id == id })?.title ?? LookData.otherPageTitles[id]
        }
        if due != nil || task.priority < 4 || pageTitle != nil {
            FlowLayout(spacing: phone ? 9 : 6, lineSpacing: 6) {
                Color.clear.frame(width: 0, height: 18)
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
                        Text(pageTitle).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(phone ? 2 : 1)
                    }
                }
            }
        }
    }
}

func priorityColor(_ priority: UInt8, _ p: Palette) -> PlatformColor {
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

/// Children in rows that wrap (the web's `flex-wrap`): each left to right, a new row when the next doesn't fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    private func measure(_ v: LayoutSubview, _ maxW: CGFloat) -> CGSize {
        let s = v.sizeThatFits(.unspecified)
        return s.width > maxW ? v.sizeThatFits(ProposedViewSize(width: maxW, height: nil)) : s
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, width: CGFloat = 0
        for v in subviews {
            let s = measure(v, maxW)
            if x > 0 && x + s.width > maxW { y += rowH + lineSpacing; x = 0; rowH = 0 }
            x += s.width + (s.width > 0 ? spacing : 0)
            rowH = max(rowH, s.height)
            width = max(width, x - spacing)
        }
        return CGSize(width: width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = measure(v, bounds.width)
            if x > bounds.minX && x + s.width > bounds.maxX { y += rowH + lineSpacing; x = bounds.minX; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(s.width, bounds.width), height: s.height))
            x += s.width + (s.width > 0 ? spacing : 0)
            rowH = max(rowH, s.height)
        }
    }
}
