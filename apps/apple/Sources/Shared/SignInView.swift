import SwiftUI

/// Sign in with email and password through the core. Long-press the version line to switch
/// between production and staging (hidden tester setting; the host shows when it is not production).
struct SignInView: View {
    @Environment(SessionModel.self) private var session
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "note.text")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Notivelo")
                .font(.largeTitle.bold())
            Text("Native preview")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if session.phase == .restoring {
                ProgressView("Signing in…")
                    .padding(.vertical, 40)
            } else {
                form
            }

            if session.isStaging {
                Label("Server: \(session.host)", systemImage: "server.rack")
                    .font(.footnote.bold())
                    .foregroundStyle(.orange)
            }

            Text("\(Self.versionLine) · \(CoreBridge.statusLine)")
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .padding(.top, 24)
                .onLongPressGesture(minimumDuration: 1.5) {
                    session.toggleStaging()
                }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var form: some View {
        VStack(spacing: 16) {
            VStack(spacing: 12) {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    #if os(iOS)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    #endif
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .onSubmit(signIn)
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 360)
            .disabled(session.busy)

            if let error = session.error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }

            HStack(spacing: 12) {
                Button(action: signIn) {
                    if session.busy {
                        ProgressView().frame(minWidth: 60)
                    } else {
                        Text("Sign in").frame(minWidth: 60)
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(session.busy)

                if session.canRetryRestore {
                    Button("Try again") { session.restore() }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    private func signIn() {
        guard !session.busy else { return }
        session.signIn(email: email, password: password)
    }

    /// "1.99.3 (412.3)": tells TestFlight builds apart.
    private static var versionLine: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
