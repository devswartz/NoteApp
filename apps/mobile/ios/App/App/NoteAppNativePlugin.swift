import Foundation
import Capacitor
import WidgetKit

/// App-specific native bits used by src/platform/capacitor.ts.
@objc(NoteAppNativePlugin)
public class NoteAppNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NoteAppNativePlugin"
    public let jsName = "NoteAppNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingShares", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeWidgetSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setConfig", returnType: CAPPluginReturnPromise),
    ]

    /// Items saved by the Share Extension since the last call.
    @objc func getPendingShares(_ call: CAPPluginCall) {
        call.resolve(["items": SharedStore.takeShares()])
    }

    /// Stores the Today snapshot for the widget and asks WidgetKit to redraw it.
    @objc func writeWidgetSnapshot(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else { return call.reject("json is required") }
        SharedStore.saveSnapshot(json)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    /// Settings the native side may need without the web view. iOS snooze actions open the app, so nothing is stored yet.
    @objc func setConfig(_ call: CAPPluginCall) {
        call.resolve()
    }
}
