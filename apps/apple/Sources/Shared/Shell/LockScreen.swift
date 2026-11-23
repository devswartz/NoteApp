import Foundation
import NotiveloCore
import Security
import SwiftUI
#if os(iOS)
import LocalAuthentication
#endif

// Locked pages: the unlock prompt that stands in for a locked page, and Face ID for it.
// Core: `unlockLockedNotes`, `registerUnlockDevice`, `unlockLockedNotesWithDevice`, `keepLockedNotesUnlocked`, `lockLockedNotes`
// (docs/rewrite/status/core.md, "For apple: locked pages").

/// Face ID for the locked pages. After a password unlock the core hands out a device id and secret once; they are kept in the
/// keychain behind the biometric check (this device only) with a random install id. iPad/iPhone only.
enum DeviceUnlock {
    struct Credential {
        let id: String
        let secret: String
    }

    private static let service = "com.devswartz.notivelo.native.unlock"

    /// This device can check a face or finger.
    static var available: Bool {
        #if os(iOS)
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        #else
        return false
        #endif
    }

    /// Made once per install (at least 16 characters, as the server asks).
    static var installId: String {
        let key = "lockInstallId"
        if let s = UserDefaults.standard.string(forKey: key), s.count >= 16 { return s }
        let s = UUID().uuidString + UUID().uuidString
        UserDefaults.standard.set(s, forKey: key)
        return s
    }

    private static func flag(_ account: String) -> String { "lockDevice \(account)" }

    /// A secret is kept for this server (asking the keychain would show the Face ID sheet, so this is a flag).
    static func has(account: String) -> Bool { available && UserDefaults.standard.bool(forKey: flag(account)) }

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func forget(account: String) {
        SecItemDelete(query(account) as CFDictionary)
        UserDefaults.standard.removeObject(forKey: flag(account))
    }

    static func store(id: String, secret: String, account: String) {
        #if os(iOS)
        forget(account: account)
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else { return }
        var add = query(account)
        add[kSecValueData as String] = Data("\(id)\n\(secret)".utf8)
        add[kSecAttrAccessControl as String] = access
        if SecItemAdd(add as CFDictionary, nil) == errSecSuccess {
            UserDefaults.standard.set(true, forKey: flag(account))
        }
        #endif
    }

    /// Reads the secret: the system asks for Face ID. `done` runs on the main thread, with nil when it was cancelled or is gone.
    static func read(account: String, done: @escaping (Credential?) -> Void) {
        #if os(iOS)
        DispatchQueue.global(qos: .userInitiated).async {
            let context = LAContext()
            context.localizedReason = "Unlock your locked pages"
            var q = query(account)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            q[kSecUseAuthenticationContext as String] = context
            var out: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            var credential: Credential?
            if status == errSecSuccess, let data = out as? Data, let text = String(data: data, encoding: .utf8) {
                let parts = text.split(separator: "\n", maxSplits: 1).map(String.init)
                if parts.count == 2 { credential = Credential(id: parts[0], secret: parts[1]) }
            } else if status == errSecItemNotFound {
                // The face or finger set changed: the keychain dropped the item.
                forget(account: account)
            }
            DispatchQueue.main.async { done(credential) }
        }
        #else
        done(nil)
        #endif
    }
}

/// A locked page, until this sign-in unlocks the locked pages: the password (and Face ID when this device has it).
struct UnlockPrompt: View {
    let palette: Palette
    @Environment(SessionModel.self) private var session
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @State private var triedFace = false
    @FocusState private var focused: Bool
    let theme = Theme.shared

    var body: some View {
        let p = palette
        let face = DeviceUnlock.has(account: session.serverURL)
        VStack(spacing: 8) {
            Icon("lock", 28, p.textMuted.color)
            Text("Locked page").font(.web(22, 700)).foregroundStyle(p.text.color)
            Text("Enter your locked pages password to open it.")
                .font(.web(14)).foregroundStyle(p.textMuted.color).multilineTextAlignment(.center)
            DialogField(label: nil, placeholder: "Password", text: $password, secure: true, focused: $focused) { send() }
                .frame(width: 280)
                .padding(.top, 8)
            if let error {
                Text(error).font(.web(12.5)).foregroundStyle(p.danger.color).multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }
            HStack(spacing: 8) {
                if face {
                    Button { useFace() } label: {
                        HStack(spacing: 6) {
                            Icon("scan-face", 15, p.text.color)
                            Text("Face ID").font(.web(14, 500)).foregroundStyle(p.text.color)
                        }
                        .padding(.horizontal, 12).frame(height: 32)
                        .background(theme.chrome.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(theme.chrome.border.color, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                }
                DialogButton(title: "Unlock", style: .primary, enabled: !password.isEmpty && !busy) { send() }
            }
            .padding(.top, 4)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            if face && !triedFace {
                triedFace = true
                useFace()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { focused = true }
            }
        }
    }

    private func send() {
        guard !password.isEmpty, !busy else { return }
        busy = true
        error = nil
        session.unlock(password: password) { problem in
            busy = false
            if let problem {
                error = problem
                password = ""
            }
        }
    }

    private func useFace() {
        guard !busy else { return }
        busy = true
        error = nil
        session.unlockWithDevice { problem in
            busy = false
            if let problem { error = problem }
        }
    }
}
