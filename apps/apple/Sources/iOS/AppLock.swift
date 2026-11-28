import LocalAuthentication
import Observation
import SwiftUI

// The optional app lock (src/components/shell/AppLockSettings.tsx, platform.appLock in src/platform/capacitor.ts):
// Settings > Security > This device > "Lock with Face ID". When on, the app asks to unlock when it opens and when it has
// been in the background for more than a minute (RELOCK_AFTER_MS), and a cover hides the page in the app switcher.
// Unlocking is the device's own check: Face ID or Touch ID, then the passcode.

@Observable
final class AppLock {
    static let shared = AppLock()
    static let relockAfter: TimeInterval = 60
    private static let key = "appLockEnabled"

    private(set) var enabled: Bool
    /// The lock is showing and not yet opened.
    private(set) var locked: Bool
    private(set) var error: String?
    private var checking = false
    private var leftAt: Date?

    private init() {
        let on = UserDefaults.standard.bool(forKey: Self.key)
        enabled = on
        locked = on
    }

    /// What the device offers: "Face ID", "Touch ID", "Optic ID", "Passcode", or nil when nothing is set up.
    static var method: String? {
        let context = LAContext()
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            switch context.biometryType {
            case .faceID: return "Face ID"
            case .touchID: return "Touch ID"
            case .opticID: return "Optic ID"
            default: return "Biometrics"
            }
        }
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) ? "Passcode" : nil
    }

    /// Ask the device to unlock; `done` gets whether it worked (on the main thread).
    private static func authenticate(reason: String, done: @escaping (Bool, String?) -> Void) {
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
            DispatchQueue.main.async {
                let quiet: [LAError.Code] = [.userCancel, .appCancel, .systemCancel]
                let cancelled = (error as? LAError).map { quiet.contains($0.code) } ?? false
                done(ok, ok || cancelled ? nil : error?.localizedDescription)
            }
        }
    }

    /// Turning it on asks for one successful unlock first (as the web's does).
    func setEnabled(_ on: Bool, done: @escaping (String?) -> Void) {
        guard on != enabled else { return done(nil) }
        Self.authenticate(reason: on ? "Turn on the app lock" : "Turn off the app lock") { ok, problem in
            if ok {
                self.enabled = on
                self.locked = false
                UserDefaults.standard.set(on, forKey: Self.key)
            }
            done(problem)
        }
    }

    func unlock() {
        guard enabled, locked, !checking else { return }
        checking = true
        error = nil
        Self.authenticate(reason: "Unlock Notivelo") { ok, problem in
            self.checking = false
            if ok { self.locked = false }
            self.error = problem
        }
    }

    func scene(_ phase: ScenePhase) {
        guard enabled else { return }
        switch phase {
        case .background:
            if leftAt == nil { leftAt = Date() }
        case .active:
            if let at = leftAt, Date().timeIntervalSince(at) > Self.relockAfter { locked = true }
            leftAt = nil
            if locked { unlock() }
        default:
            break
        }
    }
}

/// The cover over the app: while it is locked, and while the app is not in front (the app switcher shows it).
struct AppLockOverlay: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @State private var lock = AppLock.shared
    let theme = Theme.shared

    private var showing: Bool {
        if LookData.state == "app-lock" { return true }
        return lock.enabled && (lock.locked || scenePhase != .active)
    }

    func body(content: Content) -> some View {
        content
            .overlay {
                if showing { cover }
            }
            .onChange(of: scenePhase) { _, phase in lock.scene(phase) }
            .onAppear { if lock.locked && lock.enabled && LookData.state != "app-lock" && scenePhase == .active { lock.unlock() } }
    }

    private var cover: some View {
        let p = theme.chrome
        let method = AppLock.method ?? "Passcode"
        return ZStack {
            p.bg.color.ignoresSafeArea()
            VStack(spacing: 10) {
                Icon("lock", 30, p.textMuted.color)
                Text("Notivelo is locked").font(.web(20, 650)).foregroundStyle(p.text.color)
                Text("Unlock with \(method) to continue.").font(.web(14)).foregroundStyle(p.textMuted.color)
                if let error = lock.error {
                    Text(error).font(.web(12.5)).foregroundStyle(p.danger.color).multilineTextAlignment(.center).frame(maxWidth: 300)
                }
                Button { lock.unlock() } label: {
                    HStack(spacing: 6) {
                        Icon(method == "Face ID" ? "scan-face" : "fingerprint-pattern", 16, .white)
                        Text("Unlock").font(.web(14, 500)).foregroundStyle(.white)
                    }
                    .padding(.horizontal, 18).frame(height: 38)
                    .background(p.accentSolid.color, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
        }
    }
}
