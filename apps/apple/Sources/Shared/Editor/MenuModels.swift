import Foundation
import CoreGraphics

/// Which addresses a tap may open: the web only follows http, https and mailto links.
enum LinkURL {
    static func openable(_ href: String) -> URL? {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }
}

/// One row of the `/`, `[[` and `@` menus (SlashMenu.tsx, PageLink.tsx, collabMentions.ts; LOOK.md 4.7).
struct MenuRow {
    let id: String
    let title: String
    var detail: String?
    /// A Lucide icon name (`lucide-<name>` in the asset catalog).
    var icon: String?
    /// A colour dot before the title (people).
    var dot: PlatformColor?
}

struct MenuContent {
    enum Kind { case slash, page, mention }
    let kind: Kind
    let rows: [MenuRow]
    let highlighted: Int?
    /// The trigger character's rect in the box's coordinates.
    let anchor: CGRect
    /// Shown when no row matches (`nil`: no row says anything).
    let emptyText: String?
}

/// Which Lucide icon the web uses (the engine says `check-square`, `code-2`; the bundled set has
/// the current names).
enum MenuIcons {
    static func name(_ engine: String) -> String {
        switch engine {
        case "check-square": return "square-check"
        case "code-2": return "code-xml"
        default: return engine
        }
    }
}
