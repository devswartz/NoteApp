import SwiftUI

/// Entry point for both the iPad/iPhone and the Mac app.
@main
struct NotiveloApp: App {
    @State private var session = SessionModel()
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                #if os(iOS)
                .onAppear { Push.openLink = { link in session.pendingLink = link } }
                // A universal link (https://app.notiveloapp.com/w/…/p/…) opened from Messages, Mail, Safari.
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    guard let url = activity.webpageURL else { return }
                    let parts = url.pathComponents.filter { $0 != "/" }
                    if let i = parts.firstIndex(where: { $0 == "invite" || $0 == "invites" }), i + 1 < parts.count {
                        session.pendingInvite = parts[i + 1]
                    } else if let link = DeepLink.parse(url) {
                        session.pendingLink = link
                    }
                }
                #endif
                .onOpenURL { url in
                    // https://app.notiveloapp.com/invite/<token> or notivelo://invite/<token>
                    let parts = ([url.host] + url.pathComponents).compactMap { $0 }.filter { $0 != "/" }
                    if let i = parts.firstIndex(where: { $0 == "invite" || $0 == "invites" }), i + 1 < parts.count {
                        session.pendingInvite = parts[i + 1]
                    } else if let link = DeepLink.parse(url) {
                        // notivelo://page/<id>, notivelo://w/<workspace>/p/<page>, the same paths on the web address.
                        session.pendingLink = link
                    }
                }
        }
        #if os(macOS)
        // A link opens in the window that is there, not in a new one.
        .handlesExternalEvents(matching: ["*"])
        // The CI runner's screen is 1024x768: in corpus preview the window fits it (WindowChrome puts it at the top left).
        .defaultSize(width: UserDefaults.standard.bool(forKey: "previewSignedIn") ? 1024 : 1280,
                     height: UserDefaults.standard.bool(forKey: "previewSignedIn") ? 740 : 800)
        .windowStyle(.hiddenTitleBar)
        .commands { MacCommands() }
        #endif
    }
}
