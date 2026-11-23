import Foundation
import Observation
import SwiftUI

/// The pen toolbar's state (src/ink/inkTool.ts): the active tool, the pen's and the highlighter's colour and width,
/// remembered on this device. The tool itself is not remembered: a page opens ready to type.
@Observable
final class InkTool {
    static let shared = InkTool()
    /// Posted (main thread) whenever the tool, a colour or a width changes, for the UIKit canvas.
    static let changed = Notification.Name("InkTool.changed")

    enum Kind: String {
        case select, pen, highlighter, eraser, partialEraser, lasso
    }

    struct Swatch: Equatable {
        let name: String
        let hex: UInt32
    }

    /// The web's pen colours; the first is "ink", drawn light in the dark theme.
    static let penColors = [
        Swatch(name: "Black", hex: 0x1F2328), Swatch(name: "Blue", hex: 0x1D4ED8), Swatch(name: "Red", hex: 0xDC2626),
        Swatch(name: "Green", hex: 0x15803D), Swatch(name: "Purple", hex: 0x7E22CE),
    ]
    static let highlighterColors = [
        Swatch(name: "Yellow", hex: 0xFACC15), Swatch(name: "Green", hex: 0x4ADE80), Swatch(name: "Blue", hex: 0x60A5FA),
        Swatch(name: "Pink", hex: 0xF472B6),
    ]
    /// Base widths in page points at pressure 0.5.
    static let penWidths: [Float] = [1.5, 2.5, 4]
    static let highlighterWidths: [Float] = [12, 18, 26]
    static let widthNames = ["Fine", "Medium", "Thick"]
    /// The eraser's disc (page points).
    static let eraserRadius: Float = 8
    /// Highlighters are see-through (0x59).
    static let highlighterAlpha: Double = 0.35

    private(set) var kind: Kind = .select
    /// The ink bar under the ribbon is open.
    private(set) var barOpen = false
    private(set) var penColor: UInt32
    private(set) var penWidth: Float
    private(set) var highlighterColor: UInt32
    private(set) var highlighterWidth: Float
    /// A finger draws too (the web's "Draw with a finger", off by default: a finger scrolls). Remembered on this device; the
    /// iPad's. The Mac's mouse and trackpad always draw while a pen tool is chosen.
    private(set) var fingerDrawing: Bool
    /// Strokes the lasso holds, and what deletes them (set by the canvas that shows them).
    private(set) var selectionCount = 0
    @ObservationIgnored var deleteSelection: (() -> Void)?

    private init() {
        let d = UserDefaults.standard
        penColor = d.object(forKey: "ink.penColor") as? UInt32 ?? Self.penColors[0].hex
        let pw = d.object(forKey: "ink.penWidth") as? Double
        penWidth = pw.map { Float($0) } ?? Self.penWidths[1]
        highlighterColor = d.object(forKey: "ink.hlColor") as? UInt32 ?? Self.highlighterColors[0].hex
        let hw = d.object(forKey: "ink.hlWidth") as? Double
        highlighterWidth = hw.map { Float($0) } ?? Self.highlighterWidths[1]
        fingerDrawing = d.bool(forKey: "ink.finger")
    }

    /// A tool that takes the Pencil (everything but select).
    var inking: Bool { barOpen && kind != .select }

    func setKind(_ k: Kind) {
        kind = k
        if k != .lasso { selectionCount = 0 }
        post()
    }

    func toggleBar() {
        barOpen.toggle()
        if barOpen {
            if kind == .select { kind = .pen }
        } else {
            kind = .select
            selectionCount = 0
        }
        post()
    }

    func setPenColor(_ c: UInt32) { penColor = c; save(); post() }
    func setHighlighterColor(_ c: UInt32) { highlighterColor = c; save(); post() }
    func setPenWidth(_ w: Float) { penWidth = w; save(); post() }
    func setHighlighterWidth(_ w: Float) { highlighterWidth = w; save(); post() }
    func setFingerDrawing(_ on: Bool) {
        fingerDrawing = on
        UserDefaults.standard.set(on, forKey: "ink.finger")
        post()
    }
    func setSelectionCount(_ n: Int) { if selectionCount != n { selectionCount = n } }

    /// The style a new stroke gets: tool number, 0xRRGGBBAA, width (nil for tools that don't draw).
    var strokeStyle: (tool: UInt8, color: UInt32, width: Float)? {
        switch kind {
        case .pen: return (0, Self.pack(penColor, 1), penWidth)
        case .highlighter: return (1, Self.pack(highlighterColor, Self.highlighterAlpha), highlighterWidth)
        default: return nil
        }
    }

    /// `packColor`: 0xRRGGBB and an alpha to 0xRRGGBBAA.
    static func pack(_ rgb: UInt32, _ alpha: Double) -> UInt32 {
        (rgb << 8) | UInt32((min(max(alpha, 0), 1) * 255).rounded())
    }

    private func save() {
        let d = UserDefaults.standard
        d.set(penColor, forKey: "ink.penColor")
        d.set(Double(penWidth), forKey: "ink.penWidth")
        d.set(highlighterColor, forKey: "ink.hlColor")
        d.set(Double(highlighterWidth), forKey: "ink.hlWidth")
    }

    private func post() { NotificationCenter.default.post(name: Self.changed, object: nil) }
}
