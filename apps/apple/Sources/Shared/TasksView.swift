import NotiveloCore
import SwiftUI

/// The workspace's tasks (`Core.tasks`): open first, then completed. Tap the circle to tick:
/// it shows at once, goes to the server, and the list is fetched again.
struct TasksView: View {
    @Environment(SessionModel.self) private var session
    @State private var showCompleted = false

    var body: some View {
        let open = Self.ordered(session.tasks.filter { !session.isDone($0) })
        let done = Self.ordered(session.tasks.filter { session.isDone($0) })
        List {
            if session.preview {
                Text("Sign in to see your tasks.").foregroundStyle(.secondary)
            }
            ForEach(open) { task in
                TaskRow(task: task)
            }
            if !done.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup("Completed (\(done.count))", isExpanded: $showCompleted) {
                        ForEach(done) { task in
                            TaskRow(task: task)
                        }
                    }
                }
            }
            if let error = session.loadError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
        .overlay {
            if !session.preview, session.tasks.isEmpty, !session.loading {
                ContentUnavailableView("No tasks", systemImage: "checklist")
            }
        }
        .refreshable { await session.refresh() }
        .navigationTitle("Tasks")
        .onAppear { session.refreshTasks() }
    }

    /// Top-level tasks by due date (none last), priority and title, each followed by its subtasks.
    static func ordered(_ list: [CoreTask]) -> [CoreTask] {
        let ids = Set(list.map(\.id))
        func isChild(_ t: CoreTask) -> Bool { t.parentId.map { ids.contains($0) } ?? false }
        let order: (CoreTask, CoreTask) -> Bool = { a, b in
            switch (a.dueDate, b.dueDate) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (a.priority, a.title) < (b.priority, b.title)
            }
        }
        var children: [String: [CoreTask]] = [:]
        for t in list where isChild(t) { children[t.parentId ?? "", default: []].append(t) }
        return list.filter { !isChild($0) }.sorted(by: order).flatMap { root in
            [root] + (children[root.id] ?? []).sorted(by: order)
        }
    }
}

struct TaskRow: View {
    @Environment(SessionModel.self) private var session
    let task: CoreTask

    var body: some View {
        let done = session.isDone(task)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Button {
                session.setDone(task, !done)
            } label: {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(done ? Color.secondary : Color.accentColor)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(task.locked)
            .accessibilityLabel(done ? "Mark as not done" : "Mark as done")

            VStack(alignment: .leading, spacing: 2) {
                Text(task.locked ? "Locked task" : task.title)
                    .strikethrough(done)
                    .foregroundStyle(done ? .secondary : .primary)
                HStack(spacing: 8) {
                    if let due = Self.dueText(task) {
                        Text(due).foregroundStyle(Self.isOverdue(task) && !done ? Color.red : Color.secondary)
                    }
                    if let total = task.checklistTotal, total > 0 {
                        Label("\(task.checklistDone ?? 0)/\(total)", systemImage: "checklist").foregroundStyle(.secondary)
                    }
                    if task.priority < 4 {
                        Label("P\(task.priority)", systemImage: "flag").foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }
        }
        .padding(.leading, task.parentId == nil ? 0 : 28)
    }

    private static let dayFormat: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func dueText(_ task: CoreTask) -> String? {
        guard let due = task.dueDate else { return nil }
        guard let date = dayFormat.date(from: due) else { return due }
        var text = date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        if let time = task.dueTime { text += " \(time)" }
        return text
    }

    static func isOverdue(_ task: CoreTask) -> Bool {
        guard let due = task.dueDate, let date = dayFormat.date(from: due) else { return false }
        return date < Calendar.current.startOfDay(for: Date())
    }
}
