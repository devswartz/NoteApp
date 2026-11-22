import SwiftUI

/// The root on iPad/iPhone: sign-in or the shell, in the theme's colours. In look mode (CI) the
/// status bar is hidden and, with `-lookLandscape YES`, the app is drawn 1180×820 turned a
/// quarter inside the portrait simulator (CI turns the screenshot back).
struct NativeRoot: View {
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let scheme: ColorScheme? = theme.mode == .system ? nil : (theme.chrome.isDark ? .dark : .light)
        LookFrame {
            if session.phase == .signedIn {
                AppShell()
            } else {
                SignInScreen()
            }
        }
        .preferredColorScheme(scheme)
    }
}

struct LookFrame<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        if LookData.landscape {
            GeometryReader { g in
                content()
                    .frame(width: g.size.height, height: g.size.width)
                    .rotationEffect(.degrees(90))
                    .position(x: g.size.width / 2, y: g.size.height / 2)
            }
            .ignoresSafeArea()
            .statusBarHidden(true)
            .persistentSystemOverlays(.hidden)
        } else if LookData.state != nil {
            content().ignoresSafeArea().statusBarHidden(true).persistentSystemOverlays(.hidden)
        } else {
            content().ignoresSafeArea(.container, edges: .bottom)
        }
    }
}

/// Sign in (src/pages/Login.tsx, LOOK.md 4.13): a card on `--bg-subtle` with an accent glow.
/// Below the card, the version line (press and hold 1.5 s to switch to staging).
struct SignInScreen: View {
    @Environment(SessionModel.self) private var session
    @Environment(\.openURL) private var openURL
    @State var email = ""
    @State var password = ""
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        GeometryReader { g in
            ZStack {
                p.bgSubtle.color
                Rectangle()
                    .fill(RadialGradient(colors: [p.accentSoft.color, p.accentSoft.withAlphaComponent(0).color], center: .center, startRadius: 0, endRadius: 600))
                    .frame(width: 1200, height: 1200)
                    .scaleEffect(x: 1, y: 0.5)
                    .position(x: g.size.width / 2, y: -0.1 * g.size.height)
                ScrollView {
                    VStack(spacing: 16) {
                        card(p)
                        footer(p)
                    }
                    .padding(.vertical, 24).padding(.horizontal, 16)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: g.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private func card(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(UIColor(hex: 0x5B5BD6).color)
                    .frame(width: 34, height: 34)
                    .overlay(
                        RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Color.white).frame(width: 16, height: 16)
                            .overlay(Icon("check", 12, UIColor(hex: 0x5B5BD6).color))
                    )
                    .shadowSm(p)
                Text("Notivelo").font(.web(17, 700)).foregroundStyle(p.text.color)
            }
            Text("Welcome back").font(.web(22, 700)).tracking(-0.44).foregroundStyle(p.text.color).padding(.top, 20)
            Text("Notes and tasks, connected — for you and your team.").font(.web(13.5)).lineLimit(1).minimumScaleFactor(0.85).foregroundStyle(p.textMuted.color).padding(.top, 4)
            if session.phase == .restoring {
                Text("Signing in…").font(.web(14)).foregroundStyle(p.textMuted.color).padding(.vertical, 40)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    field("Email", p) {
                        TextField("", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    field("Password", p) {
                        SecureField("", text: $password)
                            .textContentType(.password)
                            .onSubmit(signIn)
                    }
                    Button { open("/forgot") } label: {
                        Text("Forgot password?").font(.web(12.5, 500)).foregroundStyle(p.accent.color)
                    }
                    .buttonStyle(.plain)
                }
                .disabled(session.busy)
                .padding(.top, 24).padding(.bottom, 18)
                if let error = session.error {
                    Text(error).font(.web(13)).foregroundStyle(p.danger.color).padding(.bottom, 12)
                }
                Button(action: signIn) {
                    Text(session.busy ? "Signing in…" : "Sign in").font(.web(15, 500)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).frame(height: 40)
                        .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(PressStyle(radius: 8, pressed: Color.black.opacity(0.1)))
                .disabled(session.busy)
                if session.canRetryRestore {
                    Button { session.restore() } label: {
                        Text("Try again").font(.web(14, 500)).foregroundStyle(p.text.color)
                            .frame(maxWidth: .infinity).frame(height: 32)
                            .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 8)
                }
                HStack(spacing: 4) {
                    Text("New here?").foregroundStyle(p.textMuted.color)
                    Button { open("/signup") } label: { Text("Create an account").font(.web(12.5, 500)).foregroundStyle(p.accent.color) }
                        .buttonStyle(.plain)
                }
                .font(.web(12.5))
                .frame(maxWidth: .infinity)
                .padding(.top, 20)
                HStack(spacing: 0) {
                    Button { open("/privacy") } label: { Text("Privacy") }.buttonStyle(.plain)
                    Text(" · ")
                    Button { open("/terms") } label: { Text("Terms") }.buttonStyle(.plain)
                    Text(" · ")
                    Button { open("/support") } label: { Text("Support") }.buttonStyle(.plain)
                }
                .font(.web(12.5))
                .foregroundStyle(p.textMuted.color)
                .frame(maxWidth: .infinity)
                .padding(.top, 14)
            }
        }
        .padding(32)
        .frame(maxWidth: 400)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .shadowMd(p)
    }

    private func field<F: View>(_ label: String, _ p: Palette, @ViewBuilder _ input: () -> F) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.web(13, 500)).foregroundStyle(p.text.color)
            input()
                .font(.web(14))
                .foregroundStyle(p.text.color)
                .tint(p.text.color)
                .padding(.horizontal, 10)
                .frame(height: 40)
                .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
        }
    }

    private func footer(_ p: Palette) -> some View {
        VStack(spacing: 6) {
            if session.isStaging {
                Text("Server: \(session.host)").font(.web(12, 600)).foregroundStyle(Color.orange)
            }
            Text("Native preview · \(Self.versionLine) · \(CoreBridge.statusLine)")
                .font(.web(11.5))
                .foregroundStyle(p.textMuted.color)
                .onLongPressGesture(minimumDuration: 1.5) { session.toggleStaging() }
        }
    }

    private func open(_ path: String) {
        let base = session.serverURL
        if let url = URL(string: base + path) { openURL(url) }
    }

    private func signIn() {
        guard !session.busy else { return }
        session.signIn(email: email, password: password)
    }

    private static var versionLine: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
