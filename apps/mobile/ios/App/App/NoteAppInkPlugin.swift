import Capacitor
import NvInk
import UIKit
import WebKit

/// The iPad's native pen layer (docs/PLAN_INK.md, phase I2) as a plugin for src/ink/nativeInk.ts.
/// Only on iPad, and only while the web asks for it (the `ink` flag on a canvas page). The pen
/// layer itself is NativeInkController in the NvInk package.
///
/// Methods: available, attach, layout, detach, setTool, setStrokes, updateStrokes, viewApplied, setRenderer.
/// Events: stroke {token, data}, erase {token, removed, added}, view {zoom, x, y, final},
///         tool {tool}, undo (two-finger tap), redo (three-finger tap), detached. Strokes travel as base64 blobs, one bridge crossing per stroke.
@objc(NoteAppInkPlugin)
public class NoteAppInkPlugin: CAPPlugin, CAPBridgedPlugin, NativeInkDelegate {
    public let identifier = "NoteAppInkPlugin"
    public let jsName = "NoteAppInk"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTool", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStrokes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateStrokes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "viewApplied", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRenderer", returnType: CAPPluginReturnPromise),
    ]

    private var ink: NativeInkController?

    private func controller() -> NativeInkController? {
        if let ink { return ink }
        guard let wv = bridge?.webView else { return nil }
        let c = NativeInkController(webView: wv)
        c.delegate = self
        ink = c
        return c
    }

    private func onMain(_ call: CAPPluginCall, _ body: @escaping (NativeInkController) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let c = self?.controller() else { return call.reject("No web view") }
            body(c)
        }
    }

    @objc func available(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["available": UIDevice.current.userInterfaceIdiom == .pad, "pencilKit": true])
        }
    }

    @objc func attach(_ call: CAPPluginCall) {
        guard let layout = InkLayout(call.options as? [String: Any] ?? [:]) else { return call.reject("layout is required") }
        onMain(call) { c in
            let ok = c.attach(layout)
            call.resolve(["attached": ok, "detail": c.attachDetail])
        }
    }

    @objc func layout(_ call: CAPPluginCall) {
        guard let layout = InkLayout(call.options as? [String: Any] ?? [:]) else { return call.reject("layout is required") }
        onMain(call) { c in
            c.update(layout)
            call.resolve(["attached": c.isAttached])
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.ink?.detach()
            self?.ink = nil
            call.resolve()
        }
    }

    @objc func setTool(_ call: CAPPluginCall) {
        let t = InkToolState(call.options as? [String: Any] ?? [:])
        onMain(call) { c in
            c.setTool(t)
            call.resolve()
        }
    }

    @objc func setStrokes(_ call: CAPPluginCall) {
        let items = InkWire.strokes(call.options["strokes"])
        onMain(call) { c in
            c.setStrokes(items)
            call.resolve()
        }
    }

    @objc func updateStrokes(_ call: CAPPluginCall) {
        let added = InkWire.strokes(call.options["added"])
        let removed = call.getArray("removed", String.self) ?? []
        let ack = call.getString("ack")
        onMain(call) { c in
            c.updateStrokes(added: added, removed: removed, ack: ack)
            call.resolve()
        }
    }

    @objc func viewApplied(_ call: CAPPluginCall) {
        let zoom = CGFloat(call.getDouble("zoom") ?? 1)
        onMain(call) { c in
            c.viewApplied(zoom: zoom)
            call.resolve()
        }
    }

    /// Debug: "pencilkit" swaps our renderer for PencilKit (latency comparison; its strokes aren't saved).
    @objc func setRenderer(_ call: CAPPluginCall) {
        let pk = call.getString("renderer") == "pencilkit"
        onMain(call) { c in
            c.setPencilKit(pk)
            call.resolve(["renderer": c.usesPencilKit ? "pencilkit" : "notivelo"])
        }
    }

    // MARK: NativeInkDelegate

    public func nativeInk(strokeFinished blob: Data, token: String) {
        notifyListeners("stroke", data: ["token": token, "data": blob.base64EncodedString()])
    }

    public func nativeInk(erased removed: [String], added: [Data], token: String) {
        notifyListeners("erase", data: ["token": token, "removed": removed, "added": added.map { $0.base64EncodedString() }])
    }

    public func nativeInk(viewChanged zoom: CGFloat, offset: CGPoint, final: Bool) {
        notifyListeners("view", data: ["zoom": zoom, "x": offset.x, "y": offset.y, "final": final])
    }

    public func nativeInk(toolChanged tool: String, enterDraw: Bool) {
        notifyListeners("tool", data: ["tool": tool, "enterDraw": enterDraw])
    }

    public func nativeInkUndo() {
        notifyListeners("undo", data: [:])
    }

    public func nativeInkRedo() {
        notifyListeners("redo", data: [:])
    }

    public func nativeInkDetached() {
        notifyListeners("detached", data: [:])
    }
}
