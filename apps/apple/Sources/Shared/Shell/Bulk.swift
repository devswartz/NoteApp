import NotiveloCore
import Observation
import SwiftUI

// Selecting several tasks (src/pages/tasks/BulkBar.tsx, selection.ts): a long-press on a task row on touch screens (and Cmd- or
// Shift-click on the Mac), a bar at the bottom with Complete, Date, Assign, Priority, Tomorrow and Delete. The server has
// no bulk route (the web loops over single updates), so this does too; the toast has Undo as the web's has.

@Observable
final class BulkSelection {
    var active = false
    var ids: Set<String> = []

    func toggle(_ id: String) {
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
        if ids.isEmpty && !active { active = false }
    }

    func clear() {
        ids = []
        active = false
    }

    /// Drop the ids of tasks that are gone.
    func prune(_ session: SessionModel) {
        let live = Set(session.shownTasks.map(\.id))
        let rest = ids.filter { live.contains($0) }
        if rest != ids { ids = rest }
    }
}

extension TaskRowView {
    /// A click on a row while selecting, or with Cmd or Shift on the Mac: it joins or leaves the selection.
    static func modifierSelects() -> Bool {
        #if os(macOS)
        return NSEvent.modifierFlags.contains(.command) || NSEvent.modifierFlags.contains(.shift)
        #else
        return false
        #endif
    }
}

/// The bar over the bottom of a task list while tasks are selected.
struct BulkBar: View {
    let palette: Palette
    @Environment(\.phoneLayout) private var phone
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var confirmDelete = false

    private var picked: [CoreTask] { session.shownTasks.filter { shell.bulk.ids.contains($0.id) } }

    var body: some View {
        let p = palette
        let list = picked
        let allDone = !list.isEmpty && list.allSatisfy { session.isDone($0) }
        let n = list.count
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Text(n == 0 ? "Select tasks" : "\(n) selected").font(.web(13.5, 600)).foregroundStyle(p.text.color).padding(.horizontal, 8)
                barButton(p, allDone ? "rotate-ccw" : "circle-check", allDone ? "Reopen" : "Complete", enabled: n > 0) { complete(list, !allDone) }
                Menu {
                    Button("Today") { reschedule(list, SessionModel.todayString, "Moved to today") }
                    Button("Tomorrow") { reschedule(list, Self.day(1), "Moved to tomorrow") }
                    Button("Next week") { reschedule(list, Self.day(7), "Moved to next week") }
                    Button("No date") { reschedule(list, nil, "Date removed") }
                } label: { barLabel(p, "calendar-days", "Date") }
                    .disabled(n == 0).opacity(n == 0 ? 0.4 : 1)
                Menu {
                    Button("Me") { assign(list, session.shownUser?.id) }
                    Button("Unassigned") { assign(list, nil) }
                    ForEach(session.shownMembers.filter { $0.id != session.shownUser?.id && $0.role != "viewer" }, id: \.id) { m in
                        Button(m.name) { assign(list, m.id) }
                    }
                } label: { barLabel(p, "user", "Assign") }
                    .disabled(n == 0).opacity(n == 0 ? 0.4 : 1)
                Menu {
                    ForEach([UInt8(1), 2, 3, 4], id: \.self) { v in
                        Button(v == 4 ? "No priority" : "Priority \(v)") { setPriority(list, v) }
                    }
                } label: { barLabel(p, "flag", "Priority") }
                    .disabled(n == 0).opacity(n == 0 ? 0.4 : 1)
                barButton(p, "calendar-clock", "Tomorrow", enabled: n > 0) { reschedule(list, Self.day(1), "Moved to tomorrow") }
                barButton(p, "trash", "Delete", enabled: n > 0, danger: true) { confirmDelete = true }
                barButton(p, "x", "Done", enabled: true) { shell.bulk.clear() }
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 48)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .shadowLg(p)
        .frame(maxWidth: phone ? .infinity : 640)
        .padding(.horizontal, phone ? 10 : 0).padding(.bottom, 12)
        .alert("Delete \(n) task\(n == 1 ? "" : "s")?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { delete(list) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Their subtasks go too. This can’t be undone.")
        }
    }

    private func barLabel(_ p: Palette, _ icon: String, _ title: String, danger: Bool = false) -> some View {
        HStack(spacing: 5) {
            Icon(icon, 15, danger ? p.danger.color : p.text2.color)
            Text(title).font(.web(13, 500)).foregroundStyle(danger ? p.danger.color : p.text2.color)
        }
        .padding(.horizontal, 8).frame(height: 34)
        .contentShape(Rectangle())
    }

    private func barButton(_ p: Palette, _ icon: String, _ title: String, enabled: Bool, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) { barLabel(p, icon, title, danger: danger) }
            .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
            .disabled(!enabled).opacity(enabled ? 1 : 0.4)
    }

    private static func day(_ offset: Int) -> String {
        SessionModel.dayString(Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date())
    }

    // MARK: Actions

    private func finish(_ text: String, _ count: Int, undo: @escaping () -> Void) {
        shell.say("\(text) · \(count) task\(count == 1 ? "" : "s")", undo: undo)
        shell.bulk.clear()
    }

    private func complete(_ list: [CoreTask], _ done: Bool) {
        let was = list.map { ($0, session.isDone($0)) }
        for t in list { session.setDone(t, done) }
        finish(done ? "Completed" : "Reopened", list.count) { for (t, d) in was { session.setDone(t, d) } }
    }

    private func reschedule(_ list: [CoreTask], _ date: String?, _ text: String) {
        let was = list.map { ($0.id, $0.dueDate, $0.dueTime) }
        for t in list { session.update(t.id, TaskChanges(dueDate: date, clearDueDate: date == nil)) { shell.say($0) } }
        finish(text, list.count) {
            for (id, d, time) in was {
                session.update(id, TaskChanges(dueDate: d, clearDueDate: d == nil, dueTime: time, clearDueTime: time == nil)) { shell.say($0) }
            }
        }
    }

    private func assign(_ list: [CoreTask], _ who: String?) {
        let was = list.map { ($0.id, $0.assigneeId) }
        for t in list { session.update(t.id, TaskChanges(assigneeId: who, clearAssignee: who == nil)) { shell.say($0) } }
        finish("Reassigned", list.count) {
            for (id, a) in was { session.update(id, TaskChanges(assigneeId: a, clearAssignee: a == nil)) { shell.say($0) } }
        }
    }

    private func setPriority(_ list: [CoreTask], _ value: UInt8) {
        let was = list.map { ($0.id, $0.priority) }
        for t in list { session.update(t.id, TaskChanges(priority: value)) { shell.say($0) } }
        finish("Priority set", list.count) { for (id, v) in was { session.update(id, TaskChanges(priority: v)) { shell.say($0) } } }
    }

    private func delete(_ list: [CoreTask]) {
        let shell = self.shell
        session.deleteWithUndo(list.map { $0.id }) { text, undo in shell.say(text, undo: undo) }
        shell.bulk.clear()
    }
}

/// The tick box that replaces a row's circle while selecting.
struct SelectBox: View {
    let on: Bool
    let size: CGFloat
    let palette: Palette

    var body: some View {
        let p = palette
        ZStack {
            Circle().stroke(on ? p.accent.color : p.textMuted.color, lineWidth: 1.5)
            if on {
                Circle().fill(p.accent.color)
                Icon("check", size - 8, .white)
            }
        }
        .frame(width: size, height: size)
    }
}
