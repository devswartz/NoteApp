import AppKit
import SwiftUI

/// The root on the Mac: sign-in or the shell, in the theme's colours, in a window with no title bar of its own (the
/// traffic lights sit over the ribbon's left). The shell is the same SwiftUI one the iPad uses (Shared/Shell), which is
/// the web app's desktop look; the window, the main menu and the keyboard are Mac-specific (MacCommands).
struct MacRoot: View {
    @Environment(SessionModel.self) private var session
    let theme = Theme.shared

    var body: some View {
        let scheme: ColorScheme? = theme.mode == .system ? nil : (theme.chrome.isDark ? .dark : .light)
        Group {
            if session.phase == .signedIn {
                AppShell()
            } else {
                SignInScreen()
            }
        }
        .frame(minWidth: 960, minHeight: 600)
        .ignoresSafeArea()
        .textFieldStyle(.plain)
        .focusEffectDisabled()
        .background(WindowChrome(background: theme.chrome.bgSidebar))
        .preferredColorScheme(scheme)
    }
}

/// Configures the hosting NSWindow: transparent title bar over the content (full-size content view), no title, dragged by
/// its background, painted in the chrome colour so there is no seam while resizing.
struct WindowChrome: NSViewRepresentable {
    let background: NSColor

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { configure(view.window) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { configure(view.window) }
    }

    private func configure(_ window: NSWindow?) {
        guard let window else { return }
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        window.isMovableByWindowBackground = true
        window.backgroundColor = background
        window.minSize = NSSize(width: 960, height: 600)
    }
}
