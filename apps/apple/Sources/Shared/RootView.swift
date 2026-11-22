import SwiftUI

struct RootView: View {
    var body: some View {
        #if os(iOS)
        // iPad/iPhone: the web app's look (LOOK.md), Sources/iOS and Shared/Shell.
        NativeRoot()
        #else
        // Mac: the same look at desktop width in an AppKit window (Sources/macOS).
        MacRoot()
        #endif
    }
}
