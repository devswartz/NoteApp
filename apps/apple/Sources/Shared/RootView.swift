import SwiftUI

struct RootView: View {
    @Environment(SessionModel.self) private var session

    var body: some View {
        #if os(iOS)
        // iPad/iPhone: the web app's look (LOOK.md), Sources/iOS/Shell.
        NativeRoot()
        #else
        if session.phase == .signedIn {
            MainView()
        } else {
            SignInView()
        }
        #endif
    }
}
