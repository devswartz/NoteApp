import NotiveloCore
import SwiftUI

/// "Check your email" (src/pages/CheckEmail.tsx): shown instead of the app to a signed-in person whose address isn't
/// confirmed yet (the server refuses everything else with 403 `email_unverified`). "I've verified, continue" asks the
/// server again; "Resend email" sends a new link (then waits a minute, as the web does); "Sign out" is for a wrong address.
struct CheckEmailScreen: View {
    @Environment(SessionModel.self) private var session
    @State private var checking = false
    @State private var info: String?
    @State private var error: String?
    @State private var sending = false
    @State private var cooldown = 0
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        ZStack {
            p.bgSubtle.color
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .fill(PlatformColor(hex: 0x5B5BD6).color)
                            .frame(width: 34, height: 34)
                            .overlay(
                                RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Color.white).frame(width: 16, height: 16)
                                    .overlay(Icon("check", 12, PlatformColor(hex: 0x5B5BD6).color))
                            )
                            .shadowSm(p)
                        Text("Notivelo").font(.web(17, 700)).foregroundStyle(p.text.color)
                    }
                    Text("Check your email").font(.web(22, 700)).tracking(-0.44).foregroundStyle(p.text.color).padding(.top, 20)
                    (Text("We sent a confirmation link to ") + Text(session.user?.email ?? "").fontWeight(.semibold)
                        + Text(". Open it to start using Notivelo. The link works once, for 24 hours."))
                        .font(.web(13.5)).foregroundStyle(p.textMuted.color).lineSpacing(3).padding(.top, 4)
                    if let info {
                        Text(info).font(.web(12.5)).foregroundStyle(p.textMuted.color).padding(.top, 14)
                    }
                    if let error {
                        Text(error).font(.web(13)).foregroundStyle(p.danger.color).padding(.top, 14)
                    }
                    Button {
                        guard !checking else { return }
                        checking = true
                        info = nil
                        error = nil
                        session.recheckEmail { message in
                            checking = false
                            info = message
                        }
                    } label: {
                        Text(checking ? "Checking…" : "I’ve verified, continue").font(.web(15, 500)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).frame(height: 40)
                            .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    .buttonStyle(PressStyle(radius: 8, pressed: Color.black.opacity(0.1)))
                    .disabled(checking)
                    .padding(.top, 20)
                    resendButton(p)
                    HStack(spacing: 4) {
                        Text("Wrong address?").foregroundStyle(p.textMuted.color)
                        Button { session.signOut() } label: { Text("Sign out").font(.web(12.5, 500)).foregroundStyle(p.accent.color) }
                            .buttonStyle(.plain)
                    }
                    .font(.web(12.5))
                    .frame(maxWidth: .infinity)
                    .padding(.top, 20)
                }
                .padding(32)
                .frame(maxWidth: 400)
                .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(p.border.color, lineWidth: 1))
                .shadowMd(p)
                .padding(.vertical, 24).padding(.horizontal, 16)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .task(id: cooldown) {
            guard cooldown > 0 else { return }
            try? await _Concurrency.Task.sleep(nanoseconds: 1_000_000_000)
            if !_Concurrency.Task.isCancelled { cooldown -= 1 }
        }
    }

    /// "Resend email" (secondary button): a new link; "Resend email (42s)" while it waits.
    private func resendButton(_ p: Palette) -> some View {
        Button { resend() } label: {
            Text(cooldown > 0 ? "Resend email (\(cooldown)s)" : (sending ? "Sending…" : "Resend email"))
                .font(.web(15, 500)).foregroundStyle(p.text.color)
                .frame(maxWidth: .infinity).frame(height: 40)
                .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
        }
        .buttonStyle(PressStyle(radius: 8, pressed: p.bgPressed.color))
        .disabled(sending || cooldown > 0)
        .opacity(sending || cooldown > 0 ? 0.5 : 1)
        .padding(.top, 10)
    }

    private func resend() {
        sending = true
        error = nil
        info = nil
        session.call({ try $0.resendVerification() }) { result in
            sending = false
            switch result {
            case let .success(alreadyVerified):
                if alreadyVerified {
                    // Confirmed meanwhile: ask again, and the app takes over.
                    session.recheckEmail { message in info = message }
                } else {
                    info = "We sent a new link to \(session.user?.email ?? ""). Older links no longer work."
                    cooldown = Self.cooldownSeconds
                }
            case let .failure(e):
                if case let .Server(status, _, _)? = e as? CoreError, status == 429 { cooldown = Self.cooldownSeconds }
                error = SettingsMessage.text(e)
            }
        }
    }

    private static let cooldownSeconds = 60
}
