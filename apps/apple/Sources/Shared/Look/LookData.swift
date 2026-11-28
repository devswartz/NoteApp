import Foundation
import NotiveloCore

/// Corpus mode (`-previewSignedIn YES`, no network) stands in for the web app's look-reference data
/// (docs/rewrite/look/seed.ts): workspace "Demo Team", notebook "Look reference" with the corpus
/// pages in section "Corpus" and an "Empty section", the demo user, and demo tasks, so the CI
/// screenshots show the same states as `docs/rewrite/look/reference/`.
///
/// Launch arguments (CI, `apple-native.yml` "Look" step):
/// - `-lookState <state>`: which state to open (see `LookState`).
/// - `-theme light|dark|hybrid|system`: the theme (also the stored preference).
/// - `-lookLandscape YES`: draw the app 1180×820 turned a quarter (the simulator can't rotate;
///   CI turns the screenshot back).
enum LookData {
    static var state: String? { UserDefaults.standard.string(forKey: "lookState") }
    static var landscape: Bool { UserDefaults.standard.bool(forKey: "lookLandscape") }

    static let user = User(id: "demo", email: "demo@example.com", name: "Demo User", color: "#f59e0b", emailVerified: true)
    /// Settings > Notifications and Connected apps in corpus mode (`settings-notifications`, `settings-connected`).
    static let notificationSettings = NotificationSettings(timeZone: "Europe/London", emailEnabled: true, defaultReminderTime: "09:00",
                                                           digestEnabled: true, digestTime: "07:30")
    static var connectedApps: [ConnectedApp] {
        [
            ConnectedApp(clientId: "chatgpt", name: "ChatGPT", clientUri: "https://chatgpt.com", scopes: ["notes:read", "notes:write"],
                         connectedAt: iso(minutesAgo: 60 * 24 * 12), lastUsedAt: iso(minutesAgo: 90)),
            ConnectedApp(clientId: "claude", name: "Claude", clientUri: "https://claude.ai", scopes: ["notes:read"],
                         connectedAt: iso(minutesAgo: 60 * 24 * 3), lastUsedAt: nil),
        ]
    }

    /// The team shown on a demo task row (the web demo's "Staff" team on the overdue task).
    static let rowTeams: [String: TaskTeam] = [
        "t-review": TaskTeam(id: "team-staff", name: "Staff", color: "#0ea5e9", parentId: nil, memberIds: ["demo"]),
    ]

    /// The other people of the demo workspace (inbox actors, presence): id → name and colour.
    static let people: [String: (name: String, color: String)] = [
        "ana": ("Ana Silva", "#ec4899"), "ben": ("Ben Okafor", "#0ea5e9"), "chen": ("Chen Wei", "#10b981"),
    ]

    /// Static look data (`-lookState presence`): the demo people on the page.
    static let presence: [PagePerson] = [
        PagePerson(id: "ana", name: "Ana Silva", color: "#ec4899", canEdit: true, sessions: 1),
        PagePerson(id: "ben", name: "Ben Okafor", color: "#0ea5e9", canEdit: true, sessions: 2),
        PagePerson(id: "chen", name: "Chen Wei", color: "#10b981", canEdit: false, sessions: 1),
    ]

    static let workspaces = [
        Workspace(id: "demos-space", name: "Demo's Space", role: "owner", createdAt: "2026-11-21T00:00:00Z"),
        Workspace(id: "demo-team", name: "Demo Team", role: "owner", createdAt: "2026-11-21T00:00:00Z"),
        Workspace(id: "empty-space", name: "Empty Space", role: "owner", createdAt: "2026-11-21T00:00:00Z"),
    ]

    /// The workspace shown: Demo Team, or Empty Space in the empty-workspace states.
    static var workspace: Workspace {
        workspaces.first { $0.id == (state?.hasPrefix("empty-workspace") == true || state?.hasPrefix("empty-tasks") == true ? "empty-space" : "demo-team") } ?? workspaces[0]
    }

    /// The look seed's page order and titles (seed.ts ORDER); "sandbox" is a copy of canvas-boxes.
    static let pages: [(caseName: String, title: String)] = [
        ("canvas-boxes", "Canvas"), ("sandbox", "Sandbox"), ("blocks", "Blocks"), ("lists", "Lists"), ("tasks", "Tasks"),
        ("settings-and-ink", "Settings and ink"), ("document-page", "Document page"), ("geometry-defaults", "Geometry"),
        ("converted", "Converted"),
    ]

    static func pageId(_ caseName: String) -> String { "corpus:\(caseName)" }
    /// The bundled corpus case a corpus page id opens ("sandbox" shows canvas-boxes).
    static func caseName(_ pageId: String) -> String? {
        guard pageId.hasPrefix("corpus:") else { return nil }
        let name = String(pageId.dropFirst("corpus:".count))
        return name == "sandbox" ? "canvas-boxes" : name
    }

    static func iso(minutesAgo: Double) -> String {
        ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }

    static var tree: Tree {
        if state?.hasPrefix("empty-workspace") == true { return Tree(notebooks: [], sections: [], pages: []) }
        let notebook = Notebook(id: "look", name: "Look reference", color: "#ec4899", visibility: "shared", position: 1)
        if state == "empty-notebook" { return Tree(notebooks: [notebook], sections: [], pages: []) }
        let sections = [
            CoreSection(id: "corpus", notebookId: "look", parentId: nil, name: "Corpus", color: "#ec4899", position: 1),
            CoreSection(id: "empty-section", notebookId: "look", parentId: nil, name: "Empty section", color: "#14b8a6", position: 2),
        ]
        let metas = pages.enumerated().map { i, p in
            PageMeta(id: pageId(p.caseName), sectionId: "corpus", title: p.title, icon: nil, position: Double(i + 1),
                     updatedAt: iso(minutesAgo: p.caseName == "sandbox" ? 1 : 12), locked: false)
        }
        let others = [
            Notebook(id: "team", name: "Team Notebook", color: "#6366f1", visibility: "shared", position: 0),
            Notebook(id: "product", name: "Product", color: "#6366f1", visibility: "shared", position: 2),
            Notebook(id: "engineering", name: "Engineering", color: "#10b981", visibility: "shared", position: 3),
            Notebook(id: "marketing", name: "Marketing", color: "#f59e0b", visibility: "shared", position: 4),
            Notebook(id: "personal", name: "Personal (private)", color: "#8b5cf6", visibility: "private", position: 5),
        ]
        return Tree(notebooks: [notebook] + others, sections: sections, pages: metas)
    }

    /// Pages the demo tasks are written on that aren't in the tree (shown by title only).
    static let otherPageTitles = ["welcome": "Welcome 👋", "weekly-sync": "Weekly sync · Saturday 21 November"]

    static func day(_ offset: Int) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date())
    }

    private static func task(_ id: String, _ title: String, due: Int? = nil, priority: UInt8 = 4, page: String? = nil,
                             mine: Bool = true, done: Bool = false) -> CoreTask {
        CoreTask(id: id, workspaceId: "demo-team", title: title, description: "", done: done, priority: priority,
                 dueDate: due.map(day), dueTime: nil, assigneeId: mine ? "demo" : nil, pageId: page, parentId: nil,
                 tagIds: [], checklistDone: nil, checklistTotal: nil, completedAt: done ? iso(minutesAgo: 30) : nil,
                 createdAt: iso(minutesAgo: 10), updatedAt: iso(minutesAgo: 30), locked: false)
    }

    /// The demo seed's tasks as the Tasks views show them: 3 for Today (1 overdue), 7 in the next
    /// two weeks, 15 assigned to the demo user, 1 done today, plus the corpus pages' task lines.
    static var tasks: [CoreTask] {
        guard state != "empty-tasks-today", state != "empty-tasks-all" else { return [] }
        var list = [
            task("t-review", "Review the launch checklist", due: -1, priority: 1),
            task("t-try", "Try checking off this task — it also completes on the Tasks dashboard", due: 0, priority: 2, page: "welcome"),
            task("t-notes", "Send the meeting notes to the team", due: 0, priority: 2, page: "weekly-sync"),
            task("t-done", "Book the venue", due: 0, done: true),
        ]
        let upcoming = ["Draft the Q4 roadmap", "Prepare the demo", "Plan the offsite", "Write the release notes",
                        "Interview candidates", "Update the onboarding guide", "Review the budget"]
        for (i, t) in upcoming.enumerated() { list.append(task("t-up\(i)", t, due: 1 + i * 2, priority: i == 0 ? 3 : 4)) }
        let later = ["Clean up old pages", "Try the mobile app", "Invite a teammate", "Set up a template", "Read the guide"]
        for (i, t) in later.enumerated() { list.append(task("t-later\(i)", t)) }
        list.append(task("tb", "Task in box b", page: pageId("canvas-boxes"), mine: false))
        list.append(task("tb2", "Task in box b", page: pageId("sandbox"), mine: false))
        list.append(task("t1", "Write the plan", due: 9, page: pageId("tasks"), mine: false))
        list.append(task("t3", "Subtask", page: pageId("tasks"), mine: false))
        return list
    }
}
