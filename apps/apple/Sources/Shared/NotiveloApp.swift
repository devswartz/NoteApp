import SwiftUI

/// Entry point for both the iPad/iPhone and the Mac app.
@main
struct NotiveloApp: App {
    @State private var session = SessionModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
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
