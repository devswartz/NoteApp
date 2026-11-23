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
            if session.needsEmailCheck {
                CheckEmailScreen()
            } else if session.phase == .signedIn {
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
