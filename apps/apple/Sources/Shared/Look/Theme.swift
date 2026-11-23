import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// The web app's look as Swift constants (docs/rewrite/LOOK.md sections 1 and 2). Numbers are CSS px = points.

extension PlatformColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(rgb: (CGFloat((hex >> 16) & 0xFF) / 255, CGFloat((hex >> 8) & 0xFF) / 255, CGFloat(hex & 0xFF) / 255), alpha: alpha)
    }

    /// sRGB components 0…1 (UIKit's `red:green:blue:`, AppKit's `srgbRed:green:blue:`).
    convenience init(rgb: (CGFloat, CGFloat, CGFloat), alpha: CGFloat = 1) {
        #if canImport(UIKit)
        self.init(red: rgb.0, green: rgb.1, blue: rgb.2, alpha: alpha)
        #else
        self.init(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: alpha)
        #endif
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

    var color: Color {
        #if canImport(UIKit)
        Color(uiColor: self)
        #else
        Color(nsColor: self)
        #endif
    }

    /// sRGB red, green, blue, alpha.
    var rgba: (CGFloat, CGFloat, CGFloat, CGFloat) {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        #if canImport(UIKit)
        getRed(&r, green: &g, blue: &b, alpha: &a)
        #else
        (usingColorSpace(.sRGB) ?? self).getRed(&r, green: &g, blue: &b, alpha: &a)
        #endif
        return (r, g, b, a)
    }

    /// `a` over `b` at `t` (0…1 of `a`), like CSS color-mix in sRGB.
    static func mix(_ a: PlatformColor, _ t: CGFloat, _ b: PlatformColor) -> PlatformColor {
        let (r1, g1, b1, a1) = a.rgba
        let (r2, g2, b2, a2) = b.rgba
        return PlatformColor(rgb: (r1 * t + r2 * (1 - t), g1 * t + g2 * (1 - t), b1 * t + b2 * (1 - t)), alpha: a1 * t + a2 * (1 - t))
    }

    /// White or black, whichever contrasts more (avatar initials, `initialsColor`).
    var initialsColor: PlatformColor {
        let (r, g, b, _) = rgba
        func lin(_ c: CGFloat) -> CGFloat { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? .white : .black
    }
}

/// One palette (`:root` light or `[data-theme='dark']`), with the accent mixes computed.
struct Palette {
    let isDark: Bool
    var bg: PlatformColor
    var bgSubtle: PlatformColor
    let bgSidebar: PlatformColor
    let bgHover: PlatformColor
    let bgPressed: PlatformColor
    let bgElevated: PlatformColor
    let bgOverlay: PlatformColor
    let bgInverse: PlatformColor
    let border: PlatformColor
    let borderStrong: PlatformColor
    let text: PlatformColor
    let text2: PlatformColor
    var textMuted: PlatformColor
    var textPlaceholder: PlatformColor
    let textInverse: PlatformColor
    let accent: PlatformColor
    let accentSolid: PlatformColor
    let accentInverse: PlatformColor
    let danger: PlatformColor
    let success: PlatformColor
    let warn: PlatformColor
    let p1: PlatformColor
    let p2: PlatformColor
    let p3: PlatformColor
    let pageTextMuted: PlatformColor
    let pageRule: PlatformColor

    /// Selected rows: accent at 9 % (light) / 15 % (dark).
    var bgActive: PlatformColor { accent.withAlphaComponent(isDark ? 0.15 : 0.09) }
    /// Selection, active chips, mention background: accent at 10 % / 15 %.
    var accentSoft: PlatformColor { accent.withAlphaComponent(isDark ? 0.15 : 0.10) }
    var dangerSoft: PlatformColor { isDark ? PlatformColor(hex: 0xF87171, alpha: 0.12) : PlatformColor(hex: 0xDC2626, alpha: 0.08) }
    var successSoft: PlatformColor { isDark ? PlatformColor(hex: 0x4ADE80, alpha: 0.12) : PlatformColor(hex: 0x16A34A, alpha: 0.10) }
    var warnSoft: PlatformColor { isDark ? PlatformColor(hex: 0xFBBF24, alpha: 0.12) : PlatformColor(hex: 0xD97706, alpha: 0.10) }

    static let light = Palette(
        isDark: false,
        bg: PlatformColor(hex: 0xFFFFFF), bgSubtle: PlatformColor(hex: 0xF9F9FB), bgSidebar: PlatformColor(hex: 0xF7F7F8),
        bgHover: PlatformColor(hex: 0x0F0F1E, alpha: 0.05), bgPressed: PlatformColor(hex: 0x0F0F1E, alpha: 0.09),
        bgElevated: PlatformColor(hex: 0xFFFFFF), bgOverlay: PlatformColor(hex: 0x0A0A14, alpha: 0.32), bgInverse: PlatformColor(hex: 0x1F1F23),
        border: PlatformColor(hex: 0xE7E7EA), borderStrong: PlatformColor(hex: 0xD4D4D8),
        text: PlatformColor(hex: 0x1F1F23), text2: PlatformColor(hex: 0x52525B), textMuted: PlatformColor(hex: 0x686871),
        textPlaceholder: PlatformColor(hex: 0x75757F), textInverse: PlatformColor(hex: 0xFAFAFA),
        accent: PlatformColor(hex: 0x4F46E5), accentSolid: PlatformColor(hex: 0x4F46E5), accentInverse: PlatformColor(hex: 0xA5B4FC),
        danger: PlatformColor(hex: 0xDC2626), success: PlatformColor(hex: 0x16A34A), warn: PlatformColor(hex: 0xD97706),
        p1: PlatformColor(hex: 0xDC2626), p2: PlatformColor(hex: 0xEA8C00), p3: PlatformColor(hex: 0x2563EB),
        pageTextMuted: PlatformColor(hex: 0x5C5C65), pageRule: PlatformColor(rgb: (70 / 255, 110 / 255, 180 / 255), alpha: 0.15))

    static let dark = Palette(
        isDark: true,
        bg: PlatformColor(hex: 0x18181B), bgSubtle: PlatformColor(hex: 0x1D1D21), bgSidebar: PlatformColor(hex: 0x141416),
        bgHover: PlatformColor(white: 1, alpha: 0.06), bgPressed: PlatformColor(white: 1, alpha: 0.10),
        bgElevated: PlatformColor(hex: 0x232328), bgOverlay: PlatformColor(white: 0, alpha: 0.5), bgInverse: PlatformColor(hex: 0xF4F4F5),
        border: PlatformColor(hex: 0x2C2C32), borderStrong: PlatformColor(hex: 0x3A3A42),
        text: PlatformColor(hex: 0xECECEF), text2: PlatformColor(hex: 0xB4B4BC), textMuted: PlatformColor(hex: 0x9D9DA6),
        textPlaceholder: PlatformColor(hex: 0x8E8E98), textInverse: PlatformColor(hex: 0x18181B),
        accent: PlatformColor(hex: 0x8B95F9), accentSolid: PlatformColor(hex: 0x5B5BD6), accentInverse: PlatformColor(hex: 0x4F46E5),
        danger: PlatformColor(hex: 0xF87171), success: PlatformColor(hex: 0x4ADE80), warn: PlatformColor(hex: 0xFBBF24),
        p1: PlatformColor(hex: 0xF87171), p2: PlatformColor(hex: 0xFB923C), p3: PlatformColor(hex: 0x60A5FA),
        pageTextMuted: PlatformColor(hex: 0xA3A3AC), pageRule: PlatformColor(rgb: (150 / 255, 170 / 255, 220 / 255), alpha: 0.12))

    /// Hybrid's page: the light palette on `#fcfcfa`.
    static let hybridPage: Palette = {
        var p = Palette.light
        p.bg = PlatformColor(hex: 0xFCFCFA)
        p.bgSubtle = PlatformColor(hex: 0xF9F9F7)
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
        p.bg = PlatformColor(hex: isDark ? d : l)
        p.textMuted = pageTextMuted
        p.textPlaceholder = pageTextMuted
        return p
    }

    /// `--shadow-lg` (menus, popovers): the larger layer.
    var shadowLg: (color: PlatformColor, radius: CGFloat, y: CGFloat) {
        isDark ? (PlatformColor(white: 0, alpha: 0.55), 32, 24) : (PlatformColor(hex: 0x0F0F1E, alpha: 0.18), 32, 24)
    }

    /// Text colours (`--tc-*`) and highlights (`--hl-*`), src/styles/colors.css.
    func textColor(_ name: String) -> PlatformColor? {
        let t: [String: (UInt32, UInt32)] = [
            "gray": (0x6B6B74, 0xA3A3AD), "grey": (0x6B6B74, 0xA3A3AD), "red": (0xC42B2B, 0xF47C7C), "orange": (0xB4500C, 0xF5A05A),
            "yellow": (0x8C6400, 0xE9C53A), "green": (0x22783A, 0x5FCF80), "blue": (0x1F62C4, 0x6EA8F7),
            "purple": (0x7A3FD6, 0xB893F5), "pink": (0xBB2A75, 0xF07FB6),
        ]
        return t[name].map { PlatformColor(hex: isDark ? $0.1 : $0.0) }
    }

    func highlight(_ name: String?) -> PlatformColor {
        let h: [String: (UInt32, UInt32)] = [
            "gray": (0xE9E9EC, 0x3A3A41), "grey": (0xE9E9EC, 0x3A3A41), "red": (0xFDE0DE, 0x5B2727), "orange": (0xFDE6CF, 0x563318),
            "yellow": (0xFCF0B0, 0x4F4313), "green": (0xD9F2DC, 0x1F4529), "blue": (0xDBE8FD, 0x1E3A5C),
            "purple": (0xEBE2FC, 0x3C2B5E), "pink": (0xFBDEEC, 0x552240),
        ]
        let v = h[name ?? "yellow"] ?? h["yellow"]!
        return PlatformColor(hex: isDark ? v.1 : v.0)
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
    static func ui(_ size: CGFloat, _ weight: Int = 400) -> PlatformFont {
        PlatformFont.systemFont(ofSize: size, weight: uiWeight(weight))
    }

    static func uiWeight(_ w: Int) -> PlatformFont.Weight {
        switch w {
        case ..<450: return .regular
        case ..<550: return .medium
        case ..<625: return .semibold
        case ..<675: return PlatformFont.Weight(rawValue: 0.35)
        default: return .bold
        }
    }

    static func mono(_ size: CGFloat, _ weight: Int = 400) -> PlatformFont {
        PlatformFont.monospacedSystemFont(ofSize: size, weight: uiWeight(weight))
    }

    /// The system font in italic (the block menu's "Quote").
    static func italic(_ size: CGFloat) -> PlatformFont {
        #if canImport(UIKit)
        UIFont.italicSystemFont(ofSize: size)
        #else
        NSFontManager.shared.convert(NSFont.systemFont(ofSize: size), toHaveTrait: .italicFontMask)
        #endif
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
    let color: PlatformColor
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

/// Pressed feedback for the web's ghost buttons: `--bg-pressed` behind the label while pressed (on the Mac also a
/// lighter shade while the pointer is over it, the web's hover).
struct PressStyle: ButtonStyle {
    var radius: CGFloat = 6
    var pressed: Color

    func makeBody(configuration: Configuration) -> some View {
        PressBody(configuration: configuration, radius: radius, pressed: pressed)
    }
}

private struct PressBody: View {
    let configuration: ButtonStyleConfiguration
    let radius: CGFloat
    let pressed: Color
    @State private var hovering = false

    var body: some View {
        let fill: Color = configuration.isPressed ? pressed : (hovering ? pressed.opacity(0.6) : Color.clear)
        let label = configuration.label
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .contentShape(Rectangle())
        #if os(macOS)
        label.onHover { hovering = $0 }
        #else
        label
        #endif
    }
}

extension View {
    /// `--shadow-lg`: two layers where the CSS has two (CSS blur = 2× radius).
    func shadowLg(_ p: Palette) -> some View {
        Group {
            if p.isDark {
                self.shadow(color: Color.black.opacity(0.55), radius: 32, x: 0, y: 24)
            } else {
                self.shadow(color: PlatformColor(hex: 0x0F0F1E, alpha: 0.18).color, radius: 32, x: 0, y: 24)
                    .shadow(color: PlatformColor(hex: 0x0F0F1E, alpha: 0.08).color, radius: 4, x: 0, y: 2)
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
                self.shadow(color: PlatformColor(hex: 0x0F0F1E, alpha: 0.08).color, radius: 8, x: 0, y: 4)
                    .shadow(color: PlatformColor(hex: 0x0F0F1E, alpha: 0.06).color, radius: 1.5, x: 0, y: 1)
            }
        }
    }

    /// `--shadow-sm`.
    func shadowSm(_ p: Palette) -> some View {
        shadow(color: Color.black.opacity(p.isDark ? 0.3 : 0.05), radius: 1, x: 0, y: 1)
    }
}
