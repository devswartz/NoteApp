import Observation

/// Placeholder sign-in state. M3 replaces it with the core's session (`nv-api`).
@Observable
final class SessionModel {
    var email: String?

    var isSignedIn: Bool { email != nil }

    func signIn(email: String) {
        self.email = email
    }

    func signOut() {
        email = nil
    }
}
