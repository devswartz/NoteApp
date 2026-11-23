import SwiftUI

/// Entry point for both the iPad/iPhone and the Mac app.
@main
struct NotiveloApp: App {
    @State private var session = SessionModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .onOpenURL { url in
                    // https://app.notiveloapp.com/invite/<token> or notivelo://invite/<token>
                    let parts = ([url.host] + url.pathComponents).compactMap { $0 }.filter { $0 != "/" }
                    if let i = parts.firstIndex(where: { $0 == "invite" || $0 == "invites" }), i + 1 < parts.count {
                        session.pendingInvite = parts[i + 1]
                    }
                }
        }
        #if os(macOS)
        // The CI runner's screen is 1024x768: in corpus preview the window fits it (WindowChrome puts it at the top left).
        .defaultSize(width: UserDefaults.standard.bool(forKey: "previewSignedIn") ? 1024 : 1280,
                     height: UserDefaults.standard.bool(forKey: "previewSignedIn") ? 740 : 800)
        .windowStyle(.hiddenTitleBar)
        .commands { MacCommands() }
        #endif
    }
}
