import NotiveloCore
import Observation
import SwiftUI

/// What the iPad shell shows and which menu is open (the web app's AppShell state).
@Observable
final class Shell {
    enum Route: Equatable {
        /// The Notes overview (no page selected).
        case notes
        /// A page: a live page id, or `corpus:<case>` in corpus mode.
        case page(String)
        /// A section with no page open (the empty-section screen).
        case section(String)
        case tasks(TaskList)
    }

    enum TaskList: String, CaseIterable {
        case today, my, upcoming, all, team

        var title: String {
            switch self {
            case .today: return "Today"
            case .my: return "My Tasks"
            case .upcoming: return "Upcoming"
            case .all: return "All tasks"
            case .team: return "Team"
            }
        }

        var icon: String {
            switch self {
            case .today: return "sun"
            case .my: return "inbox"
            case .upcoming: return "calendar-range"
            case .all: return "list-checks"
            case .team: return "users"
            }
        }

        var subtitle: String {
            switch self {
            case .today: return "Due today and overdue, assigned to you."
            case .my: return "Everything assigned to you — from every page."
            case .upcoming: return "What’s coming up over the next two weeks."
            case .all: return "Every task in the workspace. Filter by status, sort and group."
            case .team: return "Who’s working on what across the workspace."
            }
        }
    }

    enum Menu: Equatable {
        case account, workspace, notebookPicker, notebookOptions, pageOptions
        case section(String)
        case pageRow(String)
        case blockType, textColor, highlight, taskSplit, pageColor, ruleLines
    }

    var route: Route
    var sidebarOpen: Bool?
    var ribbonCollapsed = false
    var menu: Menu?
    var toast: String?
    /// Sections open in the tree.
    var expanded: Set<String> = []
    var recentOpen = false
    /// Recently opened pages, newest first (the sidebar's RECENT group).
    var recents: [String] = []
    /// The notebook shown in the sidebar when no page says which.
    var notebookId: String?
    /// Frames of anchors (menu buttons, rows) in the shell's coordinate space.
    @ObservationIgnored var frames: [String: CGRect] = [:]
    @ObservationIgnored private var toastToken = 0

    init() {
        let defaults = UserDefaults.standard
        let preview = defaults.bool(forKey: "previewSignedIn")
        let state = LookData.state ?? ""
        if preview {
            switch state {
            case "tasks-today", "empty-tasks-today": route = .tasks(.today)
            case "tasks-upcoming": route = .tasks(.upcoming)
            case "tasks-my": route = .tasks(.my)
            case "tasks-all", "empty-tasks-all": route = .tasks(.all)
            case "empty-no-page": route = .notes
            case "empty-section": route = .section("empty-section")
            case "edit-caret", "edit-selection", "ribbon-page-active": route = .page(LookData.pageId("sandbox"))
            default:
                if state.hasPrefix("page-") {
                    route = .page(LookData.pageId(String(state.dropFirst("page-".count))))
                } else {
                    route = .page(LookData.pageId(defaults.string(forKey: "page") ?? "canvas-boxes"))
                }
            }
            expanded = ["corpus", "empty-section"]
            if state != "" && !state.hasSuffix("canvas-boxes") && state != "sidebar" { recents = [LookData.pageId("canvas-boxes")] }
            if state == "ribbon-collapsed" { ribbonCollapsed = true }
        } else {
            route = .notes
            if defaults.object(forKey: "sidebarOpen") != nil { sidebarOpen = defaults.bool(forKey: "sidebarOpen") }
            recents = defaults.stringArray(forKey: "recentPages") ?? []
        }
    }

    func open(page id: String) {
        route = .page(id)
        recents.removeAll { $0 == id }
        recents.insert(id, at: 0)
        if recents.count > 5 { recents.removeLast(recents.count - 5) }
        if !UserDefaults.standard.bool(forKey: "previewSignedIn") {
            UserDefaults.standard.set(recents, forKey: "recentPages")
        }
    }

    func toggleSidebar() {
        let open = !(sidebarOpen ?? true)
        sidebarOpen = open
        UserDefaults.standard.set(open, forKey: "sidebarOpen")
    }

    /// A short message at the bottom (the web's toast), for things the native preview can't do yet.
    func say(_ text: String) {
        toastToken += 1
        let token = toastToken
        toast = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) { [weak self] in
            if self?.toastToken == token { self?.toast = nil }
        }
    }

    func notYet(_ what: String) {
        menu = nil
        say("\(what) isn’t in the native preview yet.")
    }
}

/// What the shell reads from the session: the real data, or the look data in corpus mode.
extension SessionModel {
    var shownTree: Tree? { preview ? LookData.tree : tree }
    var shownTasks: [CoreTask] { preview ? LookData.tasks : tasks }
    var shownUser: User? { preview ? LookData.user : user }
    var shownWorkspaces: [Workspace] { preview ? LookData.workspaces : workspaces }
    var shownWorkspace: Workspace? { preview ? LookData.workspaces.first : workspace }

    /// Open tasks written on a page (the sidebar's count chips, the top bar's badge).
    func openTaskCount(page id: String) -> Int {
        shownTasks.filter { $0.pageId == id && !isDone($0) }.count
    }
}

extension View {
    /// Remember this view's frame in the shell's coordinate space (menus open from it).
    func anchor(_ id: String, _ shell: Shell) -> some View {
        background(GeometryReader { g in
            Color.clear
                .onAppear { shell.frames[id] = g.frame(in: .named("shell")) }
                .onChange(of: g.frame(in: .named("shell"))) { _, f in shell.frames[id] = f }
        })
    }
}

/// The signed-in iPad app: ribbon across the top, then rail, sidebar and the main area
/// (LOOK.md 3.1). Below 761 pt wide, the phone shell (`PhoneShell`).
struct AppShell: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.colorScheme) private var scheme
    @State var shell = Shell()
    let theme = Theme.shared

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let chrome = theme.chrome
            Group {
                if width <= 760 {
                    PhoneShell(width: width)
                } else {
                    VStack(spacing: 0) {
                        if shell.ribbonCollapsed {
                            CollapsedRibbon()
                        } else {
                            Ribbon(width: width)
                        }
                        HStack(spacing: 0) {
                            Rail()
                            if shell.sidebarOpen ?? (width >= 900) {
                                Sidebar()
                                    .frame(width: 216)
                                    .overlay(alignment: .trailing) { Rectangle().fill(chrome.border.color).frame(width: 1) }
                            }
                            MainArea(width: width)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            }
            .frame(width: width, height: geo.size.height)
            .background(chrome.bgSidebar.color)
            .overlay { MenuLayer(width: width, height: geo.size.height) }
            .overlay(alignment: .bottom) { ToastView() }
            .coordinateSpace(name: "shell")
        }
        .environment(shell)
        .onAppear {
            theme.systemDark = scheme == .dark
            openLookMenu()
        }
        .onChange(of: scheme) { _, s in theme.systemDark = s == .dark }
        .onChange(of: session.workspaceId) {
            if case .page = shell.route, !session.preview { shell.route = .notes }
        }
    }

    /// Look states that show a menu open (CI screenshots).
    private func openLookMenu() {
        let menus: [String: Shell.Menu] = [
            "menu-account": .account, "menu-workspace": .workspace, "menu-notebook-picker": .notebookPicker,
            "menu-notebook": .notebookOptions, "menu-page-options": .pageOptions,
            "menu-section": .section("corpus"), "menu-page-row": .pageRow(LookData.pageId("canvas-boxes")),
            "ribbon-menu-block": .blockType, "ribbon-menu-text-colour": .textColor, "ribbon-menu-highlight": .highlight,
            "ribbon-menu-task": .taskSplit, "ribbon-menu-page-colour": .pageColor, "ribbon-menu-rule-lines": .ruleLines,
        ]
        guard session.preview, let state = LookData.state, let menu = menus[state] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { shell.menu = menu }
    }
}

/// The route's screen, on the chrome's `--bg`.
struct MainArea: View {
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        Group {
            switch shell.route {
            case let .page(id):
                PageScreen(pageId: id).id(id)
            case let .tasks(list):
                TasksScreen(list: list)
            case .notes:
                NotesHome()
            case let .section(id):
                SectionScreen(sectionId: id)
            }
        }
        .background(theme.chrome.bg.color)
    }
}

/// The web's toast: bottom centre, `--bg-inverse`, radius 12.
struct ToastView: View {
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        if let text = shell.toast {
            let p = theme.chrome
            Text(text)
                .font(.web(13.5))
                .foregroundStyle(p.textInverse.color)
                .padding(.vertical, 10)
                .padding(.leading, 16)
                .padding(.trailing, 16)
                .background(p.bgInverse.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadowLg(p)
                .padding(.bottom, 20)
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }
}
