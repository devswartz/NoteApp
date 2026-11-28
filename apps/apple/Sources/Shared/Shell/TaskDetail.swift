import NotiveloCore
import SwiftUI

/// The task detail sheet (TaskDetail.tsx, LOOK.md 4.10): a side sheet 480 wide on the iPad, a bottom sheet (92 % high)
/// on phones, over a dim backdrop. Every field is editable through `Core.updateTask` (assignee, team, tags, due date,
/// time, priority, repeat, reminders, details); each opens the web's picker as a menu card under its row.
struct TaskDetailLayer: View {
    let width: CGFloat
    let height: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone

    var body: some View {
        if let id = shell.taskDetailId, let task = session.shownTasks.first(where: { $0.id == id }) {
            ZStack(alignment: phone ? .bottom : .trailing) {
                PlatformColor(hex: 0x0A0A14, alpha: 0.18).color.contentShape(Rectangle())
                    .onTapGesture { shell.taskDetailId = nil }
                TaskSheet(task: task, phone: phone, size: CGSize(width: phone ? width : min(480, width), height: phone ? height * 0.92 : height))
                    .id(task.id)
            }
            .frame(width: width, height: height)
        }
    }
}

struct TaskSheet: View {
    let task: CoreTask
    let phone: Bool
    let size: CGSize
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var title: String
    @State private var desc: String
    @State private var subtask = ""
    @State private var picker: TaskPick?
    @State private var frames: [TaskPick: CGRect] = [:]
    @FocusState private var titleFocused: Bool
    @FocusState private var descFocused: Bool
    let theme = Theme.shared

    init(task: CoreTask, phone: Bool, size: CGSize) {
        self.task = task
        self.phone = phone
        self.size = size
        _title = State(initialValue: task.title)
        _desc = State(initialValue: task.description)
    }

    private var done: Bool { session.isDone(task) }
    private func soon(_ what: String) { shell.notYet(what) }
    /// The task with every field (nil until the core has answered, and in corpus mode).
    private var full: TaskDetail? { session.details[task.id] }
    private var canEdit: Bool { !task.locked && session.workspace?.role != "viewer" }

    private func change(_ c: TaskChanges) {
        guard canEdit else { return }
        session.update(task.id, c) { shell.say($0) }
    }

    private func open(_ pick: TaskPick) {
        guard canEdit else { return }
        titleFocused = false
        descFocused = false
        picker = picker == pick ? nil : pick
    }

    var body: some View {
        let p = theme.chrome
        let shape = UnevenRoundedRectangle(cornerRadii: .init(topLeading: phone ? 16 : 0, bottomLeading: 0, bottomTrailing: 0, topTrailing: phone ? 16 : 0), style: .continuous)
        VStack(spacing: 0) {
            head(p)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    titleRow(p)
                    props(p).padding(.top, 18)
                    descriptionBox(p).padding(.top, 18)
                    if task.pageId != nil { TaskNotesSection(task: task, palette: p) }
                    subtasks(p)
                    foot(p)
                }
                .padding(.horizontal, phone ? 16 : 24)
                .padding(.vertical, phone ? 16 : 20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .noEdgeEffect()
            .dismissKeyboardOnScroll()
        }
        .coordinateSpace(name: "tasksheet")
        .onPreferenceChange(PickFrameKey.self) { frames = $0 }
        .frame(width: size.width, height: size.height)
        .background(p.bgElevated.color)
        .clipShape(shape)
        .overlay(alignment: .topLeading) { pickerLayer(p) }
        .overlay(alignment: phone ? .top : .leading) {
            if phone { Rectangle().fill(p.border.color).frame(height: 1) } else { Rectangle().fill(p.border.color).frame(width: 1) }
        }
        .shadowLg(p)
        .onAppear { session.loadDetail(task.id) }
        .onDisappear { commitDesc() }
        .onChange(of: task.id) { picker = nil }
    }

    // MARK: Pickers

    @ViewBuilder
    private func pickerLayer(_ p: Palette) -> some View {
        if let pick = picker, let f = frames[pick] {
            let wide = pick == .due || pick == .repeatRule || pick == .reminder
            let cardW = min(wide ? 340 : 280, size.width - 24)
            let x = min(max(f.minX + (phone ? 100 : 110), 12), size.width - cardW - 12)
            let y = min(f.maxY + 2, size.height - 240)
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.001).contentShape(Rectangle()).onTapGesture { picker = nil }
                pickCard(pick, p, width: cardW, maxHeight: size.height - y - 12).offset(x: x, y: y)
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private func pickCard(_ pick: TaskPick, _ p: Palette, width: CGFloat, maxHeight: CGFloat) -> some View {
        PickCard(palette: p, width: width, maxHeight: maxHeight) {
            switch pick {
            case .assignee:
                AssigneePick(palette: p, value: task.assigneeId, teamId: full?.teamId) { id in
                    change(TaskChanges(assigneeId: id, clearAssignee: id == nil))
                    picker = nil
                }
            case .team:
                TeamPick(palette: p, value: full?.teamId) { id in
                    change(TaskChanges(teamId: id, clearTeam: id == nil))
                    picker = nil
                }
            case .tags:
                TagsPick(palette: p, value: task.tagIds) { ids in change(TaskChanges(tagIds: ids)) }
            case .due:
                DuePick(palette: p, value: task.dueDate, width: width) { day in
                    change(TaskChanges(dueDate: day, clearDueDate: day == nil))
                    picker = nil
                }
            case .priority:
                PriorityPick(palette: p, value: task.priority) { n in
                    change(TaskChanges(priority: n))
                    picker = nil
                }
            case .repeatRule:
                RepeatPick(palette: p, value: full?.recurrence, dueDate: task.dueDate, width: width) { rule in
                    // As the web: a rule on a task without a date sets the date to the rule's first day.
                    let first = (rule != nil && task.dueDate == nil) ? firstOccurrence(rule: rule!, from: SessionModel.todayString) : nil
                    change(TaskChanges(dueDate: first, recurrence: rule, clearRecurrence: rule == nil))
                    picker = nil
                }
            case .reminder:
                ReminderPick(palette: p, hasDueDate: task.dueDate != nil, width: width) { spec in
                    guard canEdit else { return }
                    session.addReminder(task.id, spec) { shell.say($0) }
                    picker = nil
                }
            }
        }
    }

    // MARK: Head

    private func head(_ p: Palette) -> some View {
        HStack(spacing: 16) {
            crumb(p).frame(maxWidth: .infinity, alignment: .leading)
            iconButton("trash", 16, p, "Delete task") {
                let shell = self.shell
                session.deleteWithUndo([task.id]) { text, undo in shell.say(text, undo: undo) }
                shell.taskDetailId = nil
            }
            iconButton("x", 18, p, "Close") { shell.taskDetailId = nil }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    private func iconButton(_ name: String, _ icon: CGFloat, _ p: Palette, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name, icon, p.text2.color).frame(width: 32, height: 32)
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func crumb(_ p: Palette) -> some View {
        if let parent = task.parentId {
            let name = session.shownTasks.first(where: { $0.id == parent })?.title ?? "a task"
            chip("corner-down-right", "Subtask of \(name)", p) { shell.openTask(parent) }
        } else if let pid = task.pageId {
            let page = session.shownTree?.pages.first(where: { $0.id == pid })
            let name = page?.title ?? LookData.otherPageTitles[pid]
            if let name {
                chip("file-text", name.isEmpty ? "Untitled" : name, p) {
                    if page != nil {
                        shell.taskDetailId = nil
                        shell.open(page: pid)
                    } else {
                        soon("Opening that page")
                    }
                }
            } else {
                Text("Standalone task").font(.web(12.5)).foregroundStyle(p.textMuted.color)
            }
        } else {
            Text("Standalone task").font(.web(12.5)).foregroundStyle(p.textMuted.color)
        }
    }

    private func chip(_ icon: String, _ text: String, _ p: Palette, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Icon(icon, 13, p.text2.color)
                Text(text).font(.web(12, 500)).foregroundStyle(p.text2.color).lineLimit(1)
            }
            .padding(.horizontal, 7).frame(height: 22)
            .background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .frame(maxWidth: 220, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    // MARK: Title

    private func commitTitle() {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { title = task.title } else if t != task.title { session.rename(task: task, to: t) }
    }

    private func titleRow(_ p: Palette) -> some View {
        HStack(alignment: .top, spacing: 10) {
            TaskCircle(priority: task.priority, done: done, size: 20, palette: p) { session.setDone(task, !done) }
                .padding(.top, 7)
                .disabled(task.locked)
            TextField("", text: $title, axis: .vertical)
                .font(.web(20, 600))
                .foregroundStyle((done ? p.textMuted : p.text).color)
                .strikethrough(done)
                .tint(p.accent.color)
                .lineSpacing(3.5)
                .focused($titleFocused)
                .submitLabel(.done)
                .onSubmit { commitTitle(); titleFocused = false }
                .onChange(of: titleFocused) { _, f in if !f { commitTitle() } }
                .onChange(of: task.title) { _, t in if !titleFocused { title = t } }
                .onChange(of: title) { _, t in if t.contains("\n") { title = t.replacingOccurrences(of: "\n", with: "") } }
                .frame(minHeight: 34, alignment: .center)
        }
        .frame(minHeight: 45, alignment: .top)
    }

    // MARK: Properties

    private func prop<V: View>(_ icon: String, _ label: String, _ p: Palette, pick: TaskPick? = nil, @ViewBuilder _ value: () -> V) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 8) {
                Icon(icon, 15, p.textMuted.color)
                Text(label).font(.web(13)).foregroundStyle(p.textMuted.color)
            }
            .frame(width: phone ? 110 : 120, alignment: .leading)
            value()
                .font(.web(phone ? 15 : 14))
                .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { if let pick { open(pick) } }
        }
        .frame(minHeight: 44)
        .background(GeometryReader { g in
            Color.clear.preference(key: PickFrameKey.self, value: pick.map { [$0: g.frame(in: .named("tasksheet"))] } ?? [:])
        })
    }

    private func props(_ p: Palette) -> some View {
        let tone = done ? p.text : Due.tone(task.dueDate, p)
        let assignee = session.member(task.assigneeId)
        let me = session.shownUser
        let team = full?.teamId.flatMap { id in session.teams.first(where: { $0.id == id }) }
        let ownTags = task.tagIds.compactMap { id in session.tags.first(where: { $0.id == id }) }
        let due = Due.words(task.dueDate)
        return VStack(alignment: .leading, spacing: 2) {
            VStack(alignment: .leading, spacing: 0) {
                prop("user-round", "Assignee", p, pick: .assignee) {
                    if let id = task.assigneeId {
                        HStack(spacing: 8) {
                            if let assignee {
                                AvatarView(name: assignee.name, color: PlatformColor(css: assignee.color), size: 18)
                                Text(assignee.name).foregroundStyle(p.text.color).lineLimit(1)
                            } else if let me, me.id == id {
                                AvatarView(name: me.name, color: PlatformColor(css: me.color), size: 18)
                                Text(me.name).foregroundStyle(p.text.color).lineLimit(1)
                            } else {
                                Circle().stroke(p.borderStrong.color, lineWidth: 1.5).frame(width: 18, height: 18)
                                Text("Another member").foregroundStyle(p.text.color)
                            }
                        }
                    } else {
                        Text("Unassigned").foregroundStyle(p.textMuted.color)
                    }
                }
                if let by = full?.assignedBy, let id = task.assigneeId, by != id {
                    Text("Assigned by \(session.member(by)?.name ?? "a former member")")
                        .font(.web(12.5)).foregroundStyle(p.textMuted.color)
                        .padding(.leading, (phone ? 110 : 120) + 8).padding(.top, -6).padding(.bottom, 4)
                }
            }
            prop("users", "Team", p, pick: .team) {
                if let team {
                    HStack(spacing: 8) {
                        colorDot(team.color, 8)
                        Text(teamLabel(team, session.teams)).foregroundStyle(p.text.color).lineLimit(1)
                    }
                } else {
                    Text("No team").foregroundStyle(p.textMuted.color)
                }
            }
            prop("tag", "Tags", p, pick: .tags) {
                if ownTags.isEmpty {
                    Text("No tags").foregroundStyle(p.textMuted.color)
                } else {
                    FlowLayout(spacing: 4, lineSpacing: 4) {
                        ForEach(ownTags, id: \.id) { t in
                            Text(t.name).font(.web(12, 500)).lineLimit(1)
                                .foregroundStyle(PlatformColor.mix(PlatformColor(css: t.color), 0.7, p.text).color)
                                .padding(.horizontal, 7).frame(height: 22)
                                .background(PlatformColor(css: t.color).withAlphaComponent(0.16).color, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    }
                }
            }
            prop("calendar-days", "Due date", p, pick: .due) {
                if let due { Text(due).foregroundStyle(tone.color) } else { Text("No date").foregroundStyle(p.textMuted.color) }
            }
            prop("clock", "Time", p) { timeField(p) }
            prop("flag", "Priority", p, pick: .priority) {
                HStack(spacing: 8) {
                    Icon(task.priority < 4 ? "flag-filled" : "flag", 14, priorityColor(task.priority, p).color)
                    Text(["Priority 1", "Priority 2", "Priority 3", "No priority"][Int(min(max(task.priority, 1), 4)) - 1]).foregroundStyle(p.text.color)
                }
            }
            prop("repeat", "Repeat", p, pick: .repeatRule) {
                if let rule = full?.recurrence {
                    Text(describeRecurrence(rule: rule, dueDate: task.dueDate)).foregroundStyle(p.text.color).lineLimit(2)
                } else {
                    Text("Does not repeat").foregroundStyle(p.textMuted.color)
                }
            }
            prop("bell", "Reminders", p) { reminderList(p) }
        }
    }

    // MARK: Time

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                let parts = (task.dueTime ?? "09:00").split(separator: ":").compactMap { Int($0) }
                let h = parts.first ?? 9, m = parts.count > 1 ? parts[1] : 0
                return Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date()) ?? Date()
            },
            set: { d in
                let t = Self.clock.string(from: d)
                if t != task.dueTime { setTime(t) }
            }
        )
    }

    /// Setting a time on a task without a date sets the date to today (as the web does).
    private func setTime(_ t: String?) {
        let day: String? = (t != nil && task.dueDate == nil) ? SessionModel.todayString : nil
        change(TaskChanges(dueDate: day, dueTime: t, clearDueTime: t == nil))
    }

    @ViewBuilder
    private func timeField(_ p: Palette) -> some View {
        if task.dueTime != nil {
            HStack(spacing: 10) {
                DatePicker("Time", selection: timeBinding, displayedComponents: .hourAndMinute)
                    .labelsHidden().tint(p.accent.color).disabled(!canEdit)
                if canEdit {
                    Button { setTime(nil) } label: { Icon("x", 14, p.textMuted.color).frame(width: 30, height: 30) }
                        .buttonStyle(.plain).accessibilityLabel("Clear time")
                }
            }
        } else {
            HStack(spacing: 30) {
                Text("--:-- --").foregroundStyle(p.textMuted.color)
                Icon("clock", 14, p.textMuted.color)
            }
            .onTapGesture { if canEdit { setTime("09:00") } }
        }
    }

    // MARK: Reminders

    @ViewBuilder
    private func reminderList(_ p: Palette) -> some View {
        let list = session.reminders[task.id] ?? []
        VStack(alignment: .leading, spacing: 2) {
            if let at = full?.reminderAt {
                // The original single reminder: shown and clearable; new ones go through the picker.
                reminderLine(p, ReminderLogic.instantText(at), note: nil) { change(TaskChanges(clearReminderAt: true)) }
            }
            ForEach(list, id: \.id) { r in
                reminderLine(p, ReminderLogic.describe(r.spec), note: reminderNote(r)) { session.deleteReminder(task.id, r.id) { shell.say($0) } }
                    .opacity(r.nextFireAt == nil ? 0.7 : 1)
            }
            if canEdit {
                Button { open(.reminder) } label: {
                    HStack(spacing: 8) {
                        Icon("plus", 15, p.text2.color)
                        Text(list.isEmpty && full?.reminderAt == nil ? "Add reminder" : "Add another").font(.web(13, 600)).foregroundStyle(p.text2.color)
                    }
                    .frame(minHeight: 30)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func reminderNote(_ r: TaskReminder) -> String? {
        guard r.nextFireAt == nil else { return nil }
        if r.lastFiredAt != nil { return "sent" }
        if done { return "done" }
        if case .before = r.spec, task.dueDate == nil { return "no due date" }
        return nil
    }

    private func reminderLine(_ p: Palette, _ text: String, note: String?, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Icon("bell", 13, p.text2.color)
            Text(text).font(.web(13)).foregroundStyle(p.text.color).lineLimit(1)
            if let note { Text(note).font(.web(12)).foregroundStyle(p.textMuted.color) }
            Spacer(minLength: 0)
            if canEdit {
                Button(action: remove) { Icon("trash", 13, p.textMuted.color).frame(width: 30, height: 30) }
                    .buttonStyle(.plain).accessibilityLabel("Remove reminder")
            }
        }
        .frame(minHeight: 30)
    }

    // MARK: Details, subtasks, footer

    private func commitDesc() {
        if canEdit && desc != task.description { change(TaskChanges(description: desc)) }
    }

    private func descriptionBox(_ p: Palette) -> some View {
        TextField("", text: $desc, prompt: Text(canEdit ? "Add details…" : "No details").foregroundStyle(p.textPlaceholder.color), axis: .vertical)
            .font(.web(phone ? 15 : 14))
            .lineSpacing(phone ? 5 : 4.5)
            .foregroundStyle(p.text.color)
            .tint(p.accent.color)
            .focused($descFocused)
            .disabled(!canEdit)
            .padding(.vertical, 10).padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
            .contentShape(Rectangle())
            .onTapGesture { if canEdit { descFocused = true } }
            .onChange(of: descFocused) { _, f in if !f { commitDesc() } }
            .onChange(of: task.description) { _, t in if !descFocused { desc = t } }
    }

    private func subtasks(_ p: Palette) -> some View {
        let subs = session.shownTasks.filter { $0.parentId == task.id }
        let doneCount = subs.filter { session.isDone($0) }.count
        return VStack(alignment: .leading, spacing: 0) {
            if task.parentId == nil {
                HStack(spacing: 8) {
                    Icon("list-checks", 15, p.textMuted.color)
                    Text("Subtasks").font(.web(13, 600)).foregroundStyle(p.text2.color)
                    if !subs.isEmpty { Text("\(doneCount)/\(subs.count)").font(.web(12.5)).foregroundStyle(p.textMuted.color) }
                }
                .frame(height: 20)
                .padding(.top, 22)
                if !subs.isEmpty {
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(p.bgHover.color)
                            Capsule().fill(p.success.color).frame(width: g.size.width * CGFloat(doneCount) / CGFloat(subs.count))
                        }
                    }
                    .frame(height: 4).padding(.top, 8)
                }
                ForEach(subs, id: \.id) { s in
                    HStack(spacing: 10) {
                        TaskCircle(priority: s.priority, done: session.isDone(s), size: 18, palette: p) { session.setDone(s, !session.isDone(s)) }
                        Button { shell.openTask(s.id) } label: {
                            Text(s.title.isEmpty ? "Untitled" : s.title).font(.web(phone ? 15 : 14)).lineLimit(1)
                                .strikethrough(session.isDone(s))
                                .foregroundStyle((session.isDone(s) ? p.textMuted : p.text).color)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 2)
                    .frame(minHeight: phone ? 44 : 36)
                }
                HStack(spacing: 10) {
                    Icon("plus", 15, p.textMuted.color).frame(width: 18)
                    TextField("", text: $subtask, prompt: Text("Add a subtask…").foregroundStyle(p.textPlaceholder.color))
                        .font(.web(phone ? 14.5 : 14))
                        .foregroundStyle(p.text.color)
                        .tint(p.accent.color)
                        .submitLabel(.done)
                        .onSubmit {
                            session.addSubtask(to: task, title: subtask)
                            subtask = ""
                        }
                }
                .padding(.horizontal, 2)
                .frame(height: 44)
                .padding(.top, subs.isEmpty ? 10 : 2)
            }
        }
    }

    private func foot(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Created by \(session.personName(full?.createdBy ?? session.shownUser?.id)) · \(Due.ago(task.createdAt))")
            if done, let at = task.completedAt {
                Text("Completed by \(session.personName(full?.completedBy ?? session.shownUser?.id)) · \(Due.ago(at))")
            }
        }
        .font(.web(12.5)).foregroundStyle(p.textMuted.color)
        .lineSpacing(4.5)
        .padding(.top, task.parentId == nil ? 21 : 18)
    }
}
