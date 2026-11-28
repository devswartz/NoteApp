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
        /// The Calendar: month or week, tasks by due date.
        case calendar
        /// Settings (personal): Profile, Appearance, Security, About.
        case settings
    }

    /// Whose tasks the Calendar shows (the ribbon's Mine / Everyone).
    enum CalendarWho: Equatable { case mine, everyone, unassigned, person(String) }

    /// The Calendar's Status select: open tasks (the default), completed ones, or all.
    enum CalendarStatus: String, CaseIterable {
        case open, done, any
        var label: String { self == .open ? "Open" : (self == .done ? "Completed" : "All") }
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
        case inbox
        /// "On this page now" (the page bar's avatars).
        case presence
        case account, workspace, notebookPicker, notebookOptions, pageOptions
        case section(String)
        case pageRow(String)
        /// The emoji picker of a page's icon (the row above its title).
        case pageIcon(String)
        case blockType, textColor, highlight, taskSplit, pageColor, ruleLines, tableMenu
        /// The Calendar ribbon's Tags and person filters.
        case calTags, calPeople
        /// The Tasks ribbon's menus (and the phone's filter sheets): group, sort, and the filter kinds.
        case taskGroup, taskSort, taskKinds, taskStatus, taskAssignee, taskTags, taskTeam, taskPriority, taskMore
        /// The Tasks ribbon's saved views list (and the phone's view options).
        case savedViews
    }

    var route: Route
    /// The notification inbox behind the bell.
    let inbox = InboxModel()
    var sidebarOpen: Bool?
    var ribbonCollapsed = false
    var menu: Menu?
    var toast: String?
    /// The toast's action ("Undo") and what it does.
    var toastAction: (label: String, run: () -> Void)?
    /// The open tree dialog (new section, move, delete notebook …), see `TreeActions.swift`.
    var dialog: TreeDialog?
    /// The open sharing, version history, Trash or lock dialog (`Sheets.swift`).
    var sheet: ShellSheet?
    /// What is typed in "Send feedback": kept when it is closed or the send fails.
    var feedbackDraft = ""
    /// The live page on screen (version history restores into it).
    @ObservationIgnored weak var openLive: LivePageModel?
    /// The tree row being renamed in place: `page:<id>`, `section:<id>` or `notebook:<id>`.
    var renaming: String?
    /// A row being dragged in the tree (the iPad), see `TreeDrop.swift`.
    var treeDrag: TreeDragState?
    /// The search palette (Cmd+K, the rail's and the phone's search buttons) and what is typed in it.
    var searchOpen = false
    var searchQuery = ""
    /// The task whose detail sheet is open.
    var taskDetailId: String?
    /// The Calendar: the day it is on (YYYY-MM-DD), month or week, whose tasks.
    var calCursor = SessionModel.todayString
    var calMonth = true
    var calWho: CalendarWho = .mine
    /// Status, tag and person choices are kept for the workspace while the app runs, as the web keeps them (its task view
    /// state and the calendar's URL); another workspace starts clean.
    var calStatus: CalendarStatus = .open
    var calTags: Set<String> = []
    /// The task views' filters, sort and group (kept while the app runs; another workspace starts clean).
    let tv = TaskViewState()
    /// The workspace's saved task views (`SavedViews.swift`).
    let views = SavedViewsModel()
    /// The tasks selected for a bulk action (`Bulk.swift`).
    let bulk = BulkSelection()
    /// Settings: the open section (nil: the list on phones, Profile on wide screens).
    var settingsSection: String?
    /// Settings shows the workspace's sections (General, Teams, Tags, Activity) instead of the person's.
    var settingsWorkspace = false
    /// The page panel shows the page's tasks instead of its comments.
    var pageTasksTab = false
    /// Where Settings' Back goes.
    var routeBeforeSettings: Route = .notes
    /// Sections open in the tree.
    var expanded: Set<String> = []
    var recentOpen = false
    /// Favourite pages, kept on this device ("<account>|<workspace>" → page ids), and whether their sidebar group is open.
    var favourites: [String: [String]] = [:]
    var favouritesOpen = true
    /// The page outline beside long pages is hidden (the ribbon's Outline button), kept on this device.
    var outlineHidden = UserDefaults.standard.bool(forKey: "outlineHidden") {
        didSet { UserDefaults.standard.set(outlineHidden, forKey: "outlineHidden") }
    }
    /// The page canvas's zoom (View ▸ Zoom In / Out / Actual Size on the Mac).
    var zoom = 1.0
    /// Phone: the notes drawer is open.
    var drawerOpen = false
    /// Phone: the notebook whose sections are listed (Notes → notebook → section → page); nil: all notebooks.
    var phoneNotebook: String?
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
            case "tasks-today", "empty-tasks-today", "quick-add": route = .tasks(.today)
            case "tasks-calendar", "ribbon-calendar": route = .calendar
            case "settings", "ribbon-settings": route = .settings
            case "page-tasks-panel": route = .page(LookData.pageId("tasks"))
            case "tasks-upcoming": route = .tasks(.upcoming)
            case "tasks-my": route = .tasks(.my)
            case "tasks-all", "empty-tasks-all", "saved-views": route = .tasks(.all)
            case "bulk-select": route = .tasks(.my)
            case "empty-no-page", "notes-home", "empty-workspace-notes": route = .notes
            case "empty-section": route = .section("empty-section")
            case "templates": route = .page(LookData.pageId("empty"))
            case "outline": route = .page(LookData.pageId("blocks"))
            case "backlinks": route = .page(LookData.pageId("canvas-boxes"))
            case "empty-notebook": route = .notes
            case "page-not-found": route = .page(LookData.pageId("not-found"))
            case "edit-caret", "edit-selection", "edit-new-box", "edit-link", "ribbon-page-active", "slash-menu", "table-tools", "cursors": route = .page(LookData.pageId("sandbox"))
            default:
                if state.hasPrefix("page-") {
                    route = .page(LookData.pageId(String(state.dropFirst("page-".count))))
                } else {
                    route = .page(LookData.pageId(defaults.string(forKey: "page") ?? "canvas-boxes"))
                }
            }
            expanded = ["corpus", "empty-section"]
            notebookId = "look"
            if state != "" && !state.hasSuffix("canvas-boxes") && state != "sidebar" { recents = [LookData.pageId("canvas-boxes")] }
            if state == "ribbon-collapsed" { ribbonCollapsed = true }
            if state == "page-tasks-panel" { pageTasksTab = true; CommentsModel.shared.open = true }
            if state == "search" { searchOpen = true; searchQuery = "plan" }
            if state == "workspace-settings" { route = .settings; settingsSection = "workspace"; settingsWorkspace = true }
            if state == "teams-settings" { route = .settings; settingsSection = "teams"; settingsWorkspace = true }
            if state == "delete-account" { route = .settings; settingsSection = "profile" }
            if state.hasPrefix("settings-") { route = .settings; settingsSection = String(state.dropFirst("settings-".count)) }
            if state == "task-detail" { route = .tasks(.my); taskDetailId = "t-review" }
        } else {
            route = .notes
            if defaults.object(forKey: "sidebarOpen") != nil { sidebarOpen = defaults.bool(forKey: "sidebarOpen") }
            recents = defaults.stringArray(forKey: "recentPages") ?? []
            favourites = (defaults.dictionary(forKey: "favouritePages") as? [String: [String]]) ?? [:]
        }
    }

    func open(page id: String) {
        route = .page(id)
        drawerOpen = false
        recents.removeAll { $0 == id }
        recents.insert(id, at: 0)
        if recents.count > 5 { recents.removeLast(recents.count - 5) }
        if !UserDefaults.standard.bool(forKey: "previewSignedIn") {
            UserDefaults.standard.set(recents, forKey: "recentPages")
        }
    }

    /// Phone look states that start with the drawer open, and the screen behind it (the references).
    func configurePhoneLook() {
        guard UserDefaults.standard.bool(forKey: "previewSignedIn"), let state = LookData.state else { return }
        switch state {
        case "sidebar-drawer", "empty-workspace-drawer", "empty-notebook", "loading-sidebar", "inline-rename":
            drawerOpen = true
            route = .notes
        case "menu-workspace", "menu-account", "menu-notebook", "menu-notebook-picker", "menu-section", "menu-page-row":
            drawerOpen = true
            route = .section("corpus")
        case "empty-workspace-notes":
            route = .notes
        case "search":
            route = .section("corpus")
        default: break
        }
    }

    func openSearch() {
        menu = nil
        taskDetailId = nil
        searchQuery = ""
        searchOpen = true
    }

    func closeSearch() { searchOpen = false }

    /// Something is open over the page (Esc on the Mac closes it).
    var hasOverlay: Bool { dialog != nil || sheet != nil || menu != nil || taskDetailId != nil || searchOpen }

    func dismissTop() {
        if dialog != nil {
            dialog = nil
        } else if sheet != nil {
            sheet = nil
        } else if menu != nil {
            menu = nil
        } else if taskDetailId != nil {
            taskDetailId = nil
        } else if searchOpen {
            closeSearch()
        }
    }

    func openTask(_ id: String) {
        menu = nil
        searchOpen = false
        taskDetailId = id
    }

    func toggleSidebar() {
        let open = !(sidebarOpen ?? true)
        sidebarOpen = open
        UserDefaults.standard.set(open, forKey: "sidebarOpen")
    }

    /// A short message at the bottom (the web's toast), for things the native preview can't do yet.
    func say(_ text: String, undo: (() -> Void)? = nil) {
        toastToken += 1
        let token = toastToken
        toast = text
        toastAction = undo.map { (label: "Undo", run: $0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + (undo == nil ? 2.6 : 6)) { [weak self] in
            if self?.toastToken == token { self?.toast = nil; self?.toastAction = nil }
        }
    }

    /// Open one of the sheets (sharing, history, Trash, lock). The corpus preview has no server: it says so.
    func openSheet(_ sheet: ShellSheet, _ session: SessionModel, _ what: String) {
        menu = nil
        if session.preview { notYet(what) } else { self.sheet = sheet }
    }

    /// Quick add (the web's Q): the dialog, with the page the task goes on and a day to start from. Viewers can't add.
    func openQuickAdd(_ session: SessionModel, pageId: String? = nil, due: String? = nil, text: String = "") {
        menu = nil
        searchOpen = false
        taskDetailId = nil
        if !session.preview && session.workspace?.role == "viewer" {
            say("You can only view this workspace.")
            return
        }
        sheet = .quickAdd(QuickAddSeed(pageId: pageId, dueDate: due, text: text))
    }

    func openSettings(_ section: String? = nil, workspace: Bool = false) {
        settingsWorkspace = workspace
        menu = nil
        searchOpen = false
        taskDetailId = nil
        if route != .settings { routeBeforeSettings = route }
        settingsSection = section
        route = .settings
        drawerOpen = false
    }

    func notYet(_ what: String) {
        menu = nil
        say("\(what) isn’t in the native preview yet.")
    }
}

/// What the shell reads from the session: the real data, or the look data in corpus mode.
extension SessionModel {
    var shownTree: Tree? { preview ? (LookData.state == "loading-sidebar" ? nil : LookData.tree) : tree }
    var shownTasks: [CoreTask] { preview ? LookData.tasks : tasks }
    var shownUser: User? { preview ? LookData.user : user }
    var shownWorkspaces: [Workspace] { preview ? LookData.workspaces : workspaces }
    var shownWorkspace: Workspace? { preview ? LookData.workspace : workspace }

    /// Open tasks written on a page (the sidebar's count chips, the top bar's badge).
    func openTaskCount(page id: String) -> Int {
        shownTasks.filter { $0.pageId == id && !isDone($0) }.count
    }
}

private struct PhoneLayoutKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The phone shell (≤ 760 pt wide): stacked boxes, no Hybrid inset, the phone's page bar.
    var phoneLayout: Bool {
        get { self[PhoneLayoutKey.self] }
        set { self[PhoneLayoutKey.self] = newValue }
    }
}

extension View {
    /// iOS 26 fades a scroll view's edges at the screen edge; the web has no such effect.
    @ViewBuilder func noEdgeEffect() -> some View {
        #if compiler(>=6.2) && os(iOS)
        if #available(iOS 26.0, *) { scrollEdgeEffectHidden(true, for: .all) } else { self }
        #else
        self
        #endif
    }

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
    @Environment(\.scenePhase) private var scenePhase
    @State var shell = Shell()
    let theme = Theme.shared

    /// My open tasks due today or overdue (the Today list): the app icon's badge.
    private var dueToday: Int { TaskBuckets(tasks: session.tasks, session: session).list(.today).count }

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let chrome = theme.chrome
            Group {
                #if os(iOS)
                if width <= 760 {
                    PhoneShell(width: width)
                } else {
                    desktop(width: width, chrome: chrome)
                }
                #else
                desktop(width: width, chrome: chrome)
                #endif
            }
            .frame(width: width, height: geo.size.height)
            .background(chrome.bgSidebar.color)
            .overlay { MenuLayer(width: width, height: geo.size.height).environment(\.phoneLayout, width <= 760) }
            .overlay { SearchLayer(width: width, height: geo.size.height).environment(\.phoneLayout, width <= 760) }
            .overlay { TaskDetailLayer(width: width, height: geo.size.height).environment(\.phoneLayout, width <= 760) }
            .overlay { DialogLayer(width: width, height: geo.size.height).environment(\.phoneLayout, width <= 760) }
            .overlay(alignment: .bottom) { OfflineBanner().environment(\.phoneLayout, width <= 760) }
            #if os(iOS)
            .background { Button("") { shell.openSearch() }.keyboardShortcut("k", modifiers: .command).opacity(0).accessibilityHidden(true) }
            #else
            // The Mac's main menu has the shortcuts (MacCommands); these two are the web's own.
            .background {
                Button("") { shell.toggleSidebar() }.keyboardShortcut("\\", modifiers: .command).opacity(0).accessibilityHidden(true)
                // Esc closes what is open on top (a dialog, a menu, the task sheet, the search), as the web does.
                if shell.hasOverlay {
                    Button("") { shell.dismissTop() }.keyboardShortcut(.cancelAction).opacity(0).accessibilityHidden(true)
                }
            }
            #endif
            .overlay(alignment: .bottom) { ToastView() }
            .modifier(ShellKeys(shell: shell))
            .coordinateSpace(name: "shell")
        }
        .environment(shell)
        .background(GeometryReader { g in
            Color.clear.onAppear { if shell.sidebarOpen == nil { shell.sidebarOpen = g.size.width >= 900 } }
        })
        .onAppear {
            EditorFocus.shared.onTableMenu = { [weak shell] in shell?.menu = .tableMenu }
            theme.systemDark = scheme == .dark
            ShellBridge.shared.attach(shell, session)
            if mainScreenSize.width <= 760 { shell.configurePhoneLook() }
            openLookMenu()
            if case .tasks = shell.route { shell.views.load(session) }
            if session.preview {
                if LookData.state == "inbox" { shell.inbox.seedLook() }
            } else {
                shell.inbox.refresh(session, list: false)
                AppBadge.askOnce()
                session.registerPush()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .pushTokenChanged)) { _ in session.registerPush() }
        .onChange(of: scheme) { _, s in theme.systemDark = s == .dark }
        // The bell's count: when the app comes to the front, when the inbox opens, and every 60 s while it is in front.
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { _ in
            if scenePhase == .active { shell.inbox.refresh(session, list: shell.menu == .inbox) }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !session.preview else { return }
            shell.inbox.refresh(session, list: shell.menu == .inbox)
            AppBadge.set(dueToday)
        }
        #if os(iOS)
        // The Today widget's snapshot follows the task list; shares from the Share Extension are taken once the app is in front
        // and the workspace is loaded (Sources/iOS/Extras.swift).
        .modifier(IOSExtras(shell: shell, session: session))
        .modifier(AppLockOverlay())
        #endif
        .onChange(of: session.user?.id) { _, _ in
            shell.inbox.reset()
            shell.inbox.refresh(session, list: false)
        }
        // The app icon's badge follows the tasks due today or overdue.
        .onChange(of: dueToday, initial: true) { _, n in
            if !session.preview { AppBadge.set(n) }
        }
        .onDisappear { if !session.preview { AppBadge.set(0) } }
        // A link into the app (notivelo://…, or the web address of a page): to its workspace, then the page or list.
        .onChange(of: session.pendingLink, initial: true) { _, link in
            guard let link, session.phase == .signedIn else { return }
            if shell.follow(link, session) { session.pendingLink = nil }
        }
        .onChange(of: session.tree?.pages.count) {
            guard let link = session.pendingLink, session.phase == .signedIn else { return }
            if shell.follow(link, session) { session.pendingLink = nil }
        }
        // An invite link opened in the app (NotiveloApp.onOpenURL): the join dialog, with the link looked up.
        .onChange(of: session.pendingInvite, initial: true) { _, token in
            guard let token, session.phase == .signedIn else { return }
            session.pendingInvite = nil
            shell.menu = nil
            shell.sheet = .joinInvite(token)
        }
        #if os(iOS)
        // Locked pages lock when the app goes to the background (as the web locks on background).
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { session.lockNow() }
        }
        #else
        .modifier(MacAutoLock(session: session))
        #endif
        .onChange(of: session.workspaceId) {
            if case .page = shell.route, !session.preview { shell.route = .notes }
            shell.calStatus = .open
            shell.calTags = []
            shell.calWho = .mine
            shell.tv.reset()
            shell.views.reset()
            if case .tasks = shell.route { shell.views.load(session) }
        }
        // Status is Open each time a task view is opened.
        .onChange(of: shell.route) { old, new in
            shell.bulk.clear()
            if case .tasks = new, old != new {
                if shell.views.keepStatus { shell.views.keepStatus = false } else { shell.tv.status = .open }
                shell.views.load(session)
            }
        }
    }

    /// The iPad's and the Mac's layout: ribbon across the top, then rail, sidebar and the main area.
    private func desktop(width: CGFloat, chrome: Palette) -> some View {
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
        .overlay { TreeDragPreview() }
    }

    /// Look states that show a menu open (CI screenshots).
    private func openLookMenu() {
        let menus: [String: Shell.Menu] = [
            "menu-account": .account, "menu-workspace": .workspace, "menu-notebook-picker": .notebookPicker,
            "menu-notebook": .notebookOptions, "menu-page-options": .pageOptions,
            "menu-section": .section("corpus"), "menu-page-row": .pageRow(LookData.pageId("canvas-boxes")),
            "ribbon-menu-block": .blockType, "ribbon-menu-text-colour": .textColor, "ribbon-menu-highlight": .highlight,
            "inbox": .inbox, "presence": .presence, "ribbon-menu-task": .taskSplit, "ribbon-menu-page-colour": .pageColor, "ribbon-menu-rule-lines": .ruleLines, "saved-views": .savedViews,
        ]
        guard session.preview, let state = LookData.state else { return }
        if state == "bulk-select" {
            shell.bulk.active = true
            shell.bulk.ids = Set(LookData.tasks.filter { $0.dueDate != nil }.prefix(2).map { $0.id })
        }
        if state == "saved-views" {
            shell.views.load(session)
            if let v = shell.views.view("v-urgent") { shell.views.open(v, shell, session) }
        }
        if let menu = menus[state], !(state == "saved-views" && mainScreenSize.width <= 760) { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { shell.menu = menu } }
        // Native-only dialogs (the web's dialogs have no reference shot).
        let corpus = LookData.pageId("canvas-boxes")
        let dialogs: [String: () -> Void] = [
            "dialog-new-section": { shell.newSection(in: "look", parent: nil, session) },
            "dialog-new-subsection": { shell.newSection(in: "look", parent: session.shownTree?.sections.first(where: { $0.id == "corpus" }), session) },
            "dialog-new-notebook": { shell.newNotebook(session) },
            "dialog-move-page": { shell.move(.page, corpus, session) },
            "dialog-move-section": { shell.move(.section, "empty-section", session) },
            "dialog-delete-notebook": { shell.delete(.notebook, "look", session) },
            "inline-rename": { shell.rename(.page, corpus, session) },
        ]
        if state == "quick-add" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { shell.openQuickAdd(session) } }
        // The sharing dialog with the public link on, and the delete-account sheet with a preview (corpus mode has no server).
        if state == "share-link" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { shell.sheet = .sharePage(corpus) } }
        if state == "delete-account" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { shell.sheet = .deleteAccount } }
        if state == "feedback" {
            shell.feedbackDraft = "The new page colours are lovely. Could the grid be a little fainter?"
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { shell.sheet = .feedback }
        }
        if let open = dialogs[state] { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { open() } }
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
            case .calendar:
                CalendarScreen()
            case .settings:
                SettingsScreen()
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
            HStack(spacing: 12) {
                Text(text).font(.web(13.5)).foregroundStyle(p.textInverse.color)
                if let action = shell.toastAction {
                    Button {
                        action.run()
                        shell.toast = nil
                        shell.toastAction = nil
                    } label: {
                        Text(action.label).font(.web(13.5, 600)).foregroundStyle(p.accentInverse.color).padding(.horizontal, 6).padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 10)
            .padding(.leading, 16)
            .padding(.trailing, shell.toastAction == nil ? 16 : 10)
            .background(p.bgInverse.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .shadowLg(p)
            .padding(.bottom, 20)
            .transition(.opacity)
            .allowsHitTesting(shell.toastAction != nil)
        }
    }
}
