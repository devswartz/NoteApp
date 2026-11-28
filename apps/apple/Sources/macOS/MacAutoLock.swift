import AppKit
import SwiftUI

/// Locked pages lock again when the Mac sleeps, its screen sleeps or locks, another person's session takes over, or the app is
/// hidden (Command-H): the Mac's "goes to the background", as on iPhone and iPad (`scenePhase == .background`; the web
/// locks the same way on mobile). Switching to another app does not lock: a desktop keeps its pages open while you work
/// elsewhere, and the 5-minute idle lock (the core's keep-alive) still applies.
struct MacAutoLock: ViewModifier {
    let session: SessionModel

    func body(content: Content) -> some View {
        content
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in session.lockNow() }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.screensDidSleepNotification)) { _ in session.lockNow() }
            .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.sessionDidResignActiveNotification)) { _ in session.lockNow() }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didHideNotification)) { _ in session.lockNow() }
    }
}
