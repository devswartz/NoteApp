import NotiveloCore
import SwiftUI

private struct MenuPaddingKey: EnvironmentKey {
    static let defaultValue: CGFloat = 6
}

extension EnvironmentValues {
    /// The enclosing menu card's padding (separators run out to its edges).
    var menuPadding: CGFloat {
        get { self[MenuPaddingKey.self] }
        set { self[MenuPaddingKey.self] = newValue }
    }
}

/// A popover in the web's menu style (LOOK.md 4.9): `--bg-elevated`, 1 pt border, radius 12,
/// `--shadow-lg`, padding 6.
struct MenuCard<Content: View>: View {
    let palette: Palette
    var width: CGFloat
    var radius: CGFloat = 12
    var padding: CGFloat = 6
    /// Taller than this, the content is cut off (a phone's popover can't scroll here).
    var maxHeight: CGFloat? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .fixedSize(horizontal: false, vertical: true)
            .frame(height: maxHeight, alignment: .top)
            .clipped()
            .padding(padding)
            .frame(width: width, alignment: .leading)
            .background(palette.bgElevated.color, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(palette.border.color, lineWidth: 1))
            .shadowLg(palette)
            .environment(\.menuPadding, padding)
    }
}

/// A menu item: 32 high, icon column 18 (icon 15 muted), text 14, hint 12 muted, check for the current choice.
struct MenuItem: View {
    let palette: Palette
    let title: String
    var icon: String?
    var hint: String?
    var tile: String?
    /// A colour (#rrggbb) drawn as a dot in the icon column (the web's `LabelDot`: a tag or a team).
    var dot: String?
    var note: String?
    var danger = false
    var disabled = false
    var checked = false
    var trailingChevron = false
    let action: () -> Void
    @Environment(\.phoneLayout) private var phone

    var body: some View {
        let p = palette
        let fg = danger ? p.danger : p.text
        Button(action: action) {
            HStack(alignment: note == nil ? .center : .top, spacing: 10) {
                if let tile {
                    LetterTile(letter: tile,
                               fill: AnyShapeStyle(LinearGradient(colors: [PlatformColor(hex: 0x6366F1).color, PlatformColor(hex: 0x8B5CF6).color],
                                                                  startPoint: .topLeading, endPoint: .bottomTrailing)),
                               size: 20, radius: 6, fontSize: 11)
                } else {
                    Group {
                        if let dot { Circle().fill(PlatformColor(css: dot).color).frame(width: 10, height: 10) }
                        else if let icon { Icon(icon, 15, (danger ? p.danger : p.textMuted).color) } else { Color.clear }
                    }
                    .frame(width: 18, height: 18)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.web(phone ? 15 : 14)).foregroundStyle(fg.color).lineLimit(1)
                    if let note {
                        Text(note).font(.web(phone ? 12 : 11.5)).foregroundStyle(p.textMuted.color).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: phone ? 262 : 240, alignment: .leading)
                    }
                }
                Spacer(minLength: 0)
                if let hint { Text(hint).font(.web(12)).foregroundStyle(p.textMuted.color).padding(.leading, 16) }
                if checked { Icon("check", 14, p.accent.color) }
                if trailingChevron { Icon("chevron-right", 14, p.textMuted.color) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, note == nil ? 0 : (phone ? 11 : 7))
            .frame(minHeight: phone ? 44 : 32)
        }
        .buttonStyle(PressStyle(radius: 6, pressed: (danger ? p.danger.withAlphaComponent(0.12) : p.bgHover).color))
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
    }
}

/// The menu label row (MY NOTEBOOKS, THEME …): 11.5/600 uppercase muted.
struct MenuLabel: View {
    @Environment(\.phoneLayout) private var phone
    let palette: Palette
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.web(11.5, 600)).tracking(0.35).foregroundStyle(palette.textMuted.color)
            .padding(.horizontal, 10).padding(.top, phone ? 10 : 6).padding(.bottom, phone ? 3 : 4)
    }
}

/// A separator running to the popover's edges, 6 pt above and below.
struct MenuSeparator: View {
    let palette: Palette
    @Environment(\.menuPadding) private var pad
    var body: some View {
        Rectangle().fill(palette.border.color).frame(height: 1).padding(.horizontal, -pad).padding(.vertical, 6)
    }
}

/// The colour row in notebook and section menus: 20×20 circles, gap 6, padding 8.
struct ColorRow: View {
    let palette: Palette
    let selected: String?
    let pick: (String) -> Void
    @Environment(\.phoneLayout) private var phone
    static let colors = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#64748b"]

    var body: some View {
        HStack(spacing: phone ? 12 : 6) {
            ForEach(Self.colors, id: \.self) { c in
                Button { pick(c) } label: {
                    Circle().fill(PlatformColor(css: c).color).frame(width: phone ? 32 : 20, height: phone ? 32 : 20)
                        .overlay { if c.lowercased() == selected?.lowercased() { Icon("check", phone ? 16 : 12, .white) } }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, phone ? 12 : 8)
    }
}

/// Every menu of the shell, placed at its anchor; a tap outside closes it.
struct MenuLayer: View {
    let width: CGFloat
    let height: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared
    let focus = EditorFocus.shared

    /// Phones open the notebook, section and page-row menus as bottom sheets over a dimmed screen.
    private func isSheet(_ menu: Shell.Menu) -> Bool {
        guard phone else { return false }
        switch menu {
        case .inbox, .notebookOptions, .section, .pageRow, .pageIcon: return true
        case .taskGroup, .taskSort, .taskKinds, .taskStatus, .taskAssignee, .taskTags, .taskTeam, .taskPriority, .taskMore: return true
        default: return false
        }
    }

    var body: some View {
        if let menu = shell.menu {
            ZStack(alignment: .topLeading) {
                (isSheet(menu) ? theme.chrome.bgOverlay.color : Color.black.opacity(0.001))
                    .contentShape(Rectangle())
                    .onTapGesture { shell.menu = nil }
                placed(menu)
            }
            .frame(width: width, height: height)
        }
    }

    /// A bottom sheet: 8 pt from the sides and the bottom.
    private func sheet<V: View>(_ content: V) -> some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            content.padding(.bottom, 8)
        }
        .frame(width: width, height: height)
    }

    private func anchorFrame(_ id: String) -> CGRect {
        shell.frames[id] ?? CGRect(x: width / 2, y: 60, width: 0, height: 0)
    }

    /// The popover's corner at a point: below start-aligned, below end-aligned, or right of a rail button bottom-aligned.
    private func at<V: View>(_ point: CGPoint, _ alignment: Alignment, _ content: V) -> some View {
        Color.clear.frame(width: 0, height: 0)
            .overlay(alignment: alignment) { content.fixedSize() }
            .position(x: min(max(point.x, 8), width - 8), y: min(max(point.y, 8), height - 8))
    }

    @ViewBuilder
    private func placed(_ menu: Shell.Menu) -> some View {
        let p = theme.chrome
        switch menu {
        case .inbox:
            if phone {
                sheet(InboxCard(palette: p, width: width - 16, listHeight: height * 0.5))
            } else {
                let f = anchorFrame("rail-bell")
                at(CGPoint(x: f.maxX + 8, y: min(f.maxY + 5, height - 8)), .bottomLeading,
                   InboxCard(palette: p, width: min(380, width - 24), listHeight: min(460, height * 0.6)))
            }
        case .account:
            if phone {
                let f = anchorFrame("drawer-account")
                at(CGPoint(x: f.minX, y: f.minY + 2), .bottomLeading, accountMenu(p))
            } else {
                let f = anchorFrame("rail-account")
                at(CGPoint(x: f.maxX + 8, y: min(f.maxY + 5, height - 8)), .bottomLeading, accountMenu(p))
            }
        case .workspace:
            if phone {
                let f = anchorFrame("drawer-workspace")
                at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, workspaceMenu(p))
            } else {
                let f = anchorFrame("rail-workspace")
                at(CGPoint(x: f.maxX + 8, y: min(f.maxY + 5, height - 8)), .bottomLeading, workspaceMenu(p))
            }
        case .notebookPicker:
            let f = anchorFrame("notebook-picker")
            at(CGPoint(x: f.minX + (phone ? 6 : 0), y: f.maxY + 6), .topLeading, notebookPicker(p))
        case .notebookOptions:
            if phone {
                sheet(notebookOptions(p))
            } else {
                let f = anchorFrame("notebook-options")
                at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, notebookOptions(p))
            }
        case let .section(id):
            if phone {
                sheet(sectionMenu(p, id))
            } else {
                let f = anchorFrame("section:\(id)")
                at(CGPoint(x: f.minX + 24, y: f.maxY + 6), .topLeading, sectionMenu(p, id))
            }
        case let .pageRow(id):
            if phone {
                sheet(pageRowMenu(p, id))
            } else {
                let f = anchorFrame("page:\(id)")
                at(CGPoint(x: f.minX + 24, y: f.maxY + 6), .topLeading, pageRowMenu(p, id))
            }
        case let .pageIcon(id):
            if phone {
                sheet(iconPicker(p, id))
            } else {
                let f = anchorFrame("page-icon")
                at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, iconPicker(p, id))
            }
        case .presence:
            let f = anchorFrame("page-presence")
            at(CGPoint(x: f.maxX, y: f.maxY + 6), .topTrailing, PresenceMenu(palette: p, people: shell.presenceList(session)))
        case .pageOptions:
            let f = anchorFrame("page-options")
            at(CGPoint(x: f.maxX, y: f.maxY + 6), .topTrailing, pageOptions(p))
        case .blockType:
            let f = anchorFrame("rb-block")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, blockMenu(p))
        case .textColor:
            let f = anchorFrame("rb-text-colour")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, colorMenu(theme.page, highlight: false))
        case .highlight:
            let f = anchorFrame("rb-highlight")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, colorMenu(theme.page, highlight: true))
        case .taskSplit:
            let f = anchorFrame("rb-task")
            at(CGPoint(x: f.minX - 30, y: f.maxY + 6), .topLeading, taskMenu(p))
        case .pageColor:
            let f = anchorFrame("rb-page-colour")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, pageColorMenu(p))
        case .ruleLines:
            let f = anchorFrame("rb-rule-lines")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, ruleMenu(p))
        case .calTags:
            let f = anchorFrame("rb-cal-tags")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, calTagsMenu(p))
        case .calPeople:
            let f = anchorFrame("rb-cal-people")
            at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, calPeopleMenu(p))
        case .taskGroup, .taskSort, .taskKinds, .taskStatus, .taskAssignee, .taskTags, .taskTeam, .taskPriority, .taskMore:
            if phone {
                sheet(TaskFilterMenu(menu: menu, palette: p))
            } else {
                let f = anchorFrame("rb-" + String(describing: menu))
                at(CGPoint(x: f.minX, y: f.maxY + 6), .topLeading, TaskFilterMenu(menu: menu, palette: p))
            }
        }
    }

    /// The page icon's emoji picker (the web's `IconPicker`).
    private func iconPicker(_ p: Palette, _ id: String) -> some View {
        let has = !(session.shownTree?.pages.first { $0.id == id }?.icon ?? "").isEmpty
        return IconPickerCard(palette: p, hasIcon: has) { emoji in
            shell.menu = nil
            shell.setPageIcon(id, emoji, session)
        }
    }

    // MARK: Rail and sidebar menus

    private func accountMenu(_ p: Palette) -> some View {
        let user = session.shownUser
        return MenuCard(palette: p, width: 262) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user?.name ?? "").font(.web(14, 600)).foregroundStyle(p.text.color)
                Text(user?.email ?? "").font(.web(12.5)).foregroundStyle(p.textMuted.color)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            MenuSeparator(palette: p)
            MenuLabel(palette: p, text: "Theme")
            HStack(spacing: 2) {
                ForEach(ThemeMode.allCases, id: \.self) { mode in
                    let active = theme.mode == mode
                    Button { theme.mode = mode } label: {
                        VStack(spacing: 3) {
                            Icon(mode.icon, 14, (active ? p.text : p.text2).color)
                            Text(mode.label).font(.web(11.5, 500)).foregroundStyle((active ? p.text : p.text2).color)
                        }
                        .frame(maxWidth: .infinity).frame(height: 42)
                        .background(active ? p.bg.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .shadowSm(p)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(2)
            .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
            .padding(.horizontal, 4).padding(.bottom, 2)
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Settings", icon: "settings") { shell.openSettings() }
            MenuItem(palette: p, title: "Keyboard shortcuts", icon: "keyboard", hint: "?") { shell.openSettings("shortcuts") }
            MenuItem(palette: p, title: "Get the apps", icon: "download") { shell.notYet("The app downloads") }
            if !session.preview {
                MenuItem(palette: p, title: session.lockStatus?.hasPassword == true ? "Change locked pages password…" : "Set a locked pages password…", icon: "lock") {
                    shell.openSheet(.lock(session.lockStatus?.hasPassword == true ? .changePassword : .setPassword), session, "Locked pages")
                }
                if session.locksOpen {
                    MenuItem(palette: p, title: "Lock pages now", icon: "lock") {
                        shell.menu = nil
                        session.lockNow()
                    }
                }
            }
            if session.isStaging {
                MenuItem(palette: p, title: "Server: \(session.host)", icon: "globe", disabled: true) {}
            }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Sign out", icon: "log-out") {
                shell.menu = nil
                session.signOut()
            }
        }
    }

    private func workspaceMenu(_ p: Palette) -> some View {
        MenuCard(palette: p, width: phone ? 252 : 240) {
            ForEach(session.shownWorkspaces, id: \.id) { ws in
                MenuItem(palette: p, title: ws.name, hint: ws.role, tile: ws.name,
                         checked: ws.id == (session.shownWorkspace?.id)) {
                    shell.menu = nil
                    if !session.preview { session.selectWorkspace(ws.id) }
                }
            }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "New workspace", icon: "plus") { shell.notYet("New workspace") }
            MenuItem(palette: p, title: "Workspace settings", icon: "settings") { shell.notYet("Workspace settings") }
            MenuItem(palette: p, title: "Members", icon: "users") { shell.openSheet(.members, session, "Members") }
            MenuItem(palette: p, title: "Join with invite link", icon: "link-2") { shell.openSheet(.joinInvite(nil), session, "Joining a workspace") }
            MenuItem(palette: p, title: "Activity", icon: "activity") { shell.notYet("Activity") }
            MenuItem(palette: p, title: "Trash", icon: "trash") { shell.openSheet(.trash, session, "Trash") }
        }
    }

    private func notebookPicker(_ p: Palette) -> some View {
        let tree = session.shownTree
        let current = currentNotebook(tree, shell)
        let notebooks = tree.map { TreeIndex($0).notebooks } ?? []
        return MenuCard(palette: p, width: phone ? 274 : 260) {
            MenuLabel(palette: p, text: "My notebooks")
            ForEach(notebooks, id: \.id) { nb in
                Button {
                    shell.menu = nil
                    shell.notebookId = nb.id
                    if !phone { shell.route = .notes }
                } label: {
                    HStack(spacing: 10) {
                        LetterTile(letter: nb.name, fill: AnyShapeStyle(PlatformColor(css: nb.color).color), size: 18, radius: 5, fontSize: 10)
                        Text(nb.name).font(.web(phone ? 15 : 14)).foregroundStyle(p.text.color).lineLimit(1)
                        if nb.id == current?.id { Icon("check", 14, p.accent.color).padding(.leading, 2) }
                        if nb.visibility == "private" { Icon("lock", 13, p.textMuted.color).padding(.leading, 6) }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).frame(height: phone ? 44 : 32)
                }
                .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
            }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "New notebook", icon: "book-plus") { shell.newNotebook(session) }
        }
    }

    private func notebookOptions(_ p: Palette) -> some View {
        let nb = currentNotebook(session.shownTree, shell)
        return MenuCard(palette: p, width: phone ? width - 16 : 230, radius: phone ? 16 : 12, padding: phone ? 8 : 6) {
            MenuItem(palette: p, title: "New section", icon: "folder-plus") { if let nb { shell.newSection(in: nb.id, parent: nil, session) } }
            MenuItem(palette: p, title: "Rename", icon: "pencil") { if let nb { shell.rename(.notebook, nb.id, session) } }
            MenuItem(palette: p, title: "Share with people…", icon: "user-plus") { if let nb { shell.openSheet(.shareNotebook(nb.id), session, "Sharing") } }
            MenuItem(palette: p, title: nb?.visibility == "private" ? "Share with workspace" : "Make private", icon: "lock") {
                if let nb { if session.preview { shell.notYet("Changing who sees a notebook") } else { shell.setVisibility(nb.id, private: nb.visibility != "private", session) } }
            }
            MenuItem(palette: p, title: "Print…", icon: "printer") { shell.notYet("Printing") }
            ColorRow(palette: p, selected: nb?.color) { c in if let nb { if session.preview { shell.notYet("Notebook colours") } else { shell.recolour(.notebook, nb.id, c, session) } } }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Delete notebook", icon: "trash", danger: true) { if let nb { shell.delete(.notebook, nb.id, session) } }
        }
    }

    private func sectionMenu(_ p: Palette, _ id: String) -> some View {
        let section = session.shownTree?.sections.first { $0.id == id }
        return MenuCard(palette: p, width: phone ? width - 16 : 236, radius: phone ? 16 : 12, padding: phone ? 8 : 6) {
            Group {
            MenuItem(palette: p, title: "New page", icon: "file-plus") { shell.newPage(in: id, session) }
            MenuItem(palette: p, title: "New page from template", icon: "layout-template", trailingChevron: true) { shell.openSheet(.newFromTemplate(id), session, "Templates") }
            MenuItem(palette: p, title: "Default template…", icon: "file-cog") { shell.openSheet(.defaultTemplate(id), session, "Templates") }
            MenuItem(palette: p, title: "New subsection", icon: "folder-plus") { shell.newSection(in: section?.notebookId ?? "", parent: section, session) }
            MenuItem(palette: p, title: "Rename", icon: "pencil") { shell.rename(.section, id, session) }
            MenuItem(palette: p, title: "Duplicate", icon: "copy") { shell.duplicate(.section, id, session) }
            MenuItem(palette: p, title: "Move to…", icon: "folder-input") { shell.move(.section, id, session) }
            }
            MenuItem(palette: p, title: "Print…", icon: "printer") { shell.notYet("Printing") }
            ColorRow(palette: p, selected: section?.color) { c in if session.preview { shell.notYet("Section colours") } else { shell.recolour(.section, id, c, session) } }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Delete section", icon: "trash", danger: true) { shell.delete(.section, id, session) }
        }
    }

    private func pageRowMenu(_ p: Palette, _ id: String) -> some View {
        MenuCard(palette: p, width: phone ? width - 16 : 236, radius: phone ? 16 : 12, padding: phone ? 8 : 6) {
            MenuItem(palette: p, title: shell.isFavourite(id, session) ? "Remove from favourites" : "Add to favourites", icon: shell.isFavourite(id, session) ? "star-off" : "star") { shell.toggleFavourite(id, session) }
            MenuItem(palette: p, title: "Copy link", icon: "link-2") { shell.copyPageLink(id, session) }
            MenuItem(palette: p, title: "Rename", icon: "pencil") { shell.rename(.page, id, session) }
            lockItem(p, id)
            MenuItem(palette: p, title: "Duplicate", icon: "copy") { shell.duplicate(.page, id, session) }
            MenuItem(palette: p, title: "Move to…", icon: "folder-input") { shell.move(.page, id, session) }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Delete page", icon: "trash", danger: true) { shell.delete(.page, id, session) }
        }
    }

    private func pageOptions(_ p: Palette) -> some View {
        let tree = session.shownTree
        let index = tree.map(TreeIndex.init)
        return MenuCard(palette: p, width: 300, maxHeight: phone ? 492 : nil) {
            Group {
            MenuItem(palette: p, title: "Share…", icon: "user-plus") { if let id = openPageId { shell.openSheet(.sharePage(id), session, "Sharing") } }
            MenuSeparator(palette: p)
            if let id = openPageId { lockItem(p, id) }
            MenuItem(palette: p, title: "Duplicate", icon: "copy") { if let id = openPageId { shell.duplicate(.page, id, session) } }
            MenuItem(palette: p, title: "Save as template…", icon: "layout-template") { if let id = openPageId { shell.openSheet(.saveTemplate(id), session, "Templates") } }
            MenuItem(palette: p, title: "Version history", icon: "rotate-ccw-clock") { if let id = openPageId { shell.openSheet(.history(id), session, "Version history") } }
            MenuSeparator(palette: p)
            }
            Group {
            MenuItem(palette: p, title: "Export as Markdown", icon: "file-down") { shell.exportMarkdown(session) }
            MenuItem(palette: p, title: "Export as PDF…", icon: "file-down") { shell.exportPDF(session) }
            MenuItem(palette: p, title: "Print", icon: "printer", hint: "Ctrl+P") { shell.printPage(session) }
            MenuItem(palette: p, title: "Print page colour") { shell.printPage(session, colour: true) }
            MenuItem(palette: p, title: "Import Markdown…", icon: "file-up") { shell.notYet("Import") }
            MenuSeparator(palette: p)
            }
            HStack(spacing: 2) {
                segment(p, "Move to", "folder-input", active: true)
                segment(p, "Copy to", "copy", active: false)
            }
            .padding(2)
            .background(p.bgHover.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.horizontal, 4).padding(.bottom, 4)
            if let index {
                ForEach(index.notebooks.prefix(2), id: \.id) { nb in
                    Text(nb.name).font(.web(11.5, 600)).foregroundStyle(p.textMuted.color).padding(.horizontal, 10).padding(.top, 6)
                    ForEach(index.sections(in: nb).prefix(3), id: \.id) { s in
                        MenuItem(palette: p, title: s.name) { shell.menu = nil; if let id = openPageId { shell.run(.move(.page, id), session, to: s.id) } }
                            .overlay(alignment: .leading) { Circle().fill(PlatformColor(css: s.color).color).frame(width: 8, height: 8).padding(.leading, 15) }
                    }
                }
            }
            MenuSeparator(palette: p)
            MenuItem(palette: p, title: "Delete page", icon: "trash", danger: true) { if let id = openPageId { shell.delete(.page, id, session) } }
        }
    }

    /// "Lock page" (a private notebook's page, once there is a locked pages password or one is chosen here), or "Remove lock".
    @ViewBuilder private func lockItem(_ p: Palette, _ id: String) -> some View {
        let tree = session.shownTree
        let meta = tree?.pages.first { $0.id == id }
        let section = tree?.sections.first { $0.id == meta?.sectionId }
        let notebook = tree?.notebooks.first { $0.id == section?.notebookId }
        if session.preview || meta == nil {
            MenuItem(palette: p, title: "Lock page", icon: "lock",
                     note: "Only pages only you can see can be locked. Move it to a private notebook first.", disabled: true) {}
        } else if meta?.locked == true {
            MenuItem(palette: p, title: "Remove lock", icon: "lock-open") { shell.openSheet(.lock(.removeLock(id)), session, "Locked pages") }
        } else if notebook?.visibility == "private" {
            MenuItem(palette: p, title: "Lock page", icon: "lock") { shell.openSheet(.lock(.lockPage(id)), session, "Locked pages") }
        } else {
            MenuItem(palette: p, title: "Lock page", icon: "lock",
                     note: "Only pages only you can see can be locked. Move it to a private notebook first.", disabled: true) {}
        }
    }

    /// The page open in the main area (the page options menu belongs to it).
    private var openPageId: String? {
        if case let .page(id) = shell.route { return id }
        return nil
    }

    private func segment(_ p: Palette, _ title: String, _ icon: String, active: Bool) -> some View {
        HStack(spacing: 6) {
            Icon(icon, 13, (active ? p.text : p.text2).color)
            Text(title).font(.web(12.5, 500)).foregroundStyle((active ? p.text : p.text2).color)
        }
        .frame(maxWidth: .infinity).frame(height: 28)
        .background(active ? p.bgElevated.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    // MARK: Ribbon menus

    private func blockMenu(_ p: Palette) -> some View {
        MenuCard(palette: p, width: 220, radius: 10, padding: 4) {
            blockItem(p, "Normal", .web(14), "⌘⌥0") { focus.run("setParagraph") }
            blockItem(p, "Heading 1", .web(18, 700), "⌘⌥1") { focus.run("setHeading", ["level": 1]) }
            blockItem(p, "Heading 2", .web(16, 650), "⌘⌥2") { focus.run("setHeading", ["level": 2]) }
            blockItem(p, "Heading 3", .web(14.5, 600), "⌘⌥3") { focus.run("setHeading", ["level": 3]) }
            blockItem(p, "Quote", Font(WebType.italic(14) as CTFont), nil, quote: true) { focus.run("toggleQuote") }
            blockItem(p, "Code", Font(WebType.mono(13) as CTFont), "⌘⌥C") { focus.run("toggleCodeBlock") }
        }
    }

    private func blockItem(_ p: Palette, _ title: String, _ font: Font, _ key: String?, quote: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button {
            shell.menu = nil
            action()
        } label: {
            HStack(spacing: 8) {
                Text(title).font(font).foregroundStyle(p.text.color)
                Spacer(minLength: 16)
                if let key { Text(key).font(.web(11.5, 500)).foregroundStyle(p.textMuted.color) }
            }
            .padding(.vertical, 6).padding(.horizontal, 10)
            .overlay(alignment: .leading) {
                if quote { Rectangle().fill(p.borderStrong.color).frame(width: 3) }
            }
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
    }

    private func colorMenu(_ p: Palette, highlight: Bool) -> some View {
        MenuCard(palette: p, width: 120, radius: 10, padding: 4) {
            Text(highlight ? "Highlight" : "Text colour").font(.web(12, 500)).foregroundStyle(p.textMuted.color)
                .padding(.top, 2).padding(.horizontal, 4).padding(.bottom, 6)
            let names: [String?] = [nil] + Palette.colorNames.map { Optional($0) }
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(32), spacing: 4), count: 3), spacing: 4) {
                ForEach(0..<names.count, id: \.self) { i in
                    let name = names[i]
                    Button {
                        shell.menu = nil
                        if highlight {
                            if let name { focus.run("setHighlight", ["color": name]) } else { focus.run("unsetHighlight") }
                        } else {
                            if let name { focus.run("setColor", ["color": name]) } else { focus.run("unsetColor") }
                        }
                    } label: {
                        ZStack {
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(highlight && name != nil ? p.highlight(name).color : p.bgElevated.color)
                            RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(p.border.color, lineWidth: 1)
                            if highlight && name == nil {
                                Rectangle().fill(p.textMuted.color).frame(width: 18, height: 2).rotationEffect(.degrees(-45))
                            } else if !highlight {
                                Text("A").font(.web(15, 600)).foregroundStyle((name.flatMap { p.textColor($0) } ?? p.text).color)
                            }
                        }
                        .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: 104)
        }
    }

    // MARK: Calendar filters

    /// The Calendar ribbon's Tags menu (`RibbonMenu` "Tags filter"): tasks with any of the ticked tags; it stays open while
    /// ticking.
    private func calTagsMenu(_ p: Palette) -> some View {
        MenuCard(palette: p, width: 220, maxHeight: 380) {
            if session.tags.isEmpty {
                Text("No tags yet.").font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.horizontal, 10).padding(.vertical, 8)
            }
            ForEach(session.tags, id: \.id) { t in
                MenuItem(palette: p, title: t.name, dot: t.color, checked: shell.calTags.contains(t.id)) {
                    if shell.calTags.contains(t.id) { shell.calTags.remove(t.id) } else { shell.calTags.insert(t.id) }
                }
            }
            if !shell.calTags.isEmpty {
                MenuSeparator(palette: p)
                MenuItem(palette: p, title: "Remove Tags filter", icon: "filter-x") {
                    shell.calTags = []
                    shell.menu = nil
                }
            }
        }
    }

    /// The Calendar's person filter: tasks nobody has, or one person's (the web's assignee select, in the ribbon here).
    private func calPeopleMenu(_ p: Palette) -> some View {
        let me = session.shownUser?.id
        return MenuCard(palette: p, width: 220, maxHeight: 380) {
            MenuItem(palette: p, title: "Unassigned", icon: "user-minus", checked: shell.calWho == .unassigned) {
                shell.calWho = .unassigned
                shell.menu = nil
            }
            ForEach(session.members.filter { $0.id != me }, id: \.id) { m in
                MenuItem(palette: p, title: m.name, dot: m.color, checked: shell.calWho == .person(m.id)) {
                    shell.calWho = .person(m.id)
                    shell.menu = nil
                }
            }
            if shell.calWho != .mine && shell.calWho != .everyone {
                MenuSeparator(palette: p)
                MenuItem(palette: p, title: "Remove person filter", icon: "filter-x") {
                    shell.calWho = .mine
                    shell.menu = nil
                }
            }
        }
    }

    private func taskMenu(_ p: Palette) -> some View {
        MenuCard(palette: p, width: 220, radius: 10, padding: 4) {
            Button {
                shell.menu = nil
                focus.run("toggleChecklist")
            } label: {
                HStack(spacing: 8) {
                    Icon("list-checks", 16, p.text2.color)
                    Text("Plain checkbox").font(.web(14)).foregroundStyle(p.text.color)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 6).padding(.horizontal, 10)
            }
            .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
        }
    }

    private func pageColorMenu(_ p: Palette) -> some View {
        let names = ["none", "yellow", "green", "blue", "purple", "pink", "grey"]
        let page = theme.page
        return MenuCard(palette: p, width: 156, radius: 10, padding: 4) {
            Text("Page colour").font(.web(12, 500)).foregroundStyle(p.textMuted.color)
                .padding(.top, 2).padding(.horizontal, 4).padding(.bottom, 6)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(32), spacing: 4), count: 4), spacing: 4) {
                ForEach(names, id: \.self) { name in
                    Button { shell.notYet("Changing the page colour") } label: {
                        ZStack {
                            RoundedRectangle(cornerRadius: 7, style: .continuous).fill(page.tinted(name).bg.color)
                            if name == "none" {
                                Rectangle().fill(p.textMuted.color).frame(width: 2, height: 40).rotationEffect(.degrees(45))
                            }
                            RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(p.borderStrong.color, lineWidth: 1)
                        }
                        .frame(width: 32, height: 32)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: 140)
        }
    }

    private func ruleMenu(_ p: Palette) -> some View {
        MenuCard(palette: p, width: 160, radius: 10, padding: 4) {
            let items: [(String, String?)] = [("None", nil), ("Lines", "rows-3"), ("Grid", "grid-3x3")]
            ForEach(0..<items.count, id: \.self) { i in
                Button { shell.notYet("Changing rule lines") } label: {
                    HStack(spacing: 8) {
                        if let icon = items[i].1 { Icon(icon, 16, p.text2.color) } else { Color.clear.frame(width: 16, height: 16) }
                        Text(items[i].0).font(.web(14)).foregroundStyle(p.text.color)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6).padding(.horizontal, 10)
                }
                .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
            }
        }
    }
}
