import NotiveloCore
import SwiftUI

// The account sections of Settings (src/pages/Settings.tsx, src/components/AccountSettings.tsx, ConnectedApps.tsx,
// notifications/NotificationSettingsPanel.tsx) on core's account calls (docs/rewrite/status/core.md, "account and settings").
// All are online only: offline, the call fails with `CoreError.Network`, the section says so and nothing changes.

enum SettingsMessage {
    /// What to tell the person about a failed account call; nil when there is nothing to say (corpus mode, session gone).
    static func text(_ error: Error) -> String? {
        if error is CancellationError { return nil }
        if case .Network? = error as? CoreError { return "You’re offline. Nothing was changed." }
        return SessionModel.plainMessage(error)
    }

    static func isOffline(_ error: Error) -> Bool {
        if case .Network? = error as? CoreError { return true }
        return false
    }
}

/// `.input` of Settings: 34 high (40 and 16 pt on phones), 1 pt `--border`, radius 8, the page background (no grey fill),
/// the accent ring when focused. `onCommit` runs on return and when the field loses focus.
struct SettingsInput: View {
    var label: String?
    @Binding var text: String
    var placeholder = ""
    var secure = false
    var readOnly = false
    var onCommit: () -> Void = {}
    @FocusState private var focused: Bool
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        VStack(alignment: .leading, spacing: 6) {
            if let label { Text(label).font(.web(12.5, 500)).foregroundStyle(p.text2.color) }
            Group {
                if readOnly {
                    Text(text).font(.web(phone ? 16 : 14)).foregroundStyle(p.text2.color).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if secure {
                    SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(p.textPlaceholder.color))
                        .font(.web(phone ? 16 : 14)).foregroundStyle(p.text.color).tint(p.accent.color)
                        .focused($focused).submitLabel(.done).onSubmit(onCommit)
                } else {
                    TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(p.textPlaceholder.color))
                        .font(.web(phone ? 16 : 14)).foregroundStyle(p.text.color).tint(p.accent.color)
                        .focused($focused).submitLabel(.done).onSubmit(onCommit)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: phone ? 40 : 34)
            .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused ? p.accent.color : p.border.color, lineWidth: 1))
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused ? p.accentSoft.color : .clear, lineWidth: 6))
        }
        .onChange(of: focused) { _, now in if !now { onCommit() } }
    }
}

/// A bordered select: the value and a chevron, same look as `SettingsInput`.
struct SettingsSelectLabel: View {
    let value: String
    var width: CGFloat?
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        HStack(spacing: 8) {
            Text(value).font(.web(phone ? 16 : 14)).foregroundStyle(p.text.color).lineLimit(1)
            Spacer(minLength: 0)
            Icon("chevron-down", 14, p.textMuted.color)
        }
        .padding(.horizontal, 10)
        .frame(width: width, height: phone ? 40 : 34)
        .frame(maxWidth: width == nil && phone ? .infinity : nil)
        .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .contentShape(Rectangle())
    }
}

struct SettingsNote: View {
    let text: String
    var error = false
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        Text(text).font(.web(12.5)).foregroundStyle((error ? p.danger : p.textMuted).color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: Profile

struct ProfileSettings: View {
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    @Environment(\.phoneLayout) private var phone
    @State private var name = ""
    @State private var nameError: String?
    @State private var colorError: String?
    @State private var saving = false
    let theme = Theme.shared

    private static let colours = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"]

    var body: some View {
        let p = theme.chrome
        let user = session.shownUser
        SettingsCard {
            let avatar = AvatarView(name: name.isEmpty ? (user?.name ?? "?") : name, color: PlatformColor(css: user?.color ?? "#6366f1"), size: 56)
            let fields = VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    SettingsInput(label: "Name", text: $name, onCommit: saveName)
                    if let nameError { SettingsNote(text: nameError, error: true) }
                }
                VStack(alignment: .leading, spacing: 6) {
                    SettingsInput(label: "Email", text: .constant(user?.email ?? ""), readOnly: true)
                    SettingsNote(text: "Your sign-in email can’t be changed yet.")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Avatar colour").font(.web(12.5, 500)).foregroundStyle(p.text2.color)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 36, maximum: 40), spacing: 6)], alignment: .leading, spacing: 6) {
                        ForEach(Self.colours, id: \.self) { c in
                            let chosen = (user?.color ?? "").lowercased() == c
                            Button { pick(c) } label: {
                                Circle().fill(PlatformColor(css: c).color).frame(width: 26, height: 26)
                                    .padding(3)
                                    .overlay(Circle().stroke(chosen ? p.text.color : Color.clear, lineWidth: 2))
                                    .frame(width: 36, height: 36)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Colour \(c)")
                        }
                    }
                    if let colorError { SettingsNote(text: colorError, error: true) }
                }
            }
            if phone {
                VStack(alignment: .leading, spacing: 16) { avatar; fields }
            } else {
                HStack(alignment: .top, spacing: 20) { avatar; fields }
            }
        }
        SettingsCard {
            SettingsRow(title: "Sign out", detail: "You’ll need your email and password to sign in again.") {
                Button {
                    session.signOut()
                } label: {
                    HStack(spacing: 6) {
                        Icon("log-out", 15, p.text.color)
                        Text("Sign out").font(.web(14, 500)).foregroundStyle(p.text.color)
                    }
                    .padding(.horizontal, 12).frame(height: 32)
                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .onAppear {
            name = user?.name ?? ""
            session.call({ try $0.profile() }) { result in
                if case let .success(u) = result { session.profileChanged(u) }
            }
        }
        .onChange(of: session.shownUser?.name) { _, new in name = new ?? "" }
    }

    private func saveName() {
        let current = session.shownUser?.name ?? ""
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == current { nameError = nil; name = current; return }
        if trimmed.isEmpty { nameError = "Name is required"; name = current; return }
        if trimmed.count > 100 { nameError = "Name must be 100 characters or fewer"; return }
        guard !saving else { return }
        saving = true
        nameError = nil
        session.call({ try $0.updateProfile(name: trimmed, color: nil) }) { result in
            saving = false
            switch result {
            case let .success(u):
                session.profileChanged(u)
                name = u.name
                shell.say("Profile updated")
            case let .failure(e):
                nameError = SettingsMessage.text(e)
                if nameError != nil { name = current }
            }
        }
    }

    private func pick(_ color: String) {
        if (session.shownUser?.color ?? "").lowercased() == color { return }
        colorError = nil
        session.call({ try $0.updateProfile(name: nil, color: color) }) { result in
            switch result {
            case let .success(u):
                session.profileChanged(u)
                shell.say("Avatar colour updated")
            case let .failure(e):
                colorError = SettingsMessage.text(e)
            }
        }
    }
}

// MARK: Password

struct PasswordCard: View {
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""
    @State private var busy = false
    @State private var error: String?
    @State private var done = false

    private var mismatch: String? {
        if !next.isEmpty && next.count < 8 { return "At least 8 characters" }
        if !confirm.isEmpty && confirm != next { return "Passwords don’t match" }
        return nil
    }

    private var ready: Bool { !current.isEmpty && next.count >= 8 && confirm == next && !busy }

    var body: some View {
        SettingsCard(title: "Password", detail: "Changing it signs you out on every other device.") {
            VStack(alignment: .leading, spacing: 14) {
                SettingsInput(label: "Current password", text: $current, secure: true, onCommit: {})
                SettingsInput(label: "New password", text: $next, secure: true, onCommit: {})
                VStack(alignment: .leading, spacing: 6) {
                    SettingsInput(label: "Confirm new password", text: $confirm, secure: true, onCommit: {})
                    if let mismatch { SettingsNote(text: mismatch, error: true) }
                }
                if let error { SettingsNote(text: error, error: true) }
                if done { SettingsNote(text: "Password changed. Other devices have been signed out, and locked pages are locked again.") }
                HStack {
                    Spacer(minLength: 0)
                    DialogButton(title: busy ? "Changing…" : "Change password", style: .primary, enabled: ready) { submit() }
                }
            }
        }
    }

    private func submit() {
        guard ready else { return }
        busy = true
        error = nil
        done = false
        let c = current, n = next
        session.changePassword(current: c, new: n) { result in
            busy = false
            switch result {
            case .success:
                current = ""; next = ""; confirm = ""
                done = true
                shell.say("Password changed. Other devices have been signed out.")
            case let .failure(e):
                if case let .Server(status, _, code)? = e as? CoreError, status == 400, code == "wrong_password" {
                    error = "Current password is incorrect."
                } else {
                    error = SettingsMessage.text(e)
                }
            }
        }
    }
}

// MARK: Notifications

struct NotificationSettingsSection: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.phoneLayout) private var phone
    @State private var settings: NotificationSettings?
    @State private var message: String?
    @State private var offline = false
    @State private var picking = false
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        Group {
            if let s = settings {
                SettingsCard(title: "Reminders", detail: "Reminders and the daily digest are sent by email.") {
                    VStack(alignment: .leading, spacing: 20) {
                        SettingsRow(title: "Email reminders", detail: "Reminders and the daily digest by email") {
                            toggle("Email reminders", s.emailEnabled) { save(email: $0) }
                        }
                        SettingsRow(title: "Default reminder time", detail: "For tasks with a date but no time") {
                            TimeMenu(value: s.defaultReminderTime, label: "Default reminder time") { save(reminder: $0) }
                        }
                        SettingsRow(title: "Time zone", detail: s.timeZone != TimeZone.current.identifier ? "This device is in \(TimeZone.current.identifier)" : "Due dates and times are read in it") {
                            Button { picking = true } label: { SettingsSelectLabel(value: s.timeZone, width: phone ? nil : 240) }
                                .buttonStyle(.plain)
                        }
                        if s.timeZone != TimeZone.current.identifier {
                            Button { save(zone: TimeZone.current.identifier) } label: {
                                Text("Use \(TimeZone.current.identifier)").font(.web(13, 500)).foregroundStyle(p.accent.color)
                            }
                            .buttonStyle(.plain)
                        }
                        SettingsRow(title: "Daily digest", detail: s.emailEnabled ? "An email listing today’s tasks" : "Turn on email reminders to get the digest") {
                            HStack(spacing: 12) {
                                if s.digestEnabled { TimeMenu(value: s.digestTime, label: "Digest time") { save(digestTime: $0) } }
                                toggle("Daily digest", s.digestEnabled && s.emailEnabled) { save(digest: $0) }
                                    .disabled(!s.emailEnabled)
                            }
                        }
                    }
                }
                .sheet(isPresented: $picking) {
                    TimeZonePicker(selected: s.timeZone) { zone in
                        picking = false
                        if zone != s.timeZone { save(zone: zone) }
                    }
                }
            } else if offline {
                SettingsCard { SettingsNote(text: "You’re offline. Notification settings load when you’re connected.") }
            } else {
                SettingsCard { SettingsNote(text: "Loading…") }
            }
            if let message { SettingsNote(text: message, error: true).padding(.bottom, 8) }
        }
        .onAppear(perform: load)
    }

    private func toggle(_ label: String, _ on: Bool, _ set: @escaping (Bool) -> Void) -> some View {
        Toggle(label, isOn: Binding(get: { on }, set: set)).labelsHidden().tint(theme.chrome.accentSolid.color)
    }

    private func load() {
        if session.preview { settings = LookData.notificationSettings; return }
        session.call({ try $0.notificationSettings() }) { result in
            switch result {
            case let .success(s): settings = s; offline = false
            case let .failure(e): offline = SettingsMessage.isOffline(e); if !offline { message = SettingsMessage.text(e) }
            }
        }
    }

    private func save(email: Bool? = nil, reminder: String? = nil, zone: String? = nil, digest: Bool? = nil, digestTime: String? = nil) {
        message = nil
        let change = NotificationSettingsChange(timeZone: zone, emailEnabled: email, defaultReminderTime: reminder, digestEnabled: digest, digestTime: digestTime)
        session.call({ try $0.updateNotificationSettings(change: change) }) { result in
            switch result {
            case let .success(s): settings = s
            case let .failure(e): message = SettingsMessage.text(e)
            }
        }
    }
}

/// `HH:mm` in quarter hours, as a bordered menu.
struct TimeMenu: View {
    let value: String
    let label: String
    let pick: (String) -> Void

    private var options: [String] {
        var list = (0..<96).map { String(format: "%02d:%02d", $0 / 4, ($0 % 4) * 15) }
        if !list.contains(value) { list.append(value); list.sort() }
        return list
    }

    var body: some View {
        Menu {
            ForEach(options, id: \.self) { t in Button(t) { pick(t) } }
        } label: {
            SettingsSelectLabel(value: value, width: 110)
        }
        #if os(macOS)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        #endif
        .fixedSize()
        .accessibilityLabel(label)
    }
}

struct TimeZonePicker: View {
    let selected: String
    let choose: (String) -> Void
    @State private var query = ""
    @FocusState private var focused: Bool
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    private static let all = TimeZone.knownTimeZoneIdentifiers.sorted()

    private var shown: [String] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "_")
        return q.isEmpty ? Self.all : Self.all.filter { $0.lowercased().contains(q) }
    }

    var body: some View {
        let p = theme.chrome
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Time zone").font(.web(17, 600)).foregroundStyle(p.text.color)
                Spacer()
                Button { choose(selected) } label: { Text("Cancel").font(.web(14, 500)).foregroundStyle(p.accent.color) }.buttonStyle(.plain)
            }
            SettingsInput(text: $query, placeholder: "Search time zones")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(shown, id: \.self) { zone in
                        Button { choose(zone) } label: {
                            HStack {
                                Text(zone).font(.web(phone ? 16 : 14)).foregroundStyle((zone == selected ? p.accent : p.text).color)
                                Spacer()
                                if zone == selected { Icon("check", 14, p.accent.color) }
                            }
                            .padding(.horizontal, 8).frame(height: phone ? 44 : 32)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if shown.isEmpty { Text("No time zone matches.").font(.web(13)).foregroundStyle(p.textMuted.color).padding(8) }
                }
            }
        }
        .padding(20)
        .background(p.bg.color)
        #if os(macOS)
        .frame(width: 360, height: 460)
        #endif
    }
}

// MARK: Connected apps

struct ConnectedAppsSection: View {
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    @State private var apps: [ConnectedApp]?
    @State private var message: String?
    @State private var offline = false
    @State private var asking: ConnectedApp?
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        Group {
            if let apps {
                if apps.isEmpty {
                    SettingsCard {
                        SettingsNote(text: "No apps are connected. When you connect an AI assistant such as ChatGPT or Claude to your account, it appears here.")
                    }
                } else {
                    SettingsCard {
                        VStack(alignment: .leading, spacing: 18) {
                            ForEach(apps, id: \.clientId) { app in row(app, p) }
                            SettingsNote(text: "App names are provided by the apps themselves. Disconnect anything you don’t recognise.")
                        }
                    }
                }
            } else if offline {
                SettingsCard { SettingsNote(text: "You’re offline. Connected apps load when you’re connected.") }
            } else {
                SettingsCard { SettingsNote(text: "Loading…") }
            }
            if let message { SettingsNote(text: message, error: true) }
        }
        .onAppear(perform: load)
        .confirmationDialog(asking.map { "Disconnect “\($0.name)”?" } ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { if let a = asking { disconnect(a) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("It loses access to your notes straight away. To use it again you’ll have to connect it again.")
        }
    }

    private func row(_ app: ConnectedApp, _ p: Palette) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Icon("plug", 18, p.textMuted.color).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(app.name).font(.web(14, 500)).foregroundStyle(p.text.color)
                if let host = Self.host(app.clientUri) { Text(host).font(.web(13)).foregroundStyle(p.textMuted.color) }
                Text(Self.scopes(app.scopes)).font(.web(13)).foregroundStyle(p.textMuted.color)
                Text("Connected \(Self.day(app.connectedAt)) · \(app.lastUsedAt.map { "Last used \(Self.day($0))" } ?? "Never used")")
                    .font(.web(13)).foregroundStyle(p.textMuted.color)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { asking = app } label: {
                Text("Disconnect").font(.web(13, 500)).foregroundStyle(p.danger.color)
                    .padding(.horizontal, 10).frame(height: 30)
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Disconnect \(app.name)")
        }
    }

    static func host(_ uri: String?) -> String? {
        guard let uri, !uri.isEmpty else { return nil }
        return URL(string: uri)?.host ?? uri
    }

    static func scopes(_ scopes: [String]) -> String {
        scopes.contains("notes:write") ? "Read notes, edit notes" : "Read notes only"
    }

    static func day(_ iso: String) -> String {
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = plain.date(from: iso) ?? fractional.date(from: iso) else { return iso }
        return date.formatted(.dateTime.day().month(.abbreviated).year())
    }

    private func load() {
        if session.preview { apps = LookData.connectedApps; return }
        session.call({ try $0.connectedApps() }) { result in
            switch result {
            case let .success(list): apps = list; offline = false
            case let .failure(e): offline = SettingsMessage.isOffline(e); if !offline { message = SettingsMessage.text(e) }
            }
        }
    }

    private func disconnect(_ app: ConnectedApp) {
        asking = nil
        message = nil
        session.call({ try $0.disconnectApp(clientId: app.clientId) }) { result in
            switch result {
            case .success:
                apps?.removeAll { $0.clientId == app.clientId }
                shell.say("\(app.name) disconnected")
            case let .failure(e):
                if case let .Server(status, _, _)? = e as? CoreError, status == 404 {
                    apps?.removeAll { $0.clientId == app.clientId }
                } else {
                    message = SettingsMessage.text(e)
                }
            }
        }
    }
}

// MARK: Keyboard shortcuts

/// The app's shortcuts: the Mac menu's (`MacCommands.swift`) and the editor's, grouped as the web's list.
struct ShortcutsSection: View {
    @Environment(\.phoneLayout) private var phone
    let theme = Theme.shared

    private struct Item: Identifiable {
        let title: String
        let keys: [String]
        var id: String { title }
    }

    private static let groups: [(String, [Item])] = [
        ("General", [
            Item(title: "Search", keys: ["⇧", "⌘", "F"]),
            Item(title: "Find", keys: ["⌘", "F"]),
            Item(title: "Settings", keys: ["⌘", ","]),
            Item(title: "Toggle sidebar", keys: ["⌃", "⌘", "S"]),
            Item(title: "Toggle ribbon", keys: ["⌥", "⌘", "R"]),
            Item(title: "Zoom in", keys: ["⌘", "+"]),
            Item(title: "Zoom out", keys: ["⌘", "-"]),
            Item(title: "Actual size", keys: ["⌘", "0"]),
            Item(title: "Keyboard shortcuts (Mac)", keys: ["⌘", "/"]),
        ]),
        ("Create", [
            Item(title: "New page", keys: ["⌘", "N"]),
            Item(title: "New section", keys: ["⇧", "⌘", "N"]),
            Item(title: "New notebook", keys: ["⌥", "⌘", "N"]),
            Item(title: "New task", keys: ["⇧", "⌘", "T"]),
        ]),
        ("Navigation", [
            Item(title: "Go to Notes", keys: ["⌘", "8"]),
            Item(title: "Go to Today", keys: ["⌘", "1"]),
            Item(title: "Go to Upcoming", keys: ["⌘", "2"]),
            Item(title: "Go to My tasks", keys: ["⌘", "3"]),
            Item(title: "Go to All tasks", keys: ["⌘", "5"]),
            Item(title: "Go to Calendar", keys: ["⌘", "6"]),
        ]),
        ("Text formatting", [
            Item(title: "Bold", keys: ["⌘", "B"]),
            Item(title: "Italic", keys: ["⌘", "I"]),
            Item(title: "Underline", keys: ["⌘", "U"]),
            Item(title: "Strikethrough", keys: ["⇧", "⌘", "X"]),
            Item(title: "Link", keys: ["⌘", "K"]),
            Item(title: "Normal text", keys: ["⌥", "⌘", "0"]),
            Item(title: "Heading 1", keys: ["⌥", "⌘", "1"]),
            Item(title: "Heading 2", keys: ["⌥", "⌘", "2"]),
            Item(title: "Heading 3", keys: ["⌥", "⌘", "3"]),
            Item(title: "Code block", keys: ["⌥", "⌘", "C"]),
            Item(title: "Indent", keys: ["⌘", "]"]),
            Item(title: "Outdent", keys: ["⌘", "["]),
        ]),
        ("In a page", [
            Item(title: "Insert block menu", keys: ["/"]),
            Item(title: "Undo", keys: ["⌘", "Z"]),
            Item(title: "Redo", keys: ["⇧", "⌘", "Z"]),
        ]),
    ]

    var body: some View {
        let p = theme.chrome
        ForEach(Self.groups, id: \.0) { group in
            SettingsCard(title: group.0) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(group.1) { item in
                        HStack(spacing: 12) {
                            Text(item.title).font(.web(phone ? 15 : 14)).foregroundStyle(p.text.color)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            HStack(spacing: 4) {
                                ForEach(Array(item.keys.enumerated()), id: \.offset) { _, k in
                                    Text(k).font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(p.text2.color)
                                        .frame(minWidth: 22).padding(.horizontal, 4).frame(height: 22)
                                        .background(p.bg.color, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(p.border.color, lineWidth: 1))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
