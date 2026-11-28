import SwiftUI

// The commands of the search palette (src/components/shell/commands.tsx, listed under "Actions" in CommandPalette.tsx):
// Keyboard shortcuts, Toggle sidebar, Switch theme, New task, New notebook, New page, Go to … and Settings. With nothing
// typed they are listed after the recent pages; with a query, the ones whose title, group or keywords have every word.

struct PaletteCommand {
    let id: String
    let icon: String
    let title: String
    let group: String
    /// The shortcut shown at the right (the group when there is none).
    var keys: String?
    var keywords = ""
    var needsEdit = false

    var sub: String { keys ?? group }
    var match: String { "\(title) \(group) \(keywords)".lowercased() }
}

enum PaletteCommands {
    static let all: [PaletteCommand] = [
        PaletteCommand(id: "app.shortcuts", icon: "keyboard", title: "Keyboard shortcuts", group: "General", keys: "?"),
        PaletteCommand(id: "app.sidebar", icon: "panel-left", title: "Toggle sidebar", group: "General", keys: "⌘\\"),
        PaletteCommand(id: "app.theme", icon: "sun-moon", title: "Switch theme (light / dark / hybrid / system)", group: "General", keywords: "dark mode appearance"),
        PaletteCommand(id: "tasks.new", icon: "plus", title: "New task", group: "Create", keys: "Q", keywords: "add todo quick", needsEdit: true),
        PaletteCommand(id: "notebooks.new", icon: "book-plus", title: "New notebook…", group: "Create", keywords: "template project personal meetings", needsEdit: true),
        PaletteCommand(id: "pages.new", icon: "file-plus", title: "New page", group: "Create", keys: "N", keywords: "page note canvas", needsEdit: true),
        PaletteCommand(id: "nav.today", icon: "sun", title: "Go to Today", group: "Navigation", keys: "G T"),
        PaletteCommand(id: "nav.my", icon: "inbox", title: "Go to My Tasks", group: "Navigation", keys: "G M"),
        PaletteCommand(id: "nav.upcoming", icon: "calendar-range", title: "Go to Upcoming", group: "Navigation", keys: "G U"),
        PaletteCommand(id: "nav.team", icon: "users", title: "Go to Team", group: "Navigation", keys: "G E"),
        PaletteCommand(id: "nav.all", icon: "list-checks", title: "Go to All tasks", group: "Navigation", keys: "G A"),
        PaletteCommand(id: "nav.calendar", icon: "calendar-days", title: "Go to Calendar", group: "Navigation", keys: "G C"),
        PaletteCommand(id: "nav.notes", icon: "notebook-text", title: "Go to Notes", group: "Navigation", keys: "G N"),
        PaletteCommand(id: "nav.settings", icon: "settings", title: "Go to Settings", group: "Navigation", keys: "G S"),
        PaletteCommand(id: "nav.workspaceSettings", icon: "settings", title: "Go to Workspace settings", group: "Navigation", keywords: "members teams tags general invite"),
    ]

    /// The commands that apply here (creating needs a role that can edit).
    static func available(_ session: SessionModel) -> [PaletteCommand] {
        let canEdit = session.preview || session.workspace?.role != "viewer"
        return all.filter { !$0.needsEdit || canEdit }
    }

    static func matching(_ query: String, session: SessionModel) -> [PaletteCommand] {
        let words = query.lowercased().split(whereSeparator: { $0 == " " }).map(String.init)
        let list = available(session)
        if words.isEmpty { return list }
        return list.filter { c in words.allSatisfy { c.match.contains($0) } }
    }

    static func run(_ id: String, _ shell: Shell, _ session: SessionModel) {
        shell.closeSearch()
        let bridge = ShellBridge.shared
        switch id {
        case "app.shortcuts": shell.openSettings("shortcuts")
        case "app.sidebar": shell.toggleSidebar()
        case "app.theme":
            let modes = ThemeMode.allCases
            let theme = Theme.shared
            theme.mode = modes[((modes.firstIndex(of: theme.mode) ?? 0) + 1) % modes.count]
        case "tasks.new": shell.openQuickAdd(session)
        case "notebooks.new": shell.newNotebook(session)
        case "pages.new": bridge.newPage()
        case "nav.today": shell.route = .tasks(.today)
        case "nav.my": shell.route = .tasks(.my)
        case "nav.upcoming": shell.route = .tasks(.upcoming)
        case "nav.team": shell.route = .tasks(.team)
        case "nav.all": shell.route = .tasks(.all)
        case "nav.calendar": shell.route = .calendar
        case "nav.notes": shell.route = .notes
        case "nav.settings": shell.openSettings()
        case "nav.workspaceSettings": shell.openSettings("workspace", workspace: true)
        default: break
        }
    }
}
