import Observation
import SwiftUI
import UIKit

// The web app's look as Swift constants (docs/rewrite/LOOK.md sections 1 and 2). Numbers are CSS px = points.

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }

    /// "#rrggbb" (user, notebook and section colours); grey when it can't be read.
    convenience init(css: String) {
        let s = css.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        if s.count == 6, let v = UInt32(s, radix: 16) {
            self.init(hex: v)
        } else {
            self.init(hex: 0x64748B)
        }
    }

    var color: Color { Color(uiColor: self) }

    /// `a` over `b` at `t` (0…1 of `a`), like CSS color-mix in sRGB.
    static func mix(_ a: UIColor, _ t: CGFloat, _ b: UIColor) -> UIColor {
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 * t + r2 * (1 - t), green: g1 * t + g2 * (1 - t), blue: b1 * t + b2 * (1 - t), alpha: a1 * t + a2 * (1 - t))
    }

    /// White or black, whichever contrasts more (avatar initials, `initialsColor`).
    var initialsColor: UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        func lin(_ c: CGFloat) -> CGFloat { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? .white : .black
    }
}

/// One palette (`:root` light or `[data-theme='dark']`), with the accent mixes computed.
struct Palette {
    let isDark: Bool
    var bg: UIColor
    var bgSubtle: UIColor
    let bgSidebar: UIColor
    let bgHover: UIColor
    let bgPressed: UIColor
    let bgElevated: UIColor
    let bgOverlay: UIColor
    let bgInverse: UIColor
    let border: UIColor
    let borderStrong: UIColor
    let text: UIColor
    let text2: UIColor
    var textMuted: UIColor
    var textPlaceholder: UIColor
    let textInverse: UIColor
    let accent: UIColor
    let accentSolid: UIColor
    let accentInverse: UIColor
    let danger: UIColor
    let success: UIColor
    let warn: UIColor
    let p1: UIColor
    let p2: UIColor
    let p3: UIColor
    let pageTextMuted: UIColor
    let pageRule: UIColor

    /// Selected rows: accent at 9 % (light) / 15 % (dark).
    var bgActive: UIColor { accent.withAlphaComponent(isDark ? 0.15 : 0.09) }
    /// Selection, active chips, mention background: accent at 10 % / 15 %.
    var accentSoft: UIColor { accent.withAlphaComponent(isDark ? 0.15 : 0.10) }
    var dangerSoft: UIColor { isDark ? UIColor(hex: 0xF87171, alpha: 0.12) : UIColor(hex: 0xDC2626, alpha: 0.08) }
    var successSoft: UIColor { isDark ? UIColor(hex: 0x4ADE80, alpha: 0.12) : UIColor(hex: 0x16A34A, alpha: 0.10) }
    var warnSoft: UIColor { isDark ? UIColor(hex: 0xFBBF24, alpha: 0.12) : UIColor(hex: 0xD97706, alpha: 0.10) }

    static let light = Palette(
        isDark: false,
        bg: UIColor(hex: 0xFFFFFF), bgSubtle: UIColor(hex: 0xF9F9FB), bgSidebar: UIColor(hex: 0xF7F7F8),
        bgHover: UIColor(hex: 0x0F0F1E, alpha: 0.05), bgPressed: UIColor(hex: 0x0F0F1E, alpha: 0.09),
        bgElevated: UIColor(hex: 0xFFFFFF), bgOverlay: UIColor(hex: 0x0A0A14, alpha: 0.32), bgInverse: UIColor(hex: 0x1F1F23),
        border: UIColor(hex: 0xE7E7EA), borderStrong: UIColor(hex: 0xD4D4D8),
        text: UIColor(hex: 0x1F1F23), text2: UIColor(hex: 0x52525B), textMuted: UIColor(hex: 0x686871),
        textPlaceholder: UIColor(hex: 0x75757F), textInverse: UIColor(hex: 0xFAFAFA),
        accent: UIColor(hex: 0x4F46E5), accentSolid: UIColor(hex: 0x4F46E5), accentInverse: UIColor(hex: 0xA5B4FC),
        danger: UIColor(hex: 0xDC2626), success: UIColor(hex: 0x16A34A), warn: UIColor(hex: 0xD97706),
        p1: UIColor(hex: 0xDC2626), p2: UIColor(hex: 0xEA8C00), p3: UIColor(hex: 0x2563EB),
        pageTextMuted: UIColor(hex: 0x5C5C65), pageRule: UIColor(red: 70 / 255, green: 110 / 255, blue: 180 / 255, alpha: 0.15))

    static let dark = Palette(
        isDark: true,
        bg: UIColor(hex: 0x18181B), bgSubtle: UIColor(hex: 0x1D1D21), bgSidebar: UIColor(hex: 0x141416),
        bgHover: UIColor(white: 1, alpha: 0.06), bgPressed: UIColor(white: 1, alpha: 0.10),
        bgElevated: UIColor(hex: 0x232328), bgOverlay: UIColor(white: 0, alpha: 0.5), bgInverse: UIColor(hex: 0xF4F4F5),
        border: UIColor(hex: 0x2C2C32), borderStrong: UIColor(hex: 0x3A3A42),
        text: UIColor(hex: 0xECECEF), text2: UIColor(hex: 0xB4B4BC), textMuted: UIColor(hex: 0x9D9DA6),
        textPlaceholder: UIColor(hex: 0x8E8E98), textInverse: UIColor(hex: 0x18181B),
        accent: UIColor(hex: 0x8B95F9), accentSolid: UIColor(hex: 0x5B5BD6), accentInverse: UIColor(hex: 0x4F46E5),
        danger: UIColor(hex: 0xF87171), success: UIColor(hex: 0x4ADE80), warn: UIColor(hex: 0xFBBF24),
        p1: UIColor(hex: 0xF87171), p2: UIColor(hex: 0xFB923C), p3: UIColor(hex: 0x60A5FA),
        pageTextMuted: UIColor(hex: 0xA3A3AC), pageRule: UIColor(red: 150 / 255, green: 170 / 255, blue: 220 / 255, alpha: 0.12))

    /// Hybrid's page: the light palette on `#fcfcfa`.
    static let hybridPage: Palette = {
        var p = Palette.light
        p.bg = UIColor(hex: 0xFCFCFA)
        p.bgSubtle = UIColor(hex: 0xF9F9F7)
        return p
    }()

    /// The page palette with a page colour (none, yellow, green, blue, purple, pink, grey): it
    /// replaces `--bg`, and muted text becomes `--page-text-muted`.
    func tinted(_ name: String) -> Palette {
        let tints: [String: (UInt32, UInt32)] = [
            "yellow": (0xFDF8E3, 0x221F1A), "green": (0xEFF7F0, 0x1A1F1C), "blue": (0xEEF4FB, 0x1A1D24),
            "purple": (0xF5F1FB, 0x1E1B24), "pink": (0xFCF1F5, 0x221B1F), "grey": (0xF4F4F5, 0x1F1F22),
        ]
        guard let (l, d) = tints[name] else { return self }
        var p = self
        p.bg = UIColor(hex: isDark ? d : l)
        p.textMuted = pageTextMuted
        p.textPlaceholder = pageTextMuted
        return p
    }

    /// `--shadow-lg` (menus, popovers): the larger layer.
    var shadowLg: (color: UIColor, radius: CGFloat, y: CGFloat) {
        isDark ? (UIColor(white: 0, alpha: 0.55), 32, 24) : (UIColor(hex: 0x0F0F1E, alpha: 0.18), 32, 24)
    }

    /// Text colours (`--tc-*`) and highlights (`--hl-*`), src/styles/colors.css.
    func textColor(_ name: String) -> UIColor? {
        let t: [String: (UInt32, UInt32)] = [
            "gray": (0x6B6B74, 0xA3A3AD), "grey": (0x6B6B74, 0xA3A3AD), "red": (0xC42B2B, 0xF47C7C), "orange": (0xB4500C, 0xF5A05A),
            "yellow": (0x8C6400, 0xE9C53A), "green": (0x22783A, 0x5FCF80), "blue": (0x1F62C4, 0x6EA8F7),
            "purple": (0x7A3FD6, 0xB893F5), "pink": (0xBB2A75, 0xF07FB6),
        ]
        return t[name].map { UIColor(hex: isDark ? $0.1 : $0.0) }
    }

    func highlight(_ name: String?) -> UIColor {
        let h: [String: (UInt32, UInt32)] = [
            "gray": (0xE9E9EC, 0x3A3A41), "grey": (0xE9E9EC, 0x3A3A41), "red": (0xFDE0DE, 0x5B2727), "orange": (0xFDE6CF, 0x563318),
            "yellow": (0xFCF0B0, 0x4F4313), "green": (0xD9F2DC, 0x1F4529), "blue": (0xDBE8FD, 0x1E3A5C),
            "purple": (0xEBE2FC, 0x3C2B5E), "pink": (0xFBDEEC, 0x552240),
        ]
        let v = h[name ?? "yellow"] ?? h["yellow"]!
        return UIColor(hex: isDark ? v.1 : v.0)
    }

    static let colorNames = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]
}

/// The theme preference (`src/store/ui.ts`): Hybrid until the person picks one.
enum ThemeMode: String, CaseIterable {
    case light, dark, hybrid, system

    var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    var icon: String {
        switch self {
        case .light: return "sun"
        case .dark: return "moon"
        case .hybrid: return "contrast"
        case .system: return "monitor"
        }
    }
}

/// The current palettes: `chrome` for the ribbon, rail, sidebar and menus; `page` for the note
/// page (Hybrid: dark chrome, light page).
@Observable
final class Theme {
    static let shared = Theme()

    var mode: ThemeMode {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "theme") }
    }
    /// The system's appearance (for System).
    var systemDark = false

    private init() {
        mode = ThemeMode(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .hybrid
    }

    var chrome: Palette {
        switch mode {
        case .light: return .light
        case .dark, .hybrid: return .dark
        case .system: return systemDark ? .dark : .light
        }
    }

    var page: Palette {
        switch mode {
        case .light: return .light
        case .dark: return .dark
        case .hybrid: return .hybridPage
        case .system: return systemDark ? .dark : .light
        }
    }

    var isHybrid: Bool { mode == .hybrid }
}

// MARK: Type

enum WebType {
    /// System font at a CSS weight (400, 500, 600, 650, 700).
    static func ui(_ size: CGFloat, _ weight: Int = 400) -> UIFont {
        UIFont.systemFont(ofSize: size, weight: uiWeight(weight))
    }

    static func uiWeight(_ w: Int) -> UIFont.Weight {
        switch w {
        case ..<450: return .regular
        case ..<550: return .medium
        case ..<625: return .semibold
        case ..<675: return UIFont.Weight(rawValue: 0.35)
        default: return .bold
        }
    }

    static func mono(_ size: CGFloat, _ weight: Int = 400) -> UIFont {
        UIFont.monospacedSystemFont(ofSize: size, weight: uiWeight(weight))
    }
}

extension Font {
    /// The web's `font: <weight> <size> var(--font)`.
    static func web(_ size: CGFloat, _ weight: Int = 400) -> Font {
        Font(WebType.ui(size, weight) as CTFont)
    }
}

// MARK: Icons

/// A Lucide icon from Icons.xcassets (`lucide-<name>`), drawn at `size` points in `color` (the
/// stroke scales with the size, as on the web).
struct Icon: View {
    let name: String
    var size: CGFloat = 18
    var color: Color? = nil

    init(_ name: String, _ size: CGFloat = 18, _ color: Color? = nil) {
        self.name = name
        self.size = size
        self.color = color
    }

    var body: some View {
        Image("lucide-\(name)")
            .renderingMode(.template)
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .foregroundStyle(color ?? Color.primary)
    }
}

extension UIImage {
    /// A Lucide icon as a UIImage tinted `color`, `size` points square (for TextKit attachments and CALayers).
    static func lucide(_ name: String, size: CGFloat, color: UIColor) -> UIImage? {
        guard let base = UIImage(named: "lucide-\(name)") else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format).image { _ in
            base.withTintColor(color, renderingMode: .alwaysOriginal).draw(in: CGRect(x: 0, y: 0, width: size, height: size))
        }
    }
}

// MARK: Shapes and small pieces

/// Initials as the web app shows them (first letters of the first two words, else two letters).
func initials(_ name: String) -> String {
    let words = name.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "@" }).filter { !$0.isEmpty }
    if words.count >= 2 { return (String(words[0].prefix(1)) + String(words[1].prefix(1))).uppercased() }
    return String((words.first ?? "?").prefix(2)).uppercased()
}

/// A user avatar: a circle in the user's colour with initials at 42 % of the size.
struct AvatarView: View {
    let name: String
    let color: UIColor
    var size: CGFloat = 26

    var body: some View {
        Circle()
            .fill(color.color)
            .frame(width: size, height: size)
            .overlay(
                Text(initials(name))
                    .font(.web(size * 0.42, 600))
                    .tracking(-0.02 * size * 0.42)
                    .foregroundStyle(color.initialsColor.color)
            )
    }
}

/// A rounded tile with a white initial (notebook tile, workspace logo).
struct LetterTile: View {
    let letter: String
    let fill: AnyShapeStyle
    var size: CGFloat = 22
    var radius: CGFloat = 6
    var fontSize: CGFloat = 12

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(fill)
            .frame(width: size, height: size)
            .overlay(Text(letter.prefix(1).uppercased()).font(.web(fontSize, 700)).foregroundStyle(.white))
    }
}

/// Pressed feedback for the web's ghost buttons: `--bg-pressed` behind the label while pressed.
struct PressStyle: ButtonStyle {
    var radius: CGFloat = 6
    var pressed: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? pressed : Color.clear, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .contentShape(Rectangle())
    }
}

extension View {
    /// `--shadow-lg`: two layers where the CSS has two (CSS blur = 2× radius).
    func shadowLg(_ p: Palette) -> some View {
        Group {
            if p.isDark {
                self.shadow(color: Color.black.opacity(0.55), radius: 32, x: 0, y: 24)
            } else {
                self.shadow(color: Color(uiColor: UIColor(hex: 0x0F0F1E, alpha: 0.18)), radius: 32, x: 0, y: 24)
                    .shadow(color: Color(uiColor: UIColor(hex: 0x0F0F1E, alpha: 0.08)), radius: 4, x: 0, y: 2)
            }
        }
    }

    /// `--shadow`.
    func shadowMd(_ p: Palette) -> some View {
        Group {
            if p.isDark {
                self.shadow(color: Color.black.opacity(0.4), radius: 8, x: 0, y: 4)
                    .shadow(color: Color.black.opacity(0.3), radius: 1.5, x: 0, y: 1)
            } else {
                self.shadow(color: Color(uiColor: UIColor(hex: 0x0F0F1E, alpha: 0.08)), radius: 8, x: 0, y: 4)
                    .shadow(color: Color(uiColor: UIColor(hex: 0x0F0F1E, alpha: 0.06)), radius: 1.5, x: 0, y: 1)
            }
        }
    }

    /// `--shadow-sm`.
    func shadowSm(_ p: Palette) -> some View {
        shadow(color: Color.black.opacity(p.isDark ? 0.3 : 0.05), radius: 1, x: 0, y: 1)
    }
}
