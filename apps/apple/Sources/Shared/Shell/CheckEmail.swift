import SwiftUI

/// "Check your email" (src/pages/CheckEmail.tsx): shown instead of the app to a signed-in person whose address isn't
/// confirmed yet (the server refuses everything else with 403 `email_unverified`). "I've verified, continue" asks the
/// server again; "Sign out" is for a wrong address. There is no Resend: the core has no resend-verification call yet.
struct CheckEmailScreen: View {
    @Environment(SessionModel.self) private var session
    @State private var checking = false
    @State private var info: String?
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
                    Button {
                        guard !checking else { return }
                        checking = true
                        info = nil
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
    }
}
