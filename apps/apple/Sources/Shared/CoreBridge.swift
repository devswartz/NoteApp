// The one place the app talks to the Rust core (nv-core, uniffi bindings) during M1.
// Until the core's XCFramework is linked (docs/rewrite/STATUS.md, "Requests between streams"), this reports "not linked".
#if canImport(NvCore)
import NvCore
#endif

enum CoreBridge {
    static var statusLine: String {
        #if canImport(NvCore)
        return "core \(coreVersion())"
        #else
        return "core not linked"
        #endif
    }
}
