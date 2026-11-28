import SwiftUI

/// The rail (src/components/shell/Rail.tsx, LOOK.md 4.2): views at the top, tools at the bottom.
struct Rail: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        VStack(spacing: 4) {
            view("Notes", "book-open", active: isNotes) {
                if !isNotes { shell.route = .notes }
            }
            view("Tasks", "list-checks", active: isTasks) {
                if !isTasks { shell.route = .tasks(.today) }
            }
            view("Calendar", "calendar-days", active: isCalendar) {
                shell.route = .calendar
            }
            Spacer(minLength: 0)
            foot((shell.sidebarOpen ?? true) ? "panel-left-close" : "panel-left-open") { shell.toggleSidebar() }
            foot("search") { shell.openSearch() }
            BellButton(size: 19, box: 40, color: p.textMuted.color, ring: p.bgSidebar.color, anchorId: "rail-bell")
            Button { shell.menu = .workspace } label: {
                LetterTile(letter: session.shownWorkspace?.name ?? "W",
                           fill: AnyShapeStyle(LinearGradient(colors: [PlatformColor(hex: 0x6366F1).color, PlatformColor(hex: 0x8B5CF6).color],
                                                              startPoint: .topLeading, endPoint: .bottomTrailing)),
                           size: 28, radius: 8, fontSize: 14)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(PressStyle(radius: 9, pressed: p.bgPressed.color))
            .anchor("rail-workspace", shell)
            Button { shell.menu = .account } label: {
                AvatarView(name: session.shownUser?.name ?? "?", color: PlatformColor(css: session.shownUser?.color ?? "#6366f1"), size: 26)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(PressStyle(radius: 9, pressed: p.bgPressed.color))
            .anchor("rail-account", shell)
        }
        .padding(.vertical, 10)
        .frame(width: 64)
        .frame(maxHeight: .infinity)
        .background(p.bgSidebar.color)
        .overlay(alignment: .trailing) { Rectangle().fill(p.border.color).frame(width: 1) }
    }

    private var isTasks: Bool {
        if case .tasks = shell.route { return true }
        return false
    }

    private var isCalendar: Bool { shell.route == .calendar }

    private var isNotes: Bool {
        switch shell.route {
        case .notes, .page, .section, .trashedPage: return true
        default: return false
        }
    }

    private func view(_ label: String, _ icon: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        let p = theme.chrome
        let color = active ? p.accent.color : p.textMuted.color
        return Button(action: action) {
            VStack(spacing: 3) {
                Icon(icon, 20, color)
                Text(label).font(.web(10.5, 600)).foregroundStyle(color).lineLimit(1)
            }
            .padding(.top, 7)
            .padding(.bottom, 6)
            .frame(width: 52)
            .background(active ? p.bgActive.color : Color.clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(alignment: .leading) {
                if active {
                    GeometryReader { g in
                        UnevenRoundedRectangle(cornerRadii: .init(topLeading: 0, bottomLeading: 0, bottomTrailing: 3, topTrailing: 3))
                            .fill(p.accent.color)
                            .frame(width: 3, height: max(g.size.height - 20, 4))
                            .offset(x: -6, y: 10)
                    }
                }
            }
        }
        .buttonStyle(PressStyle(radius: 9, pressed: p.bgPressed.color))
    }

    private func foot(_ icon: String, _ action: @escaping () -> Void) -> some View {
        let p = theme.chrome
        return Button(action: action) {
            Icon(icon, 19, p.textMuted.color).frame(width: 40, height: 40)
        }
        .buttonStyle(PressStyle(radius: 9, pressed: p.bgPressed.color))
    }
}
