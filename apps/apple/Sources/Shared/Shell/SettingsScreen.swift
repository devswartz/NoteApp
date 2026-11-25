import NotiveloCore
import SwiftUI

/// Settings (src/pages/Settings.tsx, LOOK.md 3.2, `settings.png`): a section list (a side list on wide screens, a grouped
/// list then a section on phones) and the open section's cards. Built here: Profile (name, avatar colour; Sign out),
/// Appearance (theme and accent colour, per device), Notifications, Security (locked pages), Connected apps,
/// Keyboard shortcuts and About (account sections in `SettingsAccount.swift`). The workspace sections are not built.
struct SettingsSection: Identifiable {
    let id: String
    let title: String
    let description: String
    let icon: String
    let group: String

    static let all: [SettingsSection] = [
        SettingsSection(id: "profile", title: "Profile", description: "How you appear to your team, and how you sign in.", icon: "user", group: "Account"),
        SettingsSection(id: "appearance", title: "Appearance", description: "How the app looks on this device.", icon: "palette", group: "Account"),
        SettingsSection(id: "security", title: "Security", description: "Locked notes, and locking the app on this device.", icon: "lock", group: "Account"),
        SettingsSection(id: "notifications", title: "Notifications", description: "How and when you hear about due tasks.", icon: "bell", group: "Account"),
        SettingsSection(id: "connected", title: "Connected apps", description: "AI assistants and other apps you’ve allowed to use your notes.", icon: "plug", group: "Account"),
        SettingsSection(id: "workspace", title: "General", description: "Name, role and leaving or deleting this workspace.", icon: "settings", group: "Workspace"),
        SettingsSection(id: "members", title: "Members", description: "People in this workspace, their roles and invites.", icon: "users", group: "Workspace"),
        SettingsSection(id: "teams", title: "Teams", description: "Groups of people that tasks can belong to, with subteams.", icon: "users-round", group: "Workspace"),
        SettingsSection(id: "tags", title: "Tags", description: "Labels for tasks, shared across the workspace.", icon: "tag", group: "Workspace"),
        SettingsSection(id: "activity", title: "Activity", description: "Who changed what in this workspace, newest first.", icon: "activity", group: "Workspace"),
        SettingsSection(id: "shortcuts", title: "Keyboard shortcuts", description: "For a keyboard, and the Mac’s menus.", icon: "keyboard", group: "App"),
        SettingsSection(id: "about", title: "About", description: "", icon: "info", group: "App"),
    ]
}

struct SettingsScreen: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    private var workspaceScope: Bool { shell.settingsWorkspace }
    private var groups: [String] { workspaceScope ? ["Workspace"] : ["Account", "App"] }
    private var sections: [SettingsSection] { SettingsSection.all.filter { groups.contains($0.group) } }
    private var pageTitle: String { workspaceScope ? "\(session.shownWorkspace?.name ?? "Workspace") settings" : "Settings" }

    private var current: SettingsSection? {
        let id = phone ? shell.settingsSection : (shell.settingsSection ?? sections.first?.id)
        return sections.first { $0.id == id }
    }

    var body: some View {
        let p = theme.chrome
        ScrollView {
            if phone {
                if let section = current {
                    VStack(alignment: .leading, spacing: 0) {
                        Button { shell.settingsSection = nil } label: {
                            HStack(spacing: 2) {
                                Icon("chevron-left", 18, p.accent.color)
                                Text("Settings").font(.web(15, 500)).foregroundStyle(p.accent.color)
                            }
                            .frame(height: 44)
                        }
                        .buttonStyle(.plain)
                        .padding(.leading, -6)
                        content(section, p)
                    }
                    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(pageTitle).font(.web(24, 700)).tracking(-0.48).foregroundStyle(p.text.color).padding(.bottom, 16)
                        nav(p)
                    }
                    .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack(alignment: .top, spacing: 32) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(pageTitle).font(.web(17, 600)).tracking(-0.255).foregroundStyle(p.text.color)
                            .padding(.horizontal, 8).padding(.bottom, 20)
                        nav(p)
                    }
                    .frame(width: 200)
                    if let section = current {
                        content(section, p).frame(maxWidth: 680, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 36).padding(.horizontal, 32).padding(.bottom, 60)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .noEdgeEffect()
    }

    // MARK: List

    private func nav(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: phone ? 20 : 18) {
            ForEach(groups, id: \.self) { group in
                VStack(alignment: .leading, spacing: 2) {
                    if !workspaceScope {
                        Text(group).font(.web(11.5, 500)).foregroundStyle(p.textMuted.color)
                            .padding(.horizontal, phone ? 0 : 8).padding(.bottom, 4)
                    }
                    ForEach(sections.filter { $0.group == group }) { s in
                        let active = !phone && current?.id == s.id
                        Button { shell.settingsSection = s.id } label: {
                            HStack(spacing: 10) {
                                Icon(s.icon, 16, (active ? p.accent : p.text2).color)
                                Text(s.title).font(.web(phone ? 16 : 14, active ? 500 : 400))
                                    .foregroundStyle((active ? p.accent : (phone ? p.text : p.text2)).color)
                                Spacer(minLength: 0)
                                if phone { Icon("chevron-right", 16, p.textMuted.color) }
                            }
                            .padding(.horizontal, phone ? 4 : 8).frame(height: phone ? 48 : 32)
                            .background(active ? p.bgActive.color : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            .overlay(alignment: .top) { if phone { Rectangle().fill(p.border.color).frame(height: 1) } }
                        }
                        .buttonStyle(PressStyle(radius: 7, pressed: p.bgPressed.color))
                    }
                }
            }
        }
    }

    // MARK: Section

    private func content(_ section: SettingsSection, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(section.title).font(.web(phone ? 24 : 20, 700)).tracking(-0.4).foregroundStyle(p.text.color)
                if !section.description.isEmpty {
                    Text(section.description).font(.web(14)).foregroundStyle(p.textMuted.color)
                }
            }
            .padding(.bottom, 24).padding(.top, phone ? 4 : 0)
            switch section.id {
            case "profile": ProfileSettings()
            case "appearance": AppearanceSettings()
            case "notifications": NotificationSettingsSection()
            case "security": SecuritySettings()
            case "connected": ConnectedAppsSection()
            case "shortcuts": ShortcutsSection()
            case "workspace": WorkspaceGeneralSettings()
            case "members": MembersCard(width: 0, listHeight: 360, embedded: true)
            case "teams": TeamsSettings()
            case "tags": TagsSettings()
            case "activity": ActivitySettings()
            default: AboutSettings()
            }
        }
    }
}

/// `.card`: 1 pt border, radius 12, padding 20, `--bg-elevated`.
struct SettingsCard<Content: View>: View {
    var title: String?
    var detail: String?
    @ViewBuilder let content: () -> Content
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        VStack(alignment: .leading, spacing: 0) {
            if let title { Text(title).font(.web(15, 650)).foregroundStyle(p.text.color).padding(.bottom, detail == nil ? 14 : 4) }
            if let detail {
                Text(detail).font(.web(13)).foregroundStyle(p.textMuted.color).lineSpacing(2).padding(.bottom, 16)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .padding(.bottom, 16)
    }
}

/// A row of a card: title and a line under it, and a control at the right (under it on phones).
struct SettingsRow<Control: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder let control: () -> Control
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let text = VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.web(14, 500)).foregroundStyle(p.text.color)
            if let detail {
                Text(detail).font(.web(13)).foregroundStyle(p.textMuted.color).fixedSize(horizontal: false, vertical: true)
            }
        }
        if phone {
            VStack(alignment: .leading, spacing: 10) { text; control() }
        } else {
            HStack(alignment: .center, spacing: 16) {
                text.frame(maxWidth: .infinity, alignment: .leading)
                control()
            }
        }
    }
}

struct AppearanceSettings: View {
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        SettingsCard {
            VStack(alignment: .leading, spacing: 20) {
                SettingsRow(title: "Theme",
                            detail: "“Hybrid” keeps the app dark and the page light. “System” follows your device’s light or dark setting.") {
                    HStack(spacing: 2) {
                        ForEach(ThemeMode.allCases, id: \.self) { mode in
                            let active = theme.mode == mode
                            Button { theme.mode = mode } label: {
                                HStack(spacing: 6) {
                                    Icon(mode.icon, 15, (active ? p.text : p.text2).color)
                                    Text(mode.label).font(.web(13.5, 500)).foregroundStyle((active ? p.text : p.text2).color)
                                }
                                .padding(.horizontal, 10).frame(height: 30)
                                .background(active ? p.bg.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                                .shadowSm(p)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(mode.label)
                        }
                    }
                    .padding(2)
                    .background(p.bgSubtle.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                }
                SettingsRow(title: "Accent colour", detail: "Buttons, links, selection and the highlighted item in lists.") {
                    HStack(spacing: 6) {
                        ForEach(AccentChoice.allCases, id: \.self) { a in
                            let chosen = theme.accent == a
                            Button { theme.accent = a } label: {
                                ZStack {
                                    Circle().fill(PlatformColor(hex: a.swatch).color).frame(width: 26, height: 26)
                                        .overlay(Circle().stroke(Color.black.opacity(0.12), lineWidth: 1))
                                    if chosen { Icon("check", 14, .white) }
                                }
                                .padding(3)
                                .overlay(Circle().stroke(chosen ? PlatformColor(hex: a.swatch).color : Color.clear, lineWidth: 2))
                                .frame(width: 36, height: 36)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(a.label)
                        }
                    }
                }
            }
        }
    }
}

struct SecuritySettings: View {
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let has = session.lockStatus?.hasPassword == true
        SettingsCard(title: "Locked notes",
                     detail: "Locked pages open with one password, separate from your sign-in password. They stay unlocked for 5 minutes without activity, and lock when the app goes to the background.") {
            VStack(alignment: .leading, spacing: 20) {
                SettingsRow(title: has ? "Locked pages password" : "No password yet",
                            detail: has ? "Changing it locks your other devices and removes their Face ID." : "Choose one to start locking private pages.") {
                    button(has ? "Change password…" : "Set password…", p) {
                        shell.openSheet(.lock(has ? .changePassword : .setPassword), session, "Locked pages")
                    }
                }
                if session.locksOpen {
                    SettingsRow(title: "Locked pages are open", detail: "Lock them again now.") {
                        button("Lock pages now", p) { session.lockNow() }
                    }
                }
            }
        }
    }

    private func button(_ title: String, _ p: Palette, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.web(14, 500)).foregroundStyle(p.text.color)
                .padding(.horizontal, 12).frame(height: 32)
                .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct AboutSettings: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    @Environment(\.openURL) private var openURL
    let theme = Theme.shared

    private var version: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    private var platform: String {
        #if os(macOS)
        return "Mac"
        #else
        return mainScreenSize.width <= 760 ? "iPhone" : "iPad"
        #endif
    }

    var body: some View {
        let p = theme.chrome
        SettingsCard {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Notivelo").font(.web(14, 500)).foregroundStyle(p.text.color)
                    Text("Collaborative notes with built-in task management").font(.web(13)).foregroundStyle(p.textMuted.color)
                }
                VStack(alignment: .leading, spacing: phone ? 10 : 8) {
                    row("App version", version, p)
                    row("Core", CoreBridge.statusLine, p)
                    row("Server", session.host, p)
                    row("Platform", platform, p)
                    if phone {
                        legal(p)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 16) {
                            Text("Legal").font(.web(13.5)).foregroundStyle(p.textMuted.color).frame(width: 140, alignment: .leading)
                            legal(p)
                        }
                    }
                }
            }
        }
    }

    private func row(_ label: String, _ value: String, _ p: Palette) -> some View {
        Group {
            if phone {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.web(13.5)).foregroundStyle(p.textMuted.color)
                    Text(value).font(.system(size: 13.5, design: .monospaced)).foregroundStyle(p.text.color)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(label).font(.web(13.5)).foregroundStyle(p.textMuted.color).frame(width: 140, alignment: .leading)
                    Text(value).font(.system(size: 13.5, design: .monospaced)).foregroundStyle(p.text.color)
                }
            }
        }
    }

    private func legal(_ p: Palette) -> some View {
        HStack(spacing: 6) {
            link("Privacy", "/privacy", p)
            Text("·").foregroundStyle(p.textMuted.color)
            link("Terms", "/terms", p)
            Text("·").foregroundStyle(p.textMuted.color)
            link("Support", "/support", p)
        }
        .font(.web(13.5))
    }

    private func link(_ title: String, _ path: String, _ p: Palette) -> some View {
        Button {
            if let url = URL(string: session.serverURL + path) { openURL(url) }
        } label: {
            Text(title).foregroundStyle(p.accent.color)
        }
        .buttonStyle(.plain)
    }
}

/// The Settings ribbon (`ribbon-settings.png`): Back to notes.
struct SettingsRibbon: View {
    let m: RibbonMetrics
    @Environment(Shell.self) private var shell

    var body: some View {
        RibbonButton(icon: "arrow-left", m: m) { shell.route = shell.routeBeforeSettings }
    }
}
