#if os(iOS)
import SwiftUI

/// The Draw button at the right of the page ribbon: opens and closes the ink bar.
struct DrawToggle: View {
    let m: RibbonMetrics
    private let ink = InkTool.shared

    var body: some View {
        RibbonButton(icon: "pen", m: m, pressed: ink.barOpen) { ink.toggleBar() }
            .accessibilityLabel("Draw")
            .accessibilityIdentifier("ink-draw")
    }
}

/// The pen toolbar (src/ink/InkToolbar.tsx) as a second ribbon row on the iPad: select, pen, highlighter, stroke eraser,
/// partial eraser, lasso; for the pen and highlighter the web's colours and three widths. The Pencil draws; a finger
/// scrolls and zooms the page.
struct InkBar: View {
    let m: RibbonMetrics
    private let ink = InkTool.shared
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let hl = ink.kind == .highlighter
        let drawing = ink.kind == .pen || hl
        HStack(spacing: m.gap) {
            tool("mouse-pointer-2", .select, "Select and type")
            tool("pen", .pen, "Pen")
            tool("highlighter", .highlighter, "Highlighter")
            tool("eraser", .eraser, "Eraser (whole strokes)")
            tool("slice", .partialEraser, "Partial eraser")
            tool("lasso", .lasso, "Lasso: select, move and delete strokes")
            if drawing {
                RibbonSeparator(m: m)
                ForEach(hl ? InkTool.highlighterColors : InkTool.penColors, id: \.hex) { swatch in
                    let on = (hl ? ink.highlighterColor : ink.penColor) == swatch.hex
                    Button { if hl { ink.setHighlighterColor(swatch.hex) } else { ink.setPenColor(swatch.hex) } } label: {
                        Circle().fill(Self.color(swatch.hex)).frame(width: 18, height: 18)
                            .overlay(Circle().stroke(Color.primary.opacity(0.15), lineWidth: 1))
                            .padding(3)
                            .overlay(Circle().stroke(on ? p.accent.color : Color.clear, lineWidth: 2))
                            .frame(minWidth: m.minWidth).frame(height: m.height)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .accessibilityLabel(swatch.name)
                }
                RibbonSeparator(m: m)
                let widths = hl ? InkTool.highlighterWidths : InkTool.penWidths
                ForEach(Array(widths.enumerated()), id: \.offset) { i, w in
                    let on = (hl ? ink.highlighterWidth : ink.penWidth) == w
                    Button { if hl { ink.setHighlighterWidth(w) } else { ink.setPenWidth(w) } } label: {
                        let d = CGFloat(4 + i * 4)
                        Circle().fill(on ? p.accent.color : p.text2.color).frame(width: d, height: d)
                            .frame(minWidth: m.minWidth).frame(height: m.height)
                            .background(on ? p.accentSoft.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .accessibilityLabel(InkTool.widthNames[i])
                }
            }
            if ink.kind == .lasso && ink.selectionCount > 0 {
                RibbonSeparator(m: m)
                RibbonButton(icon: "trash", m: m) { ink.deleteSelection?() }
                    .accessibilityLabel("Delete selected strokes")
            }
            Spacer(minLength: 0)
            RibbonButton(icon: "x", m: m) { ink.toggleBar() }
                .accessibilityLabel("Close pen tools")
        }
        .padding(.leading, m.padLeft).padding(.trailing, m.padRight)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
    }

    private func tool(_ icon: String, _ kind: InkTool.Kind, _ label: String) -> some View {
        RibbonButton(icon: icon, m: m, pressed: ink.kind == kind) { ink.setKind(kind) }
            .accessibilityLabel(label)
    }

    static func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}
#endif
