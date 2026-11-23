import NotiveloCore
import SwiftUI

/// Calendar days as the web's CalendarView does them: dates are `YYYY-MM-DD` strings, weeks start on Monday.
enum CalDates {
    static let cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.firstWeekday = 2
        return c
    }()

    static func date(_ s: String) -> Date { Due.date(s) ?? Date() }
    static func string(_ d: Date) -> String { SessionModel.dayString(d) }

    static func add(_ s: String, days n: Int) -> String {
        string(cal.date(byAdding: .day, value: n, to: date(s)) ?? date(s))
    }

    /// Monday on or before `s`.
    static func weekStart(_ s: String) -> String {
        let wd = cal.component(.weekday, from: date(s)) // 1 is Sunday
        return add(s, days: -((wd + 5) % 7))
    }

    /// The 42 days (6 weeks, Monday first) shown for the month containing `s`.
    static func monthGrid(_ s: String) -> [String] {
        let start = weekStart(String(s.prefix(8)) + "01")
        return (0..<42).map { add(start, days: $0) }
    }

    /// The day one month (the 1st of it) or one week before (n = -1) or after (n = 1).
    static func step(_ cursor: String, month: Bool, _ n: Int) -> String {
        if !month { return add(cursor, days: 7 * n) }
        let d = date(cursor)
        let parts = cal.dateComponents([.year, .month], from: d)
        var c = DateComponents()
        c.year = parts.year
        c.month = (parts.month ?? 1) + n
        c.day = 1
        return string(cal.date(from: c) ?? d)
    }

    static func day(_ s: String) -> Int { cal.component(.day, from: date(s)) }
    static func month(_ s: String) -> Int { cal.component(.month, from: date(s)) }
    static func monthTitle(_ s: String) -> String { Due.format(date(s), "MMMM yyyy") }
    static func weekdayShort(_ i: Int) -> String { ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i] }

    static func weekTitle(_ cursor: String) -> String {
        let a = weekStart(cursor)
        return "\(Due.format(date(a), "MMM d")) – \(Due.format(date(add(a, days: 6)), "MMM d, yyyy"))"
    }

    static func dayLabel(_ s: String) -> String { Due.format(date(s), "EEEE, MMM d") }
}

/// The Calendar (src/pages/tasks/CalendarView.tsx, LOOK.md 4.10): a month or a week of open tasks by due date, with the
/// "No date" tray. Drag a task onto another day to move it (`Core.updateTask` with `dueDate`), onto the tray to clear its
/// date; double-tap a day (or its +) to add a task there. Phones: tap a day in Month to open its week, tap a task for
/// its sheet. Mine / Everyone, Today, previous / next and Week / Month are in the ribbon (wide) or the heading (phone).
struct CalendarScreen: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    /// The day (or "none" for the tray) a task is being dragged over.
    @State private var dropDay: String?
    let theme = Theme.shared

    private var canEdit: Bool { session.workspace?.role != "viewer" }

    private struct CalData {
        var byDay: [String: [CoreTask]] = [:]
        var undated: [CoreTask] = []
    }

    private func data() -> CalData {
        let me = session.shownUser?.id
        let scoped = session.shownTasks.filter {
            !session.isDone($0) && !$0.locked && (shell.calWho == .everyone || $0.assigneeId == me)
        }
        var d = CalData()
        for t in scoped {
            if let day = t.dueDate { d.byDay[day, default: []].append(t) } else { d.undated.append(t) }
        }
        for key in d.byDay.keys {
            d.byDay[key]?.sort { a, b in
                if a.dueTime != b.dueTime { return (a.dueTime ?? "99") < (b.dueTime ?? "99") }
                if a.priority != b.priority { return a.priority < b.priority }
                return a.title < b.title
            }
        }
        d.undated.sort { $0.priority != $1.priority ? $0.priority < $1.priority : $0.title < $1.title }
        return d
    }

    var body: some View {
        let p = theme.chrome
        let d = data()
        let cursor = shell.calCursor
        let days = shell.calMonth ? CalDates.monthGrid(cursor) : (0..<7).map { CalDates.add(CalDates.weekStart(cursor), days: $0) }
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(p, cursor)
                if phone {
                    VStack(alignment: .leading, spacing: 16) {
                        grid(p, days, d.byDay)
                        if canEdit { tray(p, d.undated) }
                    }
                } else {
                    HStack(alignment: .top, spacing: 16) {
                        grid(p, days, d.byDay).frame(maxWidth: .infinity)
                        if canEdit { tray(p, d.undated).frame(width: 190) }
                    }
                }
                Text(hint).font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.top, 14)
            }
            .padding(.top, phone ? 12 : 24).padding(.horizontal, phone ? 8 : 40).padding(.bottom, phone ? 96 : 40)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await session.refresh() }
        .noEdgeEffect()
        .onAppear { session.refreshTasks() }
    }

    private var hint: String {
        if phone { return shell.calMonth ? "Tap a day to see its tasks." : "Tap a day to add a task. Tap a task to change its date." }
        return "Drag tasks between days to reschedule. Double-tap a day to add a task."
    }

    // MARK: Heading

    private func header(_ p: Palette, _ cursor: String) -> some View {
        let title = shell.calMonth ? CalDates.monthTitle(cursor) : CalDates.weekTitle(cursor)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(title).font(.web(24, 700)).tracking(-0.48).foregroundStyle(p.text.color).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                if phone {
                    Button { shell.calCursor = SessionModel.todayString } label: {
                        Text("Today").font(.web(13.5, 500)).foregroundStyle(p.text.color)
                            .padding(.horizontal, 10).frame(height: 30)
                            .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                            .shadowSm(p)
                    }
                    .buttonStyle(.plain)
                    Button { shell.calCursor = CalDates.step(cursor, month: shell.calMonth, -1) } label: {
                        Icon("chevron-left", 18, p.text2.color).frame(width: 40, height: 40)
                    }
                    .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                    .accessibilityLabel(shell.calMonth ? "Previous month" : "Previous week")
                    Button { shell.calCursor = CalDates.step(cursor, month: shell.calMonth, 1) } label: {
                        Icon("chevron-right", 18, p.text2.color).frame(width: 40, height: 40)
                    }
                    .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
                    .accessibilityLabel(shell.calMonth ? "Next month" : "Next week")
                }
            }
            if phone {
                HStack(spacing: 8) {
                    segmented(p, ["Mine", "Everyone"], selected: shell.calWho == .mine ? 0 : 1) { shell.calWho = $0 == 0 ? .mine : .everyone }
                    Spacer(minLength: 0)
                    segmented(p, ["Month", "Week"], selected: shell.calMonth ? 0 : 1) { shell.calMonth = $0 == 0 }
                }
            }
        }
        .padding(.bottom, 14).padding(.horizontal, phone ? 8 : 0)
    }

    private func segmented(_ p: Palette, _ labels: [String], selected: Int, _ pick: @escaping (Int) -> Void) -> some View {
        HStack(spacing: 2) {
            ForEach(Array(labels.enumerated()), id: \.offset) { i, label in
                Button { pick(i) } label: {
                    Text(label).font(.web(13.5, 500)).foregroundStyle(p.text.color)
                        .padding(.horizontal, 12).frame(height: 30)
                        .background(i == selected ? p.bgElevated.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .shadow(color: i == selected ? Color.black.opacity(0.08) : .clear, radius: 1, x: 0, y: 1)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: Days

    @ViewBuilder
    private func grid(_ p: Palette, _ days: [String], _ byDay: [String: [CoreTask]]) -> some View {
        if phone && !shell.calMonth {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(days, id: \.self) { day in weekRow(p, day, byDay[day] ?? []) }
            }
        } else {
            monthOrWeek(p, days, byDay)
        }
    }

    private func monthOrWeek(_ p: Palette, _ days: [String], _ byDay: [String: [CoreTask]]) -> some View {
        let today = SessionModel.todayString
        let rowH: CGFloat = shell.calMonth ? (phone ? 78 : 112) : 320
        let month = CalDates.month(shell.calCursor)
        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(0..<7, id: \.self) { i in
                    HStack(spacing: 6) {
                        Text(CalDates.weekdayShort(i)).font(.web(12, 600)).foregroundStyle(p.textMuted.color)
                        if !shell.calMonth, days.indices.contains(i) {
                            let isToday = days[i] == today
                            Text("\(CalDates.day(days[i]))").font(.web(12, 600))
                                .foregroundStyle(isToday ? Color.white : p.textMuted.color)
                                .padding(.horizontal, isToday ? 6 : 0)
                                .background(isToday ? p.accentSolid.color : Color.clear, in: Capsule())
                        }
                    }
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                }
            }
            VStack(spacing: 0) {
                ForEach(0..<(days.count / 7), id: \.self) { row in
                    HStack(spacing: 0) {
                        ForEach(0..<7, id: \.self) { col in
                            let day = days[row * 7 + col]
                            cell(p, day, byDay[day] ?? [], today: today, out: shell.calMonth && CalDates.month(day) != month, height: rowH)
                        }
                    }
                }
            }
            .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
            .overlay(alignment: .leading) { Rectangle().fill(p.border.color).frame(width: 1) }
        }
    }

    private func cell(_ p: Palette, _ day: String, _ items: [CoreTask], today: String, out: Bool, height: CGFloat) -> some View {
        let limit = shell.calMonth ? (phone ? 2 : 4) : 99
        let isToday = day == today
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                if shell.calMonth {
                    Text("\(CalDates.day(day))").font(.web(12.5, 600))
                        .foregroundStyle(isToday ? Color.white : (out ? p.textMuted.color : p.text.color))
                        .padding(.horizontal, isToday ? 7 : 0)
                        .background(isToday ? p.accentSolid.color : Color.clear, in: Capsule())
                }
                Spacer(minLength: 0)
                if canEdit && !phone {
                    Button { shell.openQuickAdd(session, due: day) } label: {
                        Icon("plus", 13, p.textMuted.color).frame(width: 22, height: 22)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .accessibilityLabel("Add task")
                }
            }
            .padding(.horizontal, 4).padding(.top, 2)
            ForEach(items.prefix(limit), id: \.id) { t in chip(p, t, day: day, full: !shell.calMonth) }
            if items.count > limit {
                Button { shell.calCursor = day; shell.calMonth = false } label: {
                    Text("+\(items.count - limit) more").font(.web(12)).foregroundStyle(p.textMuted.color).padding(.horizontal, 6)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(4)
        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .frame(height: height)
        .background(dropDay == day ? p.accentSoft.color : (out ? p.bgSubtle.color : Color.clear))
        .overlay(alignment: .trailing) { Rectangle().fill(p.border.color).frame(width: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { if canEdit && !phone { shell.openQuickAdd(session, due: day) } }
        .onTapGesture {
            if phone {
                if shell.calMonth {
                    shell.calCursor = day
                    shell.calMonth = false
                } else if canEdit {
                    shell.openQuickAdd(session, due: day)
                }
            }
        }
        .dropDestination(for: String.self) { ids, _ in drop(ids, day: day) } isTargeted: { on in
            if on { dropDay = day } else if dropDay == day { dropDay = nil }
        }
    }

    /// One day of the phone's Week: its label with +, then its tasks full width.
    private func weekRow(_ p: Palette, _ day: String, _ items: [CoreTask]) -> some View {
        let isToday = day == SessionModel.todayString
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 0) {
                Text(CalDates.dayLabel(day)).font(.web(13.5, 650)).foregroundStyle(isToday ? p.accent.color : p.text.color)
                Spacer(minLength: 0)
                if canEdit {
                    Button { shell.openQuickAdd(session, due: day) } label: {
                        Icon("plus", 16, p.textMuted.color).frame(width: 36, height: 30)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .accessibilityLabel("Add task")
                }
            }
            ForEach(items, id: \.id) { t in chip(p, t, day: day, full: true) }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(dropDay == day ? p.accentSoft.color : Color.clear)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
        .dropDestination(for: String.self) { ids, _ in drop(ids, day: day) } isTargeted: { on in
            if on { dropDay = day } else if dropDay == day { dropDay = nil }
        }
    }

    /// A task in a day (`.cal-task`): a bar in the priority colour on its left, the time, the title; red when overdue.
    private func chip(_ p: Palette, _ t: CoreTask, day: String, full: Bool) -> some View {
        let late = !day.isEmpty && day < SessionModel.todayString
        let bar = t.priority < 4 ? priorityColor(t.priority, p) : p.textMuted
        let size: CGFloat = phone && !full ? 10.5 : (full && phone ? 13.5 : 12)
        return HStack(spacing: 4) {
            if let time = t.dueTime {
                Text(time).font(.web(size, 600)).foregroundStyle(p.text2.color)
            }
            Text(t.title.isEmpty ? "Untitled" : t.title).font(.web(size)).foregroundStyle(late ? p.danger.color : p.text.color)
        }
        .lineLimit(1)
        .padding(.horizontal, phone && !full ? 3 : 6).padding(.vertical, full && phone ? 7 : 2)
        .padding(.leading, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.bgHover.color)
        .overlay(alignment: .leading) { Rectangle().fill(bar.color).frame(width: phone && !full ? 2 : 3) }
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { shell.openTask(t.id) }
        .draggable(t.id)
    }

    // MARK: No date

    private func tray(_ p: Palette, _ undated: [CoreTask]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("No date").font(.web(13.5, 650)).foregroundStyle(p.text.color)
                Text(undated.isEmpty ? "" : "\(undated.count)").font(.web(12, 500)).foregroundStyle(p.textMuted.color)
            }
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
            ForEach(undated, id: \.id) { t in chip(p, t, day: "", full: true) }
            if undated.isEmpty {
                Text("Drop a task here to clear its date.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(dropDay == "none" ? p.accentSoft.color : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(dropDay == "none" ? p.accent.color : p.border.color, lineWidth: 1))
        .dropDestination(for: String.self) { ids, _ in drop(ids, day: nil) } isTargeted: { on in
            if on { dropDay = "none" } else if dropDay == "none" { dropDay = nil }
        }
    }

    /// A dragged task id landed on a day (set its due date) or on the tray (clear date and time).
    private func drop(_ ids: [String], day: String?) -> Bool {
        dropDay = nil
        guard canEdit, let id = ids.first, let t = session.shownTasks.first(where: { $0.id == id }), t.dueDate != day else { return false }
        if let day {
            session.update(id, TaskChanges(dueDate: day)) { shell.say($0) }
        } else {
            session.update(id, TaskChanges(clearDueDate: true, clearDueTime: true)) { shell.say($0) }
        }
        return true
    }
}

/// The Calendar's sidebar panel (CalendarPanel.tsx): a small month to jump to a day, with a dot on the days that have open tasks.
struct CalendarPanel: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    /// The first of the month shown (follows the big calendar when it moves).
    @State private var shown = ""
    let theme = Theme.shared

    private func first(_ day: String) -> String { String(day.prefix(8)) + "01" }

    var body: some View {
        let p = theme.chrome
        let cursor = shell.calCursor
        let month = shown.isEmpty ? first(cursor) : shown
        let monthIndex = CalDates.month(month)
        let today = SessionModel.todayString
        let busy = Set(session.shownTasks.filter { !session.isDone($0) && !$0.locked }.compactMap { $0.dueDate })
        let narrow = ["M", "T", "W", "T", "F", "S", "S"]
        VStack(alignment: .leading, spacing: 0) {
            Text("Calendar").font(.web(15, 650)).foregroundStyle(p.text.color)
                .padding(.horizontal, 16).frame(height: 52, alignment: .center).padding(.bottom, 4)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 2) {
                    Text(Due.format(CalDates.date(month), "MMMM yyyy")).font(.web(13.5, 600)).foregroundStyle(p.text.color)
                    Spacer(minLength: 0)
                    Button { shown = CalDates.step(month, month: true, -1) } label: {
                        Icon("chevron-left", 15, p.text2.color).frame(width: 28, height: 28)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .accessibilityLabel("Previous month")
                    Button { shown = CalDates.step(month, month: true, 1) } label: {
                        Icon("chevron-right", 15, p.text2.color).frame(width: 28, height: 28)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .accessibilityLabel("Next month")
                }
                .padding(.leading, 4)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 2) {
                    ForEach(0..<7, id: \.self) { i in
                        Text(narrow[i]).font(.web(10.5, 600)).foregroundStyle(p.textMuted.color).padding(.vertical, 2)
                    }
                    ForEach(CalDates.monthGrid(month), id: \.self) { d in
                        let selected = d == cursor
                        let out = CalDates.month(d) != monthIndex
                        Button { shell.calCursor = d } label: {
                            Text("\(CalDates.day(d))").font(.web(12, selected ? 600 : (d == today ? 700 : 400))).monospacedDigit()
                                .foregroundStyle(selected ? Color.white : (d == today ? p.accent.color : (out ? p.textMuted.color : p.text2.color)))
                                .frame(maxWidth: .infinity).aspectRatio(1, contentMode: .fit)
                                .background(selected ? p.accentSolid.color : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                                .overlay(alignment: .bottom) {
                                    if busy.contains(d) {
                                        Circle().fill(selected ? Color.white : (out ? p.textMuted.color : p.text2.color)).opacity(0.6)
                                            .frame(width: 4, height: 4).padding(.bottom, 3)
                                    }
                                }
                        }
                        .buttonStyle(PressStyle(radius: 7, pressed: p.bgPressed.color))
                    }
                }
            }
            .padding(.horizontal, 12)
            Spacer(minLength: 0)
        }
        .onChange(of: shell.calCursor) { _, c in shown = first(c) }
    }
}

/// The Calendar ribbon (SectionRibbons.tsx): New | Navigate | View | Filter.
struct CalendarRibbon: View {
    let m: RibbonMetrics
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        let today = SessionModel.todayString
        Group {
            RibbonButton(icon: "plus", m: m) { shell.openQuickAdd(session) }
            RibbonSeparator(m: m)
            RibbonButton(icon: "calendar-days", m: m, enabled: shell.calCursor != today) { shell.calCursor = today }
            RibbonButton(icon: "chevron-left", m: m) { shell.calCursor = CalDates.step(shell.calCursor, month: shell.calMonth, -1) }
            RibbonButton(icon: "chevron-right", m: m) { shell.calCursor = CalDates.step(shell.calCursor, month: shell.calMonth, 1) }
            RibbonSeparator(m: m)
        }
        Group {
            RibbonButton(icon: "calendar-range", m: m, pressed: !shell.calMonth) { shell.calMonth = false }
            RibbonButton(icon: "calendar-days", m: m, pressed: shell.calMonth) { shell.calMonth = true }
            RibbonSeparator(m: m)
            RibbonButton(icon: "user", m: m, pressed: shell.calWho == .mine) { shell.calWho = .mine }
            RibbonButton(icon: "users", m: m, pressed: shell.calWho == .everyone) { shell.calWho = .everyone }
        }
    }
}
