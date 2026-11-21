import Foundation
import Observation

/// Placeholder sign-in state. M3 replaces it with the core's session (`nv-api`).
@Observable
final class SessionModel {
    /// `-previewSignedIn YES` on the command line skips the placeholder sign-in (CI screenshots).
    var email: String? = UserDefaults.standard.bool(forKey: "previewSignedIn") ? "preview@notivelo" : nil

    var isSignedIn: Bool { email != nil }

    func signIn(email: String) {
        self.email = email
    }

    func signOut() {
        email = nil
    }
}
