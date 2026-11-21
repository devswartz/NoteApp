// The app's calls into the Rust core (nv-core, uniffi bindings in the NotiveloCore package).
import NotiveloCore

enum CoreBridge {
    /// "core 0.1.0 · page format 1": proves the binding on the placeholder screen.
    static var statusLine: String {
        "core \(coreVersion()) · page format \(pageFormatVersion())"
    }
}
