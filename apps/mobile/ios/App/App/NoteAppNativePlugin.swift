import Foundation
import Capacitor

/// App-specific native bits used by src/platform/capacitor.ts.
@objc(NoteAppNativePlugin)
public class NoteAppNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NoteAppNativePlugin"
    public let jsName = "NoteAppNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingShares", returnType: CAPPluginReturnPromise),
    ]

    /// Items saved by the Share Extension since the last call.
    @objc func getPendingShares(_ call: CAPPluginCall) {
        call.resolve(["items": SharedStore.takeShares()])
    }
}
