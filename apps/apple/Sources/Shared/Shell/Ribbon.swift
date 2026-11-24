import NotiveloCore
import Observation
import SwiftUI

/// The box being edited, for the ribbon (the web's "active editor").
@Observable
final class EditorFocus {
    static let shared = EditorFocus()
    @ObservationIgnored private(set) weak var box: EditorTarget?
    private(set) var active = false
    /// The ribbon's Undo and Redo, Cmd-Z, shake, the three-finger swipes: the page's one undo (`PageHistory`, core's
    /// `LivePage.undo()`), whatever the newest change was and whichever box has the keyboard.
    var canUndo: Bool { PageHistory.shared.canUndo }
    var canRedo: Bool { PageHistory.shared.canRedo }
    /// The link editor of the canvas showing the focused box.
    @ObservationIgnored var onLink: (() -> Void)?

    func set(_ box: EditorTarget?) {
        self.box = box
        active = box != nil
    }

    /// An engine command for the focused box (`EditorSession.command`, EDITOR.md 4).
    func run(_ name: String, _ args: [String: Any] = [:]) {
        guard let box else { return }
        let json = (try? JSONSerialization.data(withJSONObject: args)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        box.command(name, json)
    }

    func openLinkEditor() { onLink?() }

    func undo() { PageHistory.shared.undo() }
    func redo() { PageHistory.shared.redo() }
}

/// Room for the Mac window's traffic lights at the ribbon's left (the window has no title bar of its own). It is
/// measured from the window's real buttons (`WindowChrome`) and is 0 in full screen, where the lights are gone.
@Observable
final class WindowInsets {
    static let shared = WindowInsets()
    #if os(macOS)
    /// Until the window reports its buttons: past the zoom button on macOS 15 and on the larger lights of macOS 26.
    var leading: CGFloat = 92
    #else
    var leading: CGFloat = 0
    #endif
}

/// Ribbon sizes by window width (src/styles/toolbar.css): ≤ 1023 the smallest buttons; ≤ 1279
/// compact (no group names, no words). Wider windows get the compact ribbon too for now.
struct RibbonMetrics {
    let small: Bool
    /// The Mac window's traffic lights take `WindowInsets.leading` of the ribbon's width (0 on iPad/iPhone).
    init(width: CGFloat) { small = width - WindowInsets.shared.leading <= 1023 }
    var height: CGFloat { small ? 30 : 36 }
    var minWidth: CGFloat { small ? 25 : 36 }
    var pad: CGFloat { small ? 3 : 8 }
    var icon: CGFloat { small ? 16 : 18 }
    var block: CGFloat { small ? 84 : 124 }
    var gap: CGFloat { small ? 0 : 2 }
    var sepMargin: CGFloat { small ? 2 : 4 }
    var padLeft: CGFloat { small ? 6 : 12 }
    var padRight: CGFloat { small ? 4 : 10 }
}

/// One ribbon button (`.bm-btn.rb-btn`): icon, optional caret, optional colour bar; pressed =
/// accent on accent-soft; disabled = 0.4.
struct RibbonButton: View {
    let icon: String
    let m: RibbonMetrics
    var enabled = true
    var pressed = false
    var caret = false
    var bar: Color?
    var anchor: String?
    let action: () -> Void
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let color = pressed ? p.accent.color : p.text2.color
        let button = Button(action: action) {
            HStack(spacing: 4) {
                ZStack(alignment: .bottom) {
                    Icon(icon, m.icon, color)
                    if let bar {
                        RoundedRectangle(cornerRadius: 2).fill(bar).frame(width: m.icon - 2, height: 3).offset(y: 3)
                    }
                }
                if caret { Icon("chevron-down", 12, color).opacity(0.7).padding(.leading, -2) }
            }
            .padding(.horizontal, m.pad)
            .frame(minWidth: m.minWidth)
            .frame(height: m.height)
            .background(pressed ? p.accentSoft.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        if let anchor {
            button.anchor(anchor, shell)
        } else {
            button
        }
    }
}

struct RibbonSeparator: View {
    let m: RibbonMetrics
    let theme = Theme.shared

    var body: some View {
        Rectangle().fill(theme.chrome.border.color).frame(width: 1, height: 22).padding(.horizontal, m.sepMargin)
    }
}

/// The ribbon for the current route (LOOK.md 4.1): the note ribbon on pages, the Tasks ribbon on
/// task views, the Notes ribbon on the overview.
struct Ribbon: View {
    let width: CGFloat
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let m = RibbonMetrics(width: width)
        VStack(spacing: 0) {
            HStack(spacing: m.gap) {
                switch shell.route {
                case .page: NoteRibbon(m: m)
                case let .tasks(list): TasksRibbon(m: m, list: list)
                case .notes, .section: NotesRibbon(m: m)
                case .calendar: CalendarRibbon(m: m)
                case .settings: SettingsRibbon(m: m)
                }
                Spacer(minLength: 0)
                if case .page = shell.route { DrawToggle(m: m) }
                if case .page = shell.route { HistoryGroup(m: m) }
                Button { shell.ribbonCollapsed = true } label: {
                    Icon("chevron-up", 16, p.text2.color).padding(.horizontal, 5).frame(minWidth: 28).frame(height: 28)
                }
                .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                .padding(.leading, 4)
            }
            .padding(.leading, m.padLeft + WindowInsets.shared.leading)
            .padding(.trailing, m.padRight)
            .padding(.vertical, 5)
            if case .page = shell.route, InkTool.shared.barOpen { InkBar(m: m) }
        }
        .frame(maxWidth: .infinity)
        .background(p.bgSidebar.color)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
        .padding(.bottom, 1)
    }
}

/// The collapsed ribbon: a 30 pt strip with the group names and "Show ribbon".
struct CollapsedRibbon: View {
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let names: String = {
            switch shell.route {
            case .page: return "Text · Lists · Insert · Page · View · History"
            case .tasks: return "New · Show · Organise · Filter · Views · Print"
            case .calendar: return "New · Navigate · View · Filter"
            case .settings: return ""
            default: return "New · Import"
            }
        }()
        HStack {
            Text(names).font(.web(11.5)).foregroundStyle(p.textMuted.color).lineLimit(1)
            Spacer(minLength: 8)
            Button { shell.ribbonCollapsed = false } label: {
                HStack(spacing: 4) {
                    Text("Show ribbon").font(.web(12.5, 500))
                    Icon("chevron-down", 14, p.text2.color)
                }
                .foregroundStyle(p.text2.color)
                .padding(.horizontal, 8).frame(height: 26)
            }
            .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
        }
        .padding(.leading, 16 + WindowInsets.shared.leading).padding(.trailing, 10)
        .frame(height: 30)
        .frame(maxWidth: .infinity)
        .background(p.bgSidebar.color)
        .overlay(alignment: .bottom) { Rectangle().fill(p.border.color).frame(height: 1) }
        .padding(.bottom, 1)
        .contentShape(Rectangle())
        .onTapGesture { shell.ribbonCollapsed = false }
    }
}

/// Text · Lists · Insert · Page · View (the note ribbon). Editing controls are enabled while a
/// box is being edited; the ones the engine has commands for run them, the rest say "not yet".
struct NoteRibbon: View {
    let m: RibbonMetrics
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let focus = EditorFocus.shared
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let on = focus.active
        Group {
        Button { shell.menu = .blockType } label: {
            HStack(spacing: 4) {
                Text("Normal").font(.web(13, 500)).foregroundStyle(p.text.color).lineLimit(1)
                Spacer(minLength: 0)
                Icon("chevron-down", 14, p.text.color)
            }
            .padding(.leading, m.small ? 6 : 10).padding(.trailing, m.small ? 4 : 6)
            .frame(width: m.block, height: m.height)
            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(p.border.color, lineWidth: 1))
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
        .disabled(!on).opacity(on ? 1 : 0.4)
        .anchor("rb-block", shell)
        RibbonButton(icon: "letter-b", m: m, enabled: on) { focus.run("toggleMark", ["mark": "bold"]) }
        RibbonButton(icon: "italic", m: m, enabled: on) { focus.run("toggleMark", ["mark": "italic"]) }
        RibbonButton(icon: "underline", m: m, enabled: on) { focus.run("toggleMark", ["mark": "underline"]) }
        RibbonButton(icon: "strikethrough", m: m, enabled: on) { focus.run("toggleMark", ["mark": "strike"]) }
        RibbonButton(icon: "baseline", m: m, enabled: on, anchor: "rb-text-colour") { shell.menu = .textColor }
        RibbonButton(icon: "highlighter", m: m, enabled: on, anchor: "rb-highlight") { shell.menu = .highlight }
        RibbonButton(icon: "remove-formatting", m: m, enabled: on) { shell.notYet("Clear formatting") }
        RibbonSeparator(m: m)
        }
        Group {
        RibbonButton(icon: "list", m: m, enabled: on) { focus.run("toggleBulletList") }
        RibbonButton(icon: "list-ordered", m: m, enabled: on) { focus.run("toggleOrderedList") }
        RibbonButton(icon: "list-indent-decrease", m: m, enabled: on) { focus.run("outdent") }
        RibbonButton(icon: "list-indent-increase", m: m, enabled: on) { focus.run("indent") }
        HStack(spacing: 0) {
            Button { focus.run("convertToTask") } label: {
                Icon("circle-check", m.icon, p.text2.color).padding(.leading, m.pad).padding(.trailing, 4).frame(height: m.height)
            }
            .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
            Button { shell.menu = .taskSplit } label: {
                Icon("chevron-down", 14, p.text2.color).padding(.horizontal, 2).frame(minWidth: 18).frame(height: m.height)
            }
            .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
            .anchor("rb-task", shell)
        }
        .disabled(!on).opacity(on ? 1 : 0.4)
        RibbonSeparator(m: m)
        }
        Group {
        RibbonButton(icon: "table", m: m, enabled: on) { focus.run("insertTable", ["rows": 3, "cols": 3, "header": true]) }
        RibbonButton(icon: "image-plus", m: m, enabled: on) { MediaHub.shared.pick(.image, into: focus.box) }
        RibbonButton(icon: "paperclip", m: m, enabled: on) { MediaHub.shared.pick(.file, into: focus.box) }
        RibbonButton(icon: "link-2", m: m, enabled: on) { focus.openLinkEditor() }
        RibbonButton(icon: "file-symlink", m: m, enabled: on) { shell.notYet("Links to pages") }
        RibbonButton(icon: "minus", m: m, enabled: on) { shell.notYet("Dividers from the ribbon") }
        RibbonSeparator(m: m)
        }
        Group {
        RibbonButton(icon: "paint-bucket", m: m, bar: Color.clear, anchor: "rb-page-colour") { shell.menu = .pageColor }
        RibbonButton(icon: "rows-3", m: m, anchor: "rb-rule-lines") { shell.menu = .ruleLines }
        RibbonButton(icon: "printer", m: m) { shell.printPage(session) }
        RibbonSeparator(m: m)
        RibbonButton(icon: "list-tree", m: m, pressed: true) { shell.notYet("Hiding the outline") }
        }
    }
}

struct HistoryGroup: View {
    let m: RibbonMetrics
    let focus = EditorFocus.shared

    var body: some View {
        RibbonButton(icon: "undo-2", m: m, enabled: focus.canUndo) { focus.undo() }
        RibbonButton(icon: "redo-2", m: m, enabled: focus.canRedo) { focus.redo() }
    }
}

/// The Tasks ribbon (SectionRibbons.tsx): New | Show | Organise | Filter | Views | Print.
struct TasksRibbon: View {
    let m: RibbonMetrics
    let list: Shell.TaskList
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        let tv = shell.tv
        Group {
        RibbonButton(icon: "plus", m: m) { shell.openQuickAdd(session) }
        RibbonSeparator(m: m)
        RibbonButton(icon: "sun", m: m, pressed: list == .today) { shell.route = .tasks(.today) }
        RibbonButton(icon: "calendar-range", m: m, pressed: list == .upcoming) { shell.route = .tasks(.upcoming) }
        RibbonButton(icon: "inbox", m: m, pressed: list == .my) { shell.route = .tasks(.my) }
        RibbonButton(icon: "list-checks", m: m, pressed: list == .all) { shell.route = .tasks(.all) }
        RibbonSeparator(m: m)
        // Group by and Sort don't apply to Today, Upcoming and Team (their grouping is fixed); My Tasks groups but sorts by date.
        RibbonButton(icon: "layers", m: m, enabled: list == .my || list == .all, caret: true, anchor: "rb-taskGroup") { shell.menu = .taskGroup }
        RibbonButton(icon: "arrow-up-down", m: m, enabled: list == .all, caret: true, anchor: "rb-taskSort") { shell.menu = .taskSort }
        RibbonSeparator(m: m)
        }
        Group {
        // Status applies to All tasks (the other views show open tasks).
        RibbonButton(icon: "eye", m: m, enabled: list == .all, pressed: tv.isOn(.status), caret: true, anchor: "rb-taskStatus") { shell.menu = .taskStatus }
        RibbonButton(icon: "user", m: m, enabled: list != .my, pressed: tv.isOn(.assignee) || (list == .upcoming && !tv.upcomingEveryone), caret: true,
                     anchor: "rb-taskAssignee") { shell.menu = .taskAssignee }
        RibbonButton(icon: "tag", m: m, pressed: tv.isOn(.tags), caret: true, anchor: "rb-taskTags") { shell.menu = .taskTags }
        RibbonButton(icon: "users-round", m: m, pressed: tv.isOn(.team), caret: true, anchor: "rb-taskTeam") { shell.menu = .taskTeam; session.loadAllDetails() }
        RibbonButton(icon: "flag", m: m, pressed: tv.isOn(.priority), caret: true, anchor: "rb-taskPriority") { shell.menu = .taskPriority }
        RibbonButton(icon: "sliders-horizontal", m: m, pressed: tv.isOn(.due) || tv.isOn(.source), caret: true, anchor: "rb-taskMore") { shell.menu = .taskMore }
        RibbonButton(icon: "funnel-x", m: m, enabled: !tv.activeKinds.isEmpty) { tv.clearAll(); tv.status = .open }
        RibbonSeparator(m: m)
        }
        Group {
        RibbonButton(icon: "bookmark", m: m, caret: true) { shell.notYet("Saved views") }
        RibbonButton(icon: "bookmark-plus", m: m, enabled: false) {}
        RibbonSeparator(m: m)
        RibbonButton(icon: "printer", m: m) { shell.notYet("Printing") }
        }
    }
}

/// The Notes ribbon (overview, empty section): New | Import.
struct NotesRibbon: View {
    let m: RibbonMetrics
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session

    var body: some View {
        // Without a notebook there is nowhere for a page or section: those buttons are dimmed, as on the web.
        let tree = session.shownTree
        let notebook = currentNotebook(tree, shell)
        let sectionId: String? = {
            if case let .section(id) = shell.route { return id }
            if case let .page(id) = shell.route { return tree?.pages.first { $0.id == id }?.sectionId }
            return notebook.flatMap { nb in TreeIndex(tree ?? Tree(notebooks: [], sections: [], pages: [])).sections(in: nb).first?.id }
        }()
        let canAdd = notebook != nil
        RibbonButton(icon: "file-plus", m: m, enabled: canAdd) { shell.newPage(in: sectionId ?? "", session) }
        RibbonButton(icon: "layout-template", m: m, enabled: canAdd, caret: true) { shell.notYet("Templates") }
        RibbonButton(icon: "folder-plus", m: m, enabled: canAdd) { if let notebook { shell.newSection(in: notebook.id, parent: nil, session) } }
        RibbonButton(icon: "book-plus", m: m) { shell.newNotebook(session) }
        RibbonSeparator(m: m)
        RibbonButton(icon: "upload", m: m, caret: true) { shell.notYet("Import") }
    }
}
