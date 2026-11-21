// The app's calls into the Rust core (nv-core, uniffi bindings in the NotiveloCore package).
//
// Name clashes: the core's `Task` and `Section` meet Swift's `Task` and SwiftUI's `Section`, so
// the app always writes `CoreTask` / `CoreSection` for the core's, and `_Concurrency.Task` /
// `SwiftUI.Section` for the others.
import Foundation
import NotiveloCore

typealias CoreTask = NotiveloCore.Task
typealias CoreSection = NotiveloCore.Section

enum CoreBridge {
    /// "core 0.1.0 · page format 1": proves the binding on the sign-in screen.
    static var statusLine: String {
        "core \(coreVersion()) · page format \(pageFormatVersion())"
    }

    /// A core error as one line for the person using the app.
    static func message(_ error: Error, signingIn: Bool = false) -> String {
        switch error as? CoreError {
        case let .Server(status, message, code)?:
            if code == "email_unverified" { return "Confirm your email address first (check your inbox), then sign in." }
            if signingIn && (status == 401 || status == 400) { return "Wrong email or password." }
            if status == 429 { return "Too many tries. Wait a minute and try again." }
            return message.isEmpty ? "The server said no (\(status))." : "\(message) (\(status))"
        case let .Network(message)?:
            return "Can't reach the server: \(message)"
        case .SignedOut?:
            return "You were signed out. Sign in again."
        case let .InvalidPage(message)?:
            return "Can't read this page: \(message)"
        case nil:
            return error.localizedDescription
        }
    }
}

extension Workspace: Identifiable {}
extension Notebook: Identifiable {}
extension CoreSection: Identifiable {}
extension PageMeta: Identifiable {}
extension CoreTask: Identifiable {}

extension Array where Element == Attr {
    private func value(_ name: String) -> AttrValue? { first { $0.name == name }?.value }

    func string(_ name: String) -> String? {
        if case let .text(v)? = value(name) { return v }
        return nil
    }

    func number(_ name: String) -> Double? {
        switch value(name) {
        case let .number(v)?: return v
        case let .text(v)?: return Double(v)
        default: return nil
        }
    }

    func bool(_ name: String) -> Bool? {
        if case let .bool(v)? = value(name) { return v }
        return nil
    }
}
