import Foundation
import NotiveloCore
import Observation

/// How the Mac's main menu reaches the open window's shell (menu items are built outside the view tree). The shell
/// attaches itself when it appears. iPad/iPhone don't use it.
@Observable
final class ShellBridge {
    static let shared = ShellBridge()
    @ObservationIgnored private(set) weak var shell: Shell?
    @ObservationIgnored private(set) weak var session: SessionModel?
    private(set) var attached = false
    /// Quick capture was asked for while no window was open: the window that comes opens it.
    @ObservationIgnored private var pendingQuickCapture = false

    func attach(_ shell: Shell, _ session: SessionModel) {
        self.shell = shell
        self.session = session
        attached = true
        if pendingQuickCapture {
            pendingQuickCapture = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.newTask() }
        }
    }

    func detach(_ shell: Shell) {
        if self.shell === shell { self.shell = nil; attached = false }
    }

    // MARK: Create

    /// The section a new page goes in: the open page's or section, else the notebook's first.
    private var targetSection: String? {
        guard let shell, let session else { return nil }
        let tree = session.shownTree
        if case let .section(id) = shell.route { return id }
        if case let .page(id) = shell.route, let s = tree?.pages.first(where: { $0.id == id })?.sectionId { return s }
        guard let nb = currentNotebook(tree, shell), let tree else { return nil }
        return TreeIndex(tree).sections(in: nb).first?.id
    }

    func newPage() {
        guard let shell, let session else { return }
        guard let section = targetSection else { shell.say("Create a section first."); return }
        shell.newPage(in: section, session)
    }

    func newSection() {
        guard let shell, let session, let nb = currentNotebook(session.shownTree, shell) else { return }
        shell.newSection(in: nb.id, parent: nil, session)
    }

    func newNotebook() {
        guard let shell, let session else { return }
        shell.newNotebook(session)
    }

    // MARK: The open page and the workspace (File menu)

    func sharePage() {
        guard let shell, let session else { return }
        guard case let .page(id) = shell.route else { shell.say("Open a page first."); return }
        shell.openSheet(.sharePage(id), session, "Sharing")
    }

    func versionHistory() {
        guard let shell, let session else { return }
        guard case let .page(id) = shell.route else { shell.say("Open a page first."); return }
        shell.openSheet(.history(id), session, "Version history")
    }

    func showTrash() {
        guard let shell, let session else { return }
        shell.openSheet(.trash, session, "Trash")
    }

    func lockPagesNow() {
        guard let session else { return }
        session.lockNow()
        shell?.say("Locked pages are locked.")
    }

    // MARK: Go

    func showNotes() { shell?.route = .notes }
    func showTasks(_ list: Shell.TaskList) { shell?.route = .tasks(list) }
    func showCalendar() { shell?.route = .calendar }
    func search() { shell?.openSearch() }
    func toggleSidebar() { shell?.toggleSidebar() }
    func toggleRibbon() { shell?.ribbonCollapsed.toggle() }
    func signOut() { session?.signOut() }

    // MARK: Zoom (the page canvas)

    func zoom(by factor: Double) {
        guard let shell else { return }
        shell.zoom = min(3, max(0.5, (shell.zoom * factor * 100).rounded() / 100))
    }

    func zoomActual() { shell?.zoom = 1 }
}

extension ShellBridge {
    /// The menu bar icon and the global shortcut: quick add now, or once the window is there.
    func quickCapture() {
        if shell != nil { newTask() } else { pendingQuickCapture = true }
    }
}

extension ShellBridge {
    /// File > New Task.
    func newTask() {
        guard let shell, let session else { return }
        shell.openQuickAdd(session)
    }

    func openSettings(_ section: String? = nil) { shell?.openSettings(section) }

    /// File > Print and Export as PDF: the open page.
    func printPage() {
        guard let shell, let session else { return }
        guard case .page = shell.route else { shell.say("Open a page first."); return }
        shell.printPage(session)
    }

    func exportPDF() {
        guard let shell, let session else { return }
        guard case .page = shell.route else { shell.say("Open a page first."); return }
        shell.exportPDF(session)
    }
}
