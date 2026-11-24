import Foundation
import UserNotifications
#if canImport(AppKit)
import AppKit
#endif

/// The app icon's badge: how many of my open tasks are due today or overdue (what today's app counts, capacitor.ts
/// `dueTodayCount`). iOS needs the badge permission, asked once at the first sign-in; the Mac's Dock tile needs none.
enum AppBadge {
    private static var last = -1

    /// Ask for the badge permission the first time the signed-in app opens (never on every launch).
    static func askOnce() {
        #if os(iOS)
        // One prompt for alerts, sounds and the badge; once allowed, the device registers for reminder pushes.
        Push.askAndRegister()
        #endif
    }

    static func set(_ count: Int) {
        guard count != last else { return }
        last = count
        #if os(iOS)
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
        #else
        DispatchQueue.main.async { NSApp?.dockTile.badgeLabel = count > 0 ? "\(count)" : nil }
        #endif
    }
}
