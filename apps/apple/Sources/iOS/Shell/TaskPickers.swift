import NotiveloCore
import SwiftUI

/// The pickers of the task detail sheet (TaskControls.tsx, Labels.tsx, notifications/RecurrencePicker.tsx and
/// ReminderPicker.tsx): each opens as a menu card under its row, in the web's menu style (LOOK.md 4.9).
enum TaskPick: Hashable { case assignee, team, tags, due, priority, repeatRule, reminder }

struct PickFrameKey: PreferenceKey {
    static let defaultValue: [TaskPick: CGRect] = [:]
    static func reduce(value: inout [TaskPick: CGRect], nextValue: () -> [TaskPick: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, b in b })
    }
}

private struct PickHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// A menu card that is as tall as its content, up to `maxHeight`, then scrolls.
struct PickCard<Content: View>: View {
    let palette: Palette
    let width: CGFloat
    let maxHeight: CGFloat
    @ViewBuilder let content: () -> Content
    @State private var measured: CGFloat = 0

    var body: some View {
        let p = palette
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(6)
                .frame(width: width, alignment: .leading)
                .background(GeometryReader { g in Color.clear.preference(key: PickHeightKey.self, value: g.size.height) })
        }
        .onPreferenceChange(PickHeightKey.self) { measured = $0 }
        .scrollDismissesKeyboard(.interactively)
        .frame(width: width, height: min(max(measured, 1), maxHeight))
        .background(p.bgElevated.color, in: shape)
        .clipShape(shape)
        .overlay(shape.stroke(p.border.color, lineWidth: 1))
        .shadowLg(p)
        .environment(\.menuPadding, 6)
    }
}

/// A menu row: a leading view (18 wide), the title, a hint, a check.
struct PickRow<Lead: View>: View {
    let palette: Palette
    let title: String
    var detail: String? = nil
    var hint: String? = nil
    var checked = false
    var indent: CGFloat = 0
    @ViewBuilder let lead: () -> Lead
    let action: () -> Void
    @Environment(\.phoneLayout) private var phone

    var body: some View {
        let p = palette
        Button(action: action) {
            HStack(spacing: 10) {
                lead().frame(width: 18, height: 18)
                HStack(spacing: 0) {
                    Text(title).font(.web(phone ? 15 : 14)).foregroundStyle(p.text.color).lineLimit(1)
                    if let detail {
                        Text(detail).font(.web(phone ? 13 : 12)).foregroundStyle(p.textMuted.color).lineLimit(1)
                    }
                }
                .padding(.leading, indent)
                Spacer(minLength: 0)
                if let hint { Text(hint).font(.web(12)).foregroundStyle(p.textMuted.color).padding(.leading, 12) }
                if checked { Icon("check", 14, p.accent.color) }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: phone ? 44 : 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
    }
}

/// A menu row led by a lucide icon.
func iconPickRow(_ p: Palette, _ icon: String, _ title: String, hint: String? = nil, checked: Bool = false, action: @escaping () -> Void) -> some View {
    PickRow(palette: p, title: title, hint: hint, checked: checked, lead: { Icon(icon, 15, p.textMuted.color) }, action: action)
}

/// A small "search" field of a menu (`.menu-pad .input-sm`).
private struct PickField: View {
    let palette: Palette
    let prompt: String
    @Binding var text: String
    var maxLength = 60
    var onSubmit: () -> Void = {}
    @FocusState private var focused: Bool

    var body: some View {
        let p = palette
        TextField("", text: $text, prompt: Text(prompt).foregroundStyle(p.textPlaceholder.color))
            .font(.web(14))
            .foregroundStyle(p.text.color)
            .tint(p.accent.color)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .focused($focused)
            .onSubmit(onSubmit)
            .onChange(of: text) { _, t in if t.count > maxLength { text = String(t.prefix(maxLength)) } }
            .padding(.horizontal, 10).frame(height: 36)
            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
            .padding(4)
    }
}

/// Teams, top level first and each followed by its subteams (the web's `orderedTeams`).
struct TeamEntry: Identifiable {
    let team: TaskTeam
    let depth: Int
    var id: String { team.id }
}

func orderedTeams(_ teams: [TaskTeam]) -> [TeamEntry] {
    let top = teams.filter { t in t.parentId == nil || !teams.contains(where: { $0.id == t.parentId }) }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    var out: [TeamEntry] = []
    for t in top {
        out.append(TeamEntry(team: t, depth: 0))
        for c in teams.filter({ $0.parentId == t.id }).sorted(by: { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }) {
            out.append(TeamEntry(team: c, depth: 1))
        }
    }
    return out
}

/// A team's name; a subteam is "Parent › Child" (the web's `teamLabel`).
func teamLabel(_ team: TaskTeam, _ teams: [TaskTeam]) -> String {
    if let parent = team.parentId.flatMap({ id in teams.first(where: { $0.id == id }) }) { return "\(parent.name) › \(team.name)" }
    return team.name
}

func colorDot(_ css: String, _ size: CGFloat = 10) -> some View {
    Circle().fill(UIColor(css: css).color).frame(width: size, height: size)
}

// MARK: Assignee

struct AssigneePick: View {
    let palette: Palette
    let value: String?
    let teamId: String?
    let onPick: (String?) -> Void
    @Environment(SessionModel.self) private var session
    @State private var q = ""

    private struct Person { let id: String; let name: String; let email: String; let color: String }

    private var people: [Person] {
        let list = session.members.filter { $0.role != "viewer" || $0.id == value }
            .map { Person(id: $0.id, name: $0.name, email: $0.email, color: $0.color) }
        if list.isEmpty, let me = session.shownUser { return [Person(id: me.id, name: me.name, email: me.email, color: me.color)] }
        return list
    }

    private func row(_ m: Person, _ meId: String?, indent: CGFloat = 0, teams: String? = nil) -> some View {
        PickRow(palette: palette, title: m.name + (m.id == meId ? " (you)" : ""), detail: teams.map { " · \($0)" }, checked: value == m.id, indent: indent,
                lead: { AvatarView(name: m.name, color: UIColor(css: m.color), size: 18) }, action: { onPick(m.id) })
    }

    var body: some View {
        let p = palette
        let me = session.shownUser?.id
        let all = people
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let query = q.trimmingCharacters(in: .whitespaces).lowercased()
        VStack(alignment: .leading, spacing: 0) {
            if all.count > 6 { PickField(palette: p, prompt: "Search people…", text: $q) }
            if !query.isEmpty {
                let teamsOf: (String) -> [String] = { id in session.teams.filter { $0.memberIds.contains(id) }.map { $0.name } }
                let matches = all.filter { m in "\(m.name) \(m.email) \(teamsOf(m.id).joined(separator: " "))".lowercased().contains(query) }
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                ForEach(matches, id: \.id) { m in row(m, me, teams: teamsOf(m.id).isEmpty ? nil : teamsOf(m.id).joined(separator: ", ")) }
                if matches.isEmpty { Text("No matches.").font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(10) }
            } else {
                if let me, let mine = byId[me] { row(mine, me) }
                let teams = orderedTeams(session.teams)
                let own = teams.filter { $0.team.id == teamId || ($0.team.parentId != nil && $0.team.parentId == teamId) }
                let ordered = own + teams.filter { t in !own.contains(where: { $0.team.id == t.team.id }) }
                ForEach(ordered) { entry in
                    let ids = entry.team.memberIds.filter { byId[$0] != nil }
                    if !ids.isEmpty {
                        MenuLabel(palette: p, text: entry.team.name).padding(.leading, entry.depth > 0 ? 12 : 0)
                        ForEach(ids, id: \.self) { id in
                            if let m = byId[id] { row(m, me, indent: CGFloat(entry.depth) * 12) }
                        }
                    }
                }
                let inTeam = Set(session.teams.flatMap { $0.memberIds })
                let rest = all.filter { !inTeam.contains($0.id) && $0.id != me }
                if !rest.isEmpty {
                    MenuLabel(palette: p, text: "Assign to")
                    ForEach(rest, id: \.id) { m in row(m, me) }
                }
            }
            MenuSeparator(palette: p)
            iconPickRow(p, "user-round", "Unassigned", checked: value == nil) { onPick(nil) }
        }
    }
}

// MARK: Team, tags, priority

struct TeamPick: View {
    let palette: Palette
    let value: String?
    let onPick: (String?) -> Void
    @Environment(SessionModel.self) private var session

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 0) {
            if session.teams.isEmpty {
                Text("No teams yet. Owners and admins add them in Settings → Teams.")
                    .font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                MenuLabel(palette: p, text: "Team")
                ForEach(orderedTeams(session.teams)) { entry in
                    PickRow(palette: p, title: entry.team.name, checked: value == entry.team.id, indent: CGFloat(entry.depth) * 12,
                            lead: { colorDot(entry.team.color) }, action: { onPick(entry.team.id) })
                }
                if value != nil {
                    MenuSeparator(palette: p)
                    iconPickRow(p, "ban", "No team") { onPick(nil) }
                }
            }
        }
    }
}

struct TagsPick: View {
    let palette: Palette
    let value: [String]
    let onChange: ([String]) -> Void
    @Environment(SessionModel.self) private var session
    @State private var q = ""

    var body: some View {
        let p = palette
        let query = q.replacingOccurrences(of: "^#+", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let shown = session.tags.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
        let exact = session.tags.contains { $0.name.caseInsensitiveCompare(query) == .orderedSame }
        VStack(alignment: .leading, spacing: 0) {
            PickField(palette: p, prompt: "Find or create a tag…", text: $q, maxLength: 40, onSubmit: { submit(query, shown, exact) })
            ForEach(shown, id: \.id) { t in
                PickRow(palette: p, title: t.name, checked: value.contains(t.id), lead: { colorDot(t.color) }, action: {
                    onChange(value.contains(t.id) ? value.filter { $0 != t.id } : value + [t.id])
                })
            }
            if !query.isEmpty && !exact {
                PickRow(palette: p, title: "Create “\(query)”", lead: { Icon("plus", 15, p.textMuted.color) }, action: { create(query) })
            }
            if shown.isEmpty && query.isEmpty {
                Text("No tags yet. Type a name to create one.").font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(10)
            }
        }
    }

    private func submit(_ query: String, _ shown: [TaskTag], _ exact: Bool) {
        guard !query.isEmpty else { return }
        if let hit = shown.first(where: { $0.name.caseInsensitiveCompare(query) == .orderedSame }) ?? (shown.count == 1 ? shown.first : nil) {
            if !value.contains(hit.id) { onChange(value + [hit.id]) }
            q = ""
        } else if !exact {
            create(query)
        }
    }

    private func create(_ name: String) {
        let current = value
        session.createTag(name) { tag in
            if let tag, !current.contains(tag.id) { onChange(current + [tag.id]) }
        }
        q = ""
    }
}

struct PriorityPick: View {
    let palette: Palette
    let value: UInt8
    let onPick: (UInt8) -> Void

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 0) {
            ForEach([UInt8(1), 2, 3, 4], id: \.self) { n in
                PickRow(palette: p, title: n == 4 ? "No priority" : "Priority \(n)", hint: "p\(n)", checked: value == n,
                        lead: { Icon(n < 4 ? "flag-filled" : "flag", 15, priorityColor(n, p).color) }, action: { onPick(n) })
            }
        }
    }
}

// MARK: Due date

struct DuePick: View {
    let palette: Palette
    let value: String?
    let width: CGFloat
    let onPick: (String?) -> Void
    @State private var date: Date

    init(palette: Palette, value: String?, width: CGFloat, onPick: @escaping (String?) -> Void) {
        self.palette = palette
        self.value = value
        self.width = width
        self.onPick = onPick
        _date = State(initialValue: Due.date(value) ?? Date())
    }

    private func s(_ d: Date) -> String { SessionModel.dayString(d) }
    private func short(_ d: Date) -> String { Due.format(d, "EEE") }
    private func day(_ offset: Int) -> Date { Calendar.current.date(byAdding: .day, value: offset, to: Calendar.current.startOfDay(for: Date())) ?? Date() }

    var body: some View {
        let p = palette
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let toSaturday = (7 - cal.component(.weekday, from: today)) % 7
        let weekend = day(toSaturday)
        let toMonday = (9 - cal.component(.weekday, from: today)) % 7
        let nextWeek = day(toMonday == 0 ? 7 : toMonday)
        VStack(alignment: .leading, spacing: 0) {
            iconPickRow(p, "sun", "Today", hint: short(today), checked: value == s(today)) { onPick(s(today)) }
            iconPickRow(p, "sunrise", "Tomorrow", hint: short(day(1)), checked: value == s(day(1))) { onPick(s(day(1))) }
            if toSaturday != 0 {
                iconPickRow(p, "calendar-days", "This weekend", hint: short(weekend), checked: value == s(weekend)) { onPick(s(weekend)) }
            }
            iconPickRow(p, "calendar-clock", "Next week", hint: short(nextWeek), checked: value == s(nextWeek)) { onPick(s(nextWeek)) }
            if value != nil { iconPickRow(p, "ban", "No date") { onPick(nil) } }
            MenuSeparator(palette: p)
            DatePicker("Due date", selection: $date, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
                .tint(p.accent.color)
                .frame(width: width - 12)
                .onChange(of: date) { _, d in onPick(s(d)) }
        }
    }
}

// MARK: Repeat

struct RulePreset: Identifiable {
    let label: String
    let rule: TaskRecurrence
    var id: String { label }
    init(_ label: String, _ rule: TaskRecurrence) {
        self.label = label
        self.rule = rule
    }
}

struct RelativeReminder: Identifiable {
    let label: String
    let minutes: UInt32
    var id: UInt32 { minutes }
    init(_ label: String, _ minutes: UInt32) {
        self.label = label
        self.minutes = minutes
    }
}

enum RuleLogic {
    static let weekShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    static let nthLabel: [Int: String] = [1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", -1: "last"]

    static func weekday(of day: String) -> Int {
        guard let d = Due.date(day) else { return 0 }
        return Calendar(identifier: .gregorian).component(.weekday, from: d) - 1
    }

    static func monthDay(of day: String) -> Int { Int(day.suffix(2)) ?? 1 }

    static func suffix(_ n: Int) -> String {
        if (11...13).contains(n % 100) { return "th" }
        switch n % 10 {
        case 1: return "st"
        case 2: return "nd"
        case 3: return "rd"
        default: return "th"
        }
    }

    static func key(_ r: TaskRecurrence) -> String {
        let nth = r.byNthWeekday.map { "\($0.n)/\($0.weekday)" } ?? ""
        let days = (r.byWeekday ?? []).map { String($0) }.joined(separator: ",")
        return [r.freq, "\(r.interval ?? 0)", days, "\(r.byMonthDay ?? 0)", nth, r.until ?? "", "\(r.count ?? 0)", r.basis ?? ""].joined(separator: "|")
    }

    /// The web's presets, anchored on the due date (or today).
    static func presets(_ anchor: String) -> [RulePreset] {
        let dow = weekday(of: anchor)
        let dom = monthDay(of: anchor)
        let nth = (dom + 6) / 7
        var out: [RulePreset] = [
            RulePreset("Every day", TaskRecurrence(freq: "day", interval: 1)),
            RulePreset("Every weekday (Mon–Fri)", TaskRecurrence(freq: "weekday")),
            RulePreset("Every week on \(weekShort[dow])", TaskRecurrence(freq: "week", interval: 1, byWeekday: [UInt32(dow)])),
            RulePreset("Every 2 weeks", TaskRecurrence(freq: "week", interval: 2, byWeekday: [UInt32(dow)])),
            RulePreset("Every month on the \(dom)\(suffix(dom))", TaskRecurrence(freq: "month", interval: 1, byMonthDay: Int32(dom))),
        ]
        if nth <= 4 {
            out.append(RulePreset("Every month on the \(nthLabel[nth] ?? "") \(weekShort[dow])",
                        TaskRecurrence(freq: "month", interval: 1, byNthWeekday: TaskNthWeekday(n: Int8(nth), weekday: UInt8(dow)))))
        }
        out.append(RulePreset("Every year", TaskRecurrence(freq: "year", interval: 1, byMonthDay: Int32(dom))))
        return out
    }
}

struct RepeatPick: View {
    let palette: Palette
    let value: TaskRecurrence?
    let dueDate: String?
    let width: CGFloat
    let onPick: (TaskRecurrence?) -> Void
    @State private var custom: Bool

    init(palette: Palette, value: TaskRecurrence?, dueDate: String?, width: CGFloat, onPick: @escaping (TaskRecurrence?) -> Void) {
        self.palette = palette
        self.value = value
        self.dueDate = dueDate
        self.width = width
        self.onPick = onPick
        let anchor = dueDate ?? SessionModel.todayString
        let isPreset = value.map { v in RuleLogic.presets(anchor).contains { RuleLogic.key($0.rule) == RuleLogic.key(v) } } ?? true
        _custom = State(initialValue: !isPreset)
    }

    var body: some View {
        let p = palette
        let anchor = dueDate ?? SessionModel.todayString
        if custom {
            CustomRule(palette: p, initial: value, anchor: anchor, onBack: { custom = false }, onSave: { onPick($0) })
        } else {
            let presets = RuleLogic.presets(anchor)
            let matchesPreset = value.map { v in presets.contains { RuleLogic.key($0.rule) == RuleLogic.key(v) } } ?? false
            VStack(alignment: .leading, spacing: 0) {
                ForEach(presets) { item in
                    iconPickRow(p, "repeat", item.label, checked: value.map { RuleLogic.key($0) == RuleLogic.key(item.rule) } ?? false) { onPick(item.rule) }
                }
                MenuSeparator(palette: p)
                PickRow(palette: p, title: "Custom…", hint: (value != nil && !matchesPreset) ? describeRecurrence(rule: value!, dueDate: dueDate) : nil,
                        lead: { Color.clear }, action: { custom = true })
                if value != nil { iconPickRow(p, "x", "Does not repeat") { onPick(nil) } }
            }
        }
    }
}

/// The custom rule editor (CustomRecurrence): every n units, weekdays, month day or "2nd Tuesday", the end, what the next date counts from.
private struct CustomRule: View {
    let palette: Palette
    let initial: TaskRecurrence?
    let anchor: String
    let onBack: () -> Void
    let onSave: (TaskRecurrence) -> Void
    @State private var unit: String
    @State private var n: Int
    @State private var days: Set<Int>
    @State private var monthMode: String
    @State private var monthDay: Int
    @State private var nth: Int
    @State private var nthDay: Int
    @State private var ends: String
    @State private var until: Date
    @State private var count: Int
    @State private var basis: String

    init(palette: Palette, initial: TaskRecurrence?, anchor: String, onBack: @escaping () -> Void, onSave: @escaping (TaskRecurrence) -> Void) {
        self.palette = palette
        self.initial = initial
        self.anchor = anchor
        self.onBack = onBack
        self.onSave = onSave
        let dow = RuleLogic.weekday(of: anchor)
        let dom = RuleLogic.monthDay(of: anchor)
        _unit = State(initialValue: initial?.freq ?? "week")
        _n = State(initialValue: Int(initial?.interval ?? 1))
        _days = State(initialValue: Set((initial?.byWeekday ?? []).map { Int($0) }.nonEmpty ?? [dow]))
        _monthMode = State(initialValue: initial?.byNthWeekday != nil ? "nth" : (initial?.byMonthDay == -1 ? "last" : "day"))
        _monthDay = State(initialValue: initial?.byMonthDay.flatMap { $0 > 0 ? Int($0) : nil } ?? dom)
        _nth = State(initialValue: initial?.byNthWeekday.map { Int($0.n) } ?? min(4, (dom + 6) / 7))
        _nthDay = State(initialValue: initial?.byNthWeekday.map { Int($0.weekday) } ?? dow)
        _ends = State(initialValue: initial?.until != nil ? "until" : (initial?.count != nil ? "count" : "never"))
        _until = State(initialValue: Due.date(initial?.until) ?? Due.date(anchor) ?? Date())
        _count = State(initialValue: Int(initial?.count ?? 10))
        _basis = State(initialValue: initial?.basis == "completion" ? "completion" : "due")
    }

    private var rule: TaskRecurrence {
        let dom = RuleLogic.monthDay(of: anchor)
        let dow = RuleLogic.weekday(of: anchor)
        let interval = UInt32(min(365, max(1, n)))
        let untilDay: String? = ends == "until" ? SessionModel.dayString(until) : nil
        let total: UInt32? = ends == "count" ? UInt32(max(1, count)) : nil
        let from: String? = basis == "completion" ? "completion" : nil
        switch unit {
        case "weekday":
            return TaskRecurrence(freq: "weekday", until: untilDay, count: total, basis: from)
        case "week":
            return TaskRecurrence(freq: "week", interval: interval, byWeekday: (days.isEmpty ? [dow] : days.sorted()).map { UInt32($0) }, until: untilDay, count: total, basis: from)
        case "month":
            if monthMode == "nth" {
                return TaskRecurrence(freq: "month", interval: interval, byNthWeekday: TaskNthWeekday(n: Int8(nth), weekday: UInt8(nthDay)), until: untilDay, count: total, basis: from)
            }
            return TaskRecurrence(freq: "month", interval: interval, byMonthDay: monthMode == "last" ? -1 : Int32(monthDay), until: untilDay, count: total, basis: from)
        case "year":
            return TaskRecurrence(freq: "year", interval: interval, byMonthDay: Int32(dom), until: untilDay, count: total, basis: from)
        default:
            return TaskRecurrence(freq: "day", interval: interval, until: untilDay, count: total, basis: from)
        }
    }

    private func chip(_ text: String, on: Bool, _ action: @escaping () -> Void) -> some View {
        let p = palette
        return Button(action: action) {
            Text(text).font(.web(13, 500)).foregroundStyle(on ? Color.white : p.text2.color)
                .padding(.horizontal, 10).frame(height: 30)
                .background((on ? p.accentSolid : p.bgHover).color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func stepper(_ value: Binding<Int>, _ range: ClosedRange<Int>) -> some View {
        let p = palette
        return HStack(spacing: 6) {
            Button { value.wrappedValue = max(range.lowerBound, value.wrappedValue - 1) } label: {
                Icon("minus", 14, p.text2.color).frame(width: 30, height: 30).background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
            Text("\(value.wrappedValue)").font(.web(14, 500)).foregroundStyle(p.text.color).frame(minWidth: 30)
            Button { value.wrappedValue = min(range.upperBound, value.wrappedValue + 1) } label: {
                Icon("plus", 14, p.text2.color).frame(width: 30, height: 30).background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.web(12.5)).foregroundStyle(palette.textMuted.color)
    }

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                label("Every")
                HStack(spacing: 8) {
                    if unit != "weekday" { stepper($n, 1...365) }
                    Spacer(minLength: 0)
                }
                HStack(spacing: 6) {
                    chip(n == 1 ? "Day" : "Days", on: unit == "day") { unit = "day" }
                    chip("Weekday", on: unit == "weekday") { unit = "weekday" }
                    chip(n == 1 ? "Week" : "Weeks", on: unit == "week") { unit = "week" }
                }
                HStack(spacing: 6) {
                    chip(n == 1 ? "Month" : "Months", on: unit == "month") { unit = "month" }
                    chip(n == 1 ? "Year" : "Years", on: unit == "year") { unit = "year" }
                }
            }
            if unit == "week" {
                HStack(spacing: 4) {
                    ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in
                        Button {
                            if days.contains(d) { days.remove(d) } else { days.insert(d) }
                        } label: {
                            Text(String(RuleLogic.weekShort[d].prefix(2))).font(.web(12, 600))
                                .foregroundStyle(days.contains(d) ? Color.white : p.text2.color)
                                .frame(width: 32, height: 32)
                                .background((days.contains(d) ? p.accentSolid : p.bgHover).color, in: Circle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if unit == "month" {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        chip("On day", on: monthMode == "day") { monthMode = "day" }
                        stepper(Binding(get: { monthDay }, set: { monthDay = $0; monthMode = "day" }), 1...31)
                    }
                    HStack(spacing: 6) {
                        chip("On the", on: monthMode == "nth") { monthMode = "nth" }
                        Menu {
                            ForEach([1, 2, 3, 4, -1], id: \.self) { k in Button(RuleLogic.nthLabel[k] ?? "") { nth = k; monthMode = "nth" } }
                        } label: { Text(RuleLogic.nthLabel[nth] ?? "").font(.web(13, 500)).foregroundStyle(p.text.color).padding(.horizontal, 8).frame(height: 30).background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 7, style: .continuous)) }
                        Menu {
                            ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { d in Button(RuleLogic.weekShort[d]) { nthDay = d; monthMode = "nth" } }
                        } label: { Text(RuleLogic.weekShort[nthDay]).font(.web(13, 500)).foregroundStyle(p.text.color).padding(.horizontal, 8).frame(height: 30).background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 7, style: .continuous)) }
                    }
                    chip("On the last day", on: monthMode == "last") { monthMode = "last" }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                label("Ends")
                HStack(spacing: 6) {
                    chip("Never", on: ends == "never") { ends = "never" }
                    chip("On date", on: ends == "until") { ends = "until" }
                    chip("After", on: ends == "count") { ends = "count" }
                }
                if ends == "count" {
                    HStack(spacing: 8) { stepper($count, 1...10000); label("times") }
                }
                if ends == "until" {
                    DatePicker("End date", selection: $until, in: (Due.date(anchor) ?? Date())..., displayedComponents: .date)
                        .labelsHidden().tint(p.accent.color)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                label("Next date counts from")
                HStack(spacing: 6) {
                    chip("Due date", on: basis == "due") { basis = "due" }
                    chip("Completion", on: basis == "completion") { basis = "completion" }
                }
            }
            Text(describeRecurrence(rule: rule, dueDate: anchor)).font(.web(13, 600)).foregroundStyle(p.text.color)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                Button(action: onBack) {
                    Text("Back").font(.web(13, 500)).foregroundStyle(p.text2.color).padding(.horizontal, 12).frame(height: 30)
                }
                .buttonStyle(.plain)
                Button { onSave(rule) } label: {
                    Text("Save").font(.web(13, 500)).foregroundStyle(.white).padding(.horizontal, 14).frame(height: 30)
                        .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
    }
}

private extension Array {
    /// nil for an empty array.
    var nonEmpty: [Element]? { isEmpty ? nil : self }
}

// MARK: Reminders

enum ReminderLogic {
    static let relative: [RelativeReminder] = [
        RelativeReminder("At due time", 0), RelativeReminder("10 minutes before", 10), RelativeReminder("30 minutes before", 30), RelativeReminder("1 hour before", 60),
        RelativeReminder("1 day before", 1440), RelativeReminder("2 days before", 2880), RelativeReminder("1 week before", 10080),
    ]

    static func instantText(_ iso: String) -> String {
        guard let d = Due.instant(iso) else { return iso }
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "EEE, d MMM, HH:mm"
        return f.string(from: d)
    }

    static func describe(_ spec: ReminderSpec) -> String {
        switch spec {
        case let .at(at): return instantText(at)
        case let .before(minutes):
            if let preset = relative.first(where: { $0.minutes == minutes }) { return preset.label }
            if minutes % 1440 == 0 { return "\(minutes / 1440) days before" }
            if minutes % 60 == 0 { return "\(minutes / 60) hours before" }
            return "\(minutes) minutes before"
        }
    }

    static func iso(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}

struct ReminderPick: View {
    let palette: Palette
    let hasDueDate: Bool
    let width: CGFloat
    let onAdd: (ReminderSpec) -> Void
    @State private var mode: String
    @State private var at = Date().addingTimeInterval(3600)

    init(palette: Palette, hasDueDate: Bool, width: CGFloat, onAdd: @escaping (ReminderSpec) -> Void) {
        self.palette = palette
        self.hasDueDate = hasDueDate
        self.width = width
        self.onAdd = onAdd
        _mode = State(initialValue: hasDueDate ? "before" : "at")
    }

    private func segment(_ text: String, _ key: String, enabled: Bool = true) -> some View {
        let p = palette
        let on = mode == key
        return Button { if enabled { mode = key } } label: {
            Text(text).font(.web(13, 500)).foregroundStyle((on ? p.text : p.text2).color).opacity(enabled ? 1 : 0.4)
                .frame(maxWidth: .infinity).frame(height: 28)
                .background(on ? p.bgElevated.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .shadow(color: on ? Color.black.opacity(0.12) : .clear, radius: 1, y: 1)
        }
        .buttonStyle(.plain)
    }

    var body: some View {
        let p = palette
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                segment("Before due", "before", enabled: hasDueDate)
                segment("At a time", "at")
            }
            .padding(2)
            .background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(4)
            if mode == "before" {
                ForEach(ReminderLogic.relative) { item in
                    iconPickRow(p, "bell", item.label) { onAdd(.before(minutes: item.minutes)) }
                }
            } else {
                DatePicker("Reminder time", selection: $at, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical).labelsHidden().tint(p.accent.color)
                    .frame(width: width - 12)
                Button { onAdd(.at(at: ReminderLogic.iso(at))) } label: {
                    Text("Add").font(.web(13, 500)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).frame(height: 34)
                        .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(4)
            }
        }
    }
}
