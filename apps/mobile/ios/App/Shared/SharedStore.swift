import Foundation

/// Data shared between the app and its extensions through the App Group
/// container: items captured by the Share Extension (read by the app) and the
/// Today snapshot the app writes for the widget.
enum SharedStore {
    /// Must match the App Group in App.entitlements and the extensions' entitlements.
    static let appGroup = "group.com.devswartz.noteapp"
    private static let sharesKey = "pendingShares"

    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    /// A captured item: kind ("task" | "note"), text, url, title — all strings.
    static func appendShare(_ item: [String: String]) {
        guard let d = defaults else { return }
        var list = d.array(forKey: sharesKey) as? [[String: String]] ?? []
        list.append(item)
        d.set(Array(list.suffix(20)), forKey: sharesKey)
    }

    /// Returns and clears the pending items.
    static func takeShares() -> [[String: String]] {
        guard let d = defaults else { return [] }
        let list = d.array(forKey: sharesKey) as? [[String: String]] ?? []
        d.removeObject(forKey: sharesKey)
        return list
    }
}
