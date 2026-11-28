import NotiveloCore

// Undo for deleted tasks (src/store/tasks.ts deleteTasksWithUndo): the server has no restore route, so the web keeps
// copies of the tasks and their subtasks and makes them again with the same ids. This does the same through
// `Core.createTaskWith` (its `id`), parents before subtasks.

extension SessionModel {
    /// Copies of the tasks (with every field the stored full copy has) and their subtasks, parents first.
    func taskCopies(_ ids: [String]) -> [NewTaskInput] {
        var out: [NewTaskInput] = []
        func copy(_ t: CoreTask) {
            guard !out.contains(where: { $0.id == t.id }) else { return }
            if let d = details[t.id] {
                out.append(NewTaskInput(
                    id: d.id, title: d.title, pageId: d.pageId, parentId: d.parentId, done: d.done,
                    description: d.description.isEmpty ? nil : d.description, priority: d.priority,
                    dueDate: d.dueDate, dueTime: d.dueTime, recurrence: d.recurrence, reminderAt: d.reminderAt,
                    assigneeId: d.assigneeId, teamId: d.teamId, tagIds: d.tagIds.isEmpty ? nil : d.tagIds))
            } else {
                out.append(NewTaskInput(
                    id: t.id, title: t.title, pageId: t.pageId, parentId: t.parentId, done: t.done,
                    description: t.description.isEmpty ? nil : t.description, priority: t.priority,
                    dueDate: t.dueDate, dueTime: t.dueTime, recurrence: nil, reminderAt: nil,
                    assigneeId: t.assigneeId, teamId: nil, tagIds: t.tagIds.isEmpty ? nil : t.tagIds))
            }
        }
        // Parents before their subtasks, so a restore never makes a subtask before its parent.
        let ordered = ids.sorted { a, b in
            let pa = tasks.first(where: { $0.id == a })?.parentId, pb = tasks.first(where: { $0.id == b })?.parentId
            return (pa == nil ? 0 : 1) < (pb == nil ? 0 : 1)
        }
        for id in ordered {
            guard let t = tasks.first(where: { $0.id == id }) else { continue }
            copy(t)
            for c in tasks where c.parentId == id { copy(c) }
        }
        return out
    }

    /// Delete the tasks and say so with Undo, which makes them again.
    func deleteWithUndo(_ ids: [String], say: @escaping (String, @escaping () -> Void) -> Void) {
        let copies = taskCopies(ids)
        guard !copies.isEmpty else { return }
        for id in ids { delete(taskId: id) }
        let n = ids.count
        let ws = workspaceId, who = user?.id
        say("\(n == 1 ? "Task" : "\(n) tasks") deleted") { [weak self] in
            // Not into another workspace or account if either changed in the meantime.
            guard let self, self.workspaceId == ws, self.user?.id == who else { return }
            self.restore(copies)
        }
    }

    /// Make deleted tasks again (same ids and fields).
    func restore(_ copies: [NewTaskInput]) {
        guard let ws = workspaceId else { return }
        call({ core in for c in copies { _ = try core.createTaskWith(workspaceId: ws, task: c) } }) { _ in
            self.refreshTasks()
        }
    }
}
