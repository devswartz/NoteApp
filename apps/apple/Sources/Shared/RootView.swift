import SwiftUI

struct RootView: View {
    @Environment(SessionModel.self) private var session

    var body: some View {
        if session.phase == .signedIn {
            MainView()
        } else {
            SignInView()
        }
    }
}
