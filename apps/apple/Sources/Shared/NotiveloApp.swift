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
        .defaultSize(width: 1280, height: 800)
        .windowStyle(.hiddenTitleBar)
        .commands { MacCommands() }
        #endif
    }
}
