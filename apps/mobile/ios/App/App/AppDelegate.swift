import UIKit
import UserNotifications
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        registerNotificationCategories()
        return true
    }

    /// Reminder pushes carry category REMINDER (server/reminders/apns.ts). The
    /// action identifiers are the snooze options the web app sends to
    /// POST /api/reminders/snooze (src/platform/capacitor.ts). `.foreground`
    /// opens the app so its JavaScript can make that request.
    private func registerNotificationCategories() {
        let snooze = [("10m", "Snooze 10 minutes"), ("1h", "Snooze 1 hour"), ("tomorrow", "Tomorrow morning")]
            .map { UNNotificationAction(identifier: $0.0, title: $0.1, options: [.foreground]) }
        let reminder = UNNotificationCategory(identifier: "REMINDER", actions: snooze, intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([reminder])
    }

    // APNs device token → @capacitor/push-notifications ('registration' event in JS).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // notivelo:// links and universal links (also handled by SceneDelegate on iOS 13+).
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
