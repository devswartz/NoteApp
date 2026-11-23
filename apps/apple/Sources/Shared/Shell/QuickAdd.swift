import NotiveloCore
import SwiftUI

/// Quick add (src/components/QuickAdd.tsx, LOOK.md 4.12): one line of natural language ("Review proposal tomorrow 3pm
/// p1 @alex every week"), read by the core's `parseQuickAdd`, then the task is made with `createTaskWith`, the way the
/// web does: `@name` and `+team` are looked up (kept in the title when nobody matches), `#tags` are found or made
/// (`createTag`), and the assignee defaults to you.
struct QuickAddSeed: Equatable {
    /// The page the task is written on (the page's Task button), if any.
    var pageId: String?
    /// A day to start from (the Calendar's + on a day).
    var dueDate: String?
    /// Words to start with (the search palette's "Create task …").
    var text = ""
}

struct QuickAddCard: View {
    let seed: QuickAddSeed
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    @State private var text = ""
    @State private var desc = ""
    @State private var busy = false
    /// Due date and priority picked from the chips take precedence over what the line says.
    @State private var dueOverride: String?
    @State private var dueCleared = false
    @State private var priorityOverride: UInt8?
    @FocusState private var focused: Bool
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let q = parseQuickAdd(text: text, today: SessionModel.todayString)
        let due = finalDue(q)
        let priority = priorityOverride ?? q.priority ?? 4
        let me = session.shownUser
        let mentioned: WorkspaceMember? = q.assignee.flatMap { m in
            resolveMember(mention: m, members: session.members, me: me?.id ?? "").flatMap { id in session.members.first { $0.id == id } }
        }
        let teamName: String? = q.team.flatMap { t in
            resolveTeam(text: t, teams: session.teams).flatMap { id in session.teams.first { $0.id == id }?.name }
        }
        let pageTitle = seed.pageId.flatMap { id in session.shownTree?.pages.first { $0.id == id }?.title }
        let ready = !q.title.trimmingCharacters(in: .whitespaces).isEmpty && !busy
        VStack(alignment: .leading, spacing: 0) {
            TextField("", text: $text,
                      prompt: Text(phone ? "e.g. Call Sam tomorrow 3pm p1" : "e.g. Review proposal tomorrow 3pm p1 @alex every week")
                          .foregroundStyle(p.textPlaceholder.color))
                .font(.web(17, 500))
                .foregroundStyle(p.text.color)
                .tint(p.accent.color)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { if ready { submit(q, keepOpen: false) } }
                .frame(minHeight: 31)
            TextField("", text: $desc,
                      prompt: Text("Description").foregroundStyle(p.textPlaceholder.color),
                      axis: .vertical)
                .font(.web(14))
                .foregroundStyle(p.text2.color)
                .tint(p.accent.color)
                .lineLimit(1...5)
                .padding(.top, 2).padding(.bottom, 8)
            FlowLayout(spacing: 6, lineSpacing: 6) {
                dueChip(due, time: q.dueTime, p)
                priorityChip(priority, p)
                if let mentioned {
                    chip("user-round", mentioned.id == me?.id ? "Me" : mentioned.name, active: true, p)
                } else if let me, q.assignee == nil {
                    HStack(spacing: 6) {
                        AvatarView(name: me.name, color: PlatformColor(css: me.color), size: 14)
                        Text("Me").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                    }
                    .padding(.horizontal, phone ? 14 : 9).frame(height: phone ? 44 : 28)
                    .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                } else {
                    chip("user-round", "Unassigned", active: false, p)
                }
                chip("users", teamName ?? "Team", active: teamName != nil, p)
                chip("tag", q.tags.isEmpty ? "Tags" : q.tags.joined(separator: ", "), active: !q.tags.isEmpty, p)
                if let rule = q.recurrence {
                    chip("repeat", describeRecurrence(rule: rule, dueDate: due), active: true, p)
                }
                if let pageTitle {
                    chip("file-text", pageTitle.isEmpty ? "Untitled" : pageTitle, active: false, p)
                }
            }
            .padding(.bottom, 12)
            HStack(spacing: 8) {
                if !phone {
                    Text("↵ add · ⌘↵ add another").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                }
                Spacer(minLength: 0)
                Button { shell.sheet = nil } label: {
                    Text("Cancel").font(.web(14, 500)).foregroundStyle(p.text.color)
                        .padding(.horizontal, 12).frame(height: phone ? 44 : 32)
                        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Button { submit(q, keepOpen: false) } label: {
                    Text("Add task").font(.web(14, 500)).foregroundStyle(.white)
                        .padding(.horizontal, 12).frame(height: phone ? 44 : 32)
                        .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!ready)
                .opacity(ready ? 1 : 0.5)
            }
            .padding(.top, 12)
            .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 12)
        .frame(width: width, alignment: .leading)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .shadowLg(p)
        .background {
            // Command-Return adds the task and keeps the dialog for the next one.
            Button("") { if ready { submit(q, keepOpen: true) } }
                .keyboardShortcut(.return, modifiers: .command).opacity(0).accessibilityHidden(true)
        }
        .onAppear { text = seed.text; focused = true }
    }

    private func finalDue(_ q: QuickAddResult) -> String? {
        if dueCleared { return nil }
        return dueOverride ?? q.dueDate ?? seed.dueDate
    }

    // MARK: Chips

    private func chipLabel(_ icon: String, _ label: String, active: Bool, _ p: Palette, color: Color? = nil) -> some View {
        HStack(spacing: 6) {
            Icon(icon, 13, color ?? (active ? p.accent.color : p.text2.color))
            Text(label).font(.web(12.5, 500)).foregroundStyle(active ? p.accent.color : p.text2.color).lineLimit(1)
        }
        .padding(.horizontal, phone ? 14 : 9).frame(height: phone ? 44 : 28)
        .background(active ? p.accentSoft.color : p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(active ? Color.clear : p.border.color, lineWidth: 1))
    }

    private func chip(_ icon: String, _ label: String, active: Bool, _ p: Palette) -> some View {
        chipLabel(icon, label, active: active, p)
    }

    private func dueChip(_ due: String?, time: String?, _ p: Palette) -> some View {
        let label = due.flatMap { Due.words($0, time: time) } ?? "Due date"
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let nextMonday = cal.nextDate(after: today, matching: DateComponents(weekday: 2), matchingPolicy: .nextTime) ?? today
        return Menu {
            Button("Today") { setDue(SessionModel.dayString(today)) }
            Button("Tomorrow") { setDue(SessionModel.dayString(cal.date(byAdding: .day, value: 1, to: today) ?? today)) }
            Button("Next week") { setDue(SessionModel.dayString(nextMonday)) }
            Button("No date") { dueCleared = true; dueOverride = nil }
        } label: {
            chipLabel("calendar-days", label, active: due != nil, p)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private func setDue(_ day: String) {
        dueCleared = false
        dueOverride = day
    }

    private func priorityChip(_ priority: UInt8, _ p: Palette) -> some View {
        Menu {
            ForEach([UInt8(1), 2, 3, 4], id: \.self) { n in
                Button(n == 4 ? "No priority" : "Priority \(n)") { priorityOverride = n }
            }
        } label: {
            chipLabel("flag", priority < 4 ? "P\(priority)" : "Priority", active: priority < 4, p,
                      color: priority < 4 ? priorityColor(priority, p).color : nil)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    // MARK: Adding

    private func submit(_ q: QuickAddResult, keepOpen: Bool) {
        var title = q.title
        let me = session.shownUser?.id
        var assignee = me
        if let mention = q.assignee {
            if let id = resolveMember(mention: mention, members: session.members, me: me ?? "") {
                assignee = id
            } else {
                title += " @" + mention
            }
        }
        var teamId: String?
        if let t = q.team {
            if let id = resolveTeam(text: t, teams: session.teams) { teamId = id } else { title += " +" + t }
        }
        title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        // The web's convenience: a time with no day is today.
        var due = finalDue(q)
        if due == nil, q.dueTime != nil { due = SessionModel.todayString }
        let fields = SessionModel.NewTaskFields(
            title: title, description: desc.trimmingCharacters(in: .whitespacesAndNewlines), priority: priorityOverride ?? q.priority ?? 4,
            dueDate: due, dueTime: dueCleared ? nil : q.dueTime, recurrence: q.recurrence, assigneeId: assignee, teamId: teamId,
            tagNames: q.tags, pageId: seed.pageId)
        busy = true
        session.addTask(fields) { error in
            busy = false
            if let error {
                shell.say(error)
                return
            }
            shell.say("Task added")
            if keepOpen {
                text = ""
                desc = ""
                dueOverride = nil
                dueCleared = false
                priorityOverride = nil
                focused = true
            } else {
                shell.sheet = nil
            }
        }
    }
}

extension SessionModel {
    /// What a quick-add line (or the Calendar's + on a day) makes.
    struct NewTaskFields {
        var title: String
        var description = ""
        var priority: UInt8 = 4
        var dueDate: String?
        var dueTime: String?
        var recurrence: TaskRecurrence?
        var assigneeId: String?
        var teamId: String?
        var tagNames: [String] = []
        var pageId: String?
    }

    /// Make a task (`Core.createTaskWith`; missing tags are made first with `createTag`). Offline the core keeps it and
    /// sends it later. `done` gets nil, or the message when it was refused.
    func addTask(_ f: NewTaskFields, done: @escaping (String?) -> Void) {
        guard !preview else {
            done("Tasks can’t be added in the preview.")
            return
        }
        guard let ws = workspaceId else {
            done("Pick a workspace first.")
            return
        }
        call({ (core: Core) throws -> CoreTask in
            var tagIds: [String] = []
            for name in f.tagNames { tagIds.append(try core.createTag(workspaceId: ws, name: name, color: nil).id) }
            let input = NewTaskInput(
                id: nil, title: f.title, pageId: f.pageId, parentId: nil, done: false,
                description: f.description.isEmpty ? nil : f.description, priority: f.priority,
                dueDate: f.dueDate, dueTime: f.dueTime, recurrence: f.recurrence, reminderAt: nil,
                assigneeId: f.assigneeId, teamId: f.teamId, tagIds: tagIds.isEmpty ? nil : tagIds)
            return try core.createTaskWith(workspaceId: ws, task: input)
        }) { result in
            switch result {
            case let .success(created):
                self.appendTask(created)
                self.scheduleTaskRefresh()
                done(nil)
            case let .failure(e):
                if e is CancellationError { done("Couldn’t add the task.") } else { done(CoreBridge.message(e)) }
            }
        }
    }
}
