import Foundation
import UIKit
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
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openStore", returnType: CAPPluginReturnPromise),
    ]

    /// Prints the web view (WKWebView ignores window.print()). Its print formatter lays the
    /// page out with the print stylesheet; the system sheet offers printers and saving a PDF.
    /// Resolves when the sheet closes.
    @objc func print(_ call: CAPPluginCall) {
        let jobName = call.getString("jobName") ?? "Note"
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.bridge?.webView else { return call.reject("No web view") }
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = jobName
            let controller = UIPrintInteractionController.shared
            controller.printInfo = info
            controller.printFormatter = webView.viewPrintFormatter()
            let done: UIPrintInteractionController.CompletionHandler = { _, _, error in
                if let error = error { call.reject(error.localizedDescription) } else { call.resolve() }
            }
            if UIDevice.current.userInterfaceIdiom == .pad, let view = self?.bridge?.viewController?.view {
                // iPad shows the sheet as a popover, anchored at the top centre.
                controller.present(from: CGRect(x: view.bounds.midX, y: 0, width: 1, height: 1), in: view, animated: true, completionHandler: done)
            } else {
                controller.present(animated: true, completionHandler: done)
            }
        }
    }

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

    /// Opens an App Store link in the App Store app (the update prompt, src/platform/storeUpdates.ts).
    /// Only apps.apple.com links: the web side can't use this to open arbitrary URLs.
    @objc func openStore(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              url.scheme == "https", url.host == "apps.apple.com" else { return call.reject("Not an App Store link") }
        // itms-apps:// goes straight to the App Store app; the https link is the fallback.
        var store = URLComponents(url: url, resolvingAgainstBaseURL: false)
        store?.scheme = "itms-apps"
        DispatchQueue.main.async {
            UIApplication.shared.open(store?.url ?? url, options: [:]) { ok in
                if ok { return call.resolve() }
                UIApplication.shared.open(url, options: [:]) { ok2 in ok2 ? call.resolve() : call.reject("Couldn't open the App Store") }
            }
        }
    }
}
