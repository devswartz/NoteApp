import SwiftUI

/// Placeholder sign-in screen. Nothing is sent anywhere yet: "Sign in" just shows the shell.
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
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 360)

            Button("Sign in") {
                session.signIn(email: email.isEmpty ? "preview@notivelo" : email)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)

            Text(CoreBridge.statusLine)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .padding(.top, 24)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
