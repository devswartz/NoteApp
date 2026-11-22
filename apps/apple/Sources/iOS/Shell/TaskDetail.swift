import NotiveloCore
import SwiftUI

/// The task detail sheet (TaskDetail.tsx, LOOK.md 4.10): a side sheet 480 wide on the iPad, a bottom sheet (92 % high)
/// on phones, over a dim backdrop. What the core can change shows as editable (the title, done, delete, subtasks);
/// the rest (assignee, due date, time, priority, details) is read-only for now, a tap says so.
struct TaskDetailLayer: View {
    let width: CGFloat
    let height: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone

    var body: some View {
        if let id = shell.taskDetailId, let task = session.shownTasks.first(where: { $0.id == id }) {
            ZStack(alignment: phone ? .bottom : .trailing) {
                Color(uiColor: UIColor(hex: 0x0A0A14, alpha: 0.18)).contentShape(Rectangle())
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
    @State private var subtask = ""
    @FocusState private var titleFocused: Bool
    let theme = Theme.shared

    init(task: CoreTask, phone: Bool, size: CGSize) {
        self.task = task
        self.phone = phone
        self.size = size
        _title = State(initialValue: task.title)
    }

    private var done: Bool { session.isDone(task) }
    private func soon(_ what: String) { shell.notYet(what) }

    var body: some View {
        let p = theme.chrome
        let shape = UnevenRoundedRectangle(cornerRadii: .init(topLeading: phone ? 16 : 0, bottomLeading: 0, bottomTrailing: 0, topTrailing: phone ? 16 : 0), style: .continuous)
        VStack(spacing: 0) {
            head(p)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    titleRow(p)
                    props(p).padding(.top, 18)
                    details(p).padding(.top, 18)
                    subtasks(p)
                    foot(p)
                }
                .padding(.horizontal, phone ? 16 : 24)
                .padding(.vertical, phone ? 16 : 20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .noEdgeEffect()
            .scrollDismissesKeyboard(.interactively)
        }
        .frame(width: size.width, height: size.height)
        .background(p.bgElevated.color)
        .clipShape(shape)
        .overlay(alignment: phone ? .top : .leading) {
            if phone { Rectangle().fill(p.border.color).frame(height: 1) } else { Rectangle().fill(p.border.color).frame(width: 1) }
        }
        .shadowLg(p)
    }

    // MARK: Head

    private func head(_ p: Palette) -> some View {
        HStack(spacing: 16) {
            crumb(p).frame(maxWidth: .infinity, alignment: .leading)
            iconButton("trash", 16, p, "Delete task") {
                session.delete(taskId: task.id)
                shell.taskDetailId = nil
                shell.say("Task deleted")
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

    private func prop<V: View>(_ icon: String, _ label: String, _ p: Palette, tap: String? = nil, @ViewBuilder _ value: () -> V) -> some View {
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
                .onTapGesture { if let tap { soon(tap) } }
        }
        .frame(minHeight: 44)
    }

    private func props(_ p: Palette) -> some View {
        let me = session.shownUser
        let due = Due.words(task.dueDate)
        let tone = done ? p.text : Due.tone(task.dueDate, p)
        return VStack(alignment: .leading, spacing: 2) {
            prop("user-round", "Assignee", p, tap: "Changing the assignee") {
                if let id = task.assigneeId {
                    HStack(spacing: 8) {
                        if let me, me.id == id {
                            AvatarView(name: me.name, color: UIColor(css: me.color), size: 18)
                            Text(me.name).foregroundStyle(p.text.color)
                        } else {
                            Circle().stroke(p.borderStrong.color, lineWidth: 1.5).frame(width: 18, height: 18)
                            Text("Another member").foregroundStyle(p.text.color)
                        }
                    }
                } else {
                    Text("Unassigned").foregroundStyle(p.textMuted.color)
                }
            }
            prop("tag", "Tags", p, tap: "Changing tags") {
                if task.tagIds.isEmpty {
                    Text("No tags").foregroundStyle(p.textMuted.color)
                } else {
                    Text(task.tagIds.count == 1 ? "1 tag" : "\(task.tagIds.count) tags").foregroundStyle(p.text.color)
                }
            }
            prop("calendar-days", "Due date", p, tap: "Changing the due date") {
                if let due { Text(due).foregroundStyle(tone.color) } else { Text("No date").foregroundStyle(p.textMuted.color) }
            }
            prop("clock", "Time", p, tap: "Changing the time") {
                HStack(spacing: 30) {
                    Text(timeText(task.dueTime) ?? "--:-- --").foregroundStyle(p.text.color)
                    Icon("clock", 14, p.text.color)
                }
            }
            prop("flag", "Priority", p, tap: "Changing the priority") {
                HStack(spacing: 8) {
                    Icon(task.priority < 4 ? "flag-filled" : "flag", 14, priorityColor(task.priority, p).color)
                    Text(["Priority 1", "Priority 2", "Priority 3", "No priority"][Int(min(max(task.priority, 1), 4)) - 1]).foregroundStyle(p.text.color)
                }
            }
            prop("bell", "Reminders", p, tap: "Reminders") {
                HStack(spacing: 8) {
                    Icon("plus", 15, p.text2.color)
                    Text("Add reminder").font(.web(13, 600)).foregroundStyle(p.text2.color)
                }
            }
        }
    }

    /// "10:00 AM" from "10:00" (the web's time field shows the device's clock style).
    private func timeText(_ t: String?) -> String? {
        guard let t, t.count >= 4 else { return nil }
        let parts = t.split(separator: ":")
        guard parts.count >= 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return t }
        return String(format: "%02d:%02d %@", h % 12 == 0 ? 12 : h % 12, m, h < 12 ? "AM" : "PM")
    }

    // MARK: Details, subtasks, footer

    private func details(_ p: Palette) -> some View {
        let empty = task.description.isEmpty
        return Text(empty ? "Add details…" : task.description)
            .font(.web(phone ? 15 : 14))
            .lineSpacing(phone ? 5 : 4.5)
            .foregroundStyle((empty ? p.textPlaceholder : p.text).color)
            .padding(.vertical, 10).padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
            .contentShape(Rectangle())
            .onTapGesture { soon("Editing details") }
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
            Text("Created \(Due.ago(task.createdAt))")
            if done, let at = task.completedAt { Text("Completed \(Due.ago(at))") }
        }
        .font(.web(12.5)).foregroundStyle(p.textMuted.color)
        .lineSpacing(4.5)
        .padding(.top, task.parentId == nil ? 21 : 18)
    }
}
