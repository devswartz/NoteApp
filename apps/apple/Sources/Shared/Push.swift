import Foundation
#if os(iOS)
import NotiveloCore
import UIKit
import UserNotifications

/// Reminder pushes (iOS only): the device token goes to the server after sign-in, the REMINDER category carries the
/// snooze actions, a tap opens the task. The Mac gets no push.
enum Push {
    static let tokenKey = "pushDeviceToken"
    /// The hex token APNs gave this install (kept so it can be sent again after a sign-in and removed at sign-out).
    static var token: String? { UserDefaults.standard.string(forKey: tokenKey) }
    /// Set by the app once the session exists; a link from a tapped push that arrived earlier waits here.
    static var openLink: ((DeepLink) -> Void)? {
        didSet { if let link = pendingLink, let open = openLink { pendingLink = nil; open(link) } }
    }
    private static var pendingLink: DeepLink?

    static func open(_ path: String) {
        guard let url = URL(string: SessionModel.production + path), let link = DeepLink.parse(url) else { return }
        if let open = openLink { open(link) } else { pendingLink = link }
    }

    static func registerCategories() {
        let actions = [("10m", "Snooze 10 minutes"), ("1h", "Snooze 1 hour"), ("tomorrow", "Tomorrow morning")]
            .map { UNNotificationAction(identifier: $0.0, title: $0.1, options: []) }
        let reminder = UNNotificationCategory(identifier: "REMINDER", actions: actions, intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([reminder])
    }

    /// Ask for alert, sound and badge once (the badge prompt is part of it), then register with APNs. Without the
    /// permission nothing is registered.
    static func askAndRegister() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    if granted { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
                }
            case .authorized, .provisional, .ephemeral:
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            default: break
            }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Push.registerCategories()
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: Push.tokenKey)
        NotificationCenter.default.post(name: .pushTokenChanged, object: nil)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    /// A reminder that arrives while the app is in front still shows as a banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        if action == UNNotificationDefaultActionIdentifier {
            if let path = info["url"] as? String { DispatchQueue.main.async { Push.open(path) } }
            completionHandler()
        } else if let token = info["snoozeToken"] as? String, ["10m", "1h", "tomorrow"].contains(action) {
            // The snooze token is the credential: no sign-in is needed, the app need not open.
            let server = UserDefaults.standard.bool(forKey: "useStaging") ? SessionModel.staging : SessionModel.production
            var task: UIBackgroundTaskIdentifier = .invalid
            task = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(task) }
            DispatchQueue.global(qos: .userInitiated).async {
                _ = try? Core(serverUrl: server).snoozeReminder(snoozeToken: token, option: action)
                DispatchQueue.main.async {
                    if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
                    completionHandler()
                }
            }
        } else {
            completionHandler()
        }
    }
}

#endif

extension Notification.Name {
    static let pushTokenChanged = Notification.Name("pushTokenChanged")
}
