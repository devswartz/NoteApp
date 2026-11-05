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

    private static let snapshotKey = "todaySnapshot"

    /// The Today snapshot (JSON, see WidgetSnapshot in src/platform/capacitor.ts).
    static func saveSnapshot(_ json: String) {
        defaults?.set(json, forKey: snapshotKey)
    }

    static func loadSnapshot() -> TodaySnapshot? {
        guard let json = defaults?.string(forKey: snapshotKey), let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TodaySnapshot.self, from: data)
    }

    /// Returns and clears the pending items.
    static func takeShares() -> [[String: String]] {
        guard let d = defaults else { return [] }
        let list = d.array(forKey: sharesKey) as? [[String: String]] ?? []
        d.removeObject(forKey: sharesKey)
        return list
    }
}

/// Mirrors WidgetSnapshot in src/platform/capacitor.ts.
struct TodaySnapshot: Codable {
    struct Item: Codable, Identifiable {
        let id: String
        let title: String
        let overdue: Bool
        let time: String?
        let priority: Int
        let path: String
    }
    let v: Int
    let date: String
    let signedIn: Bool
    /// App lock is on: show the count only.
    let locked: Bool?
    let path: String?
    let total: Int
    let items: [Item]

    /// Deep link for an in-app path ("/w/…" → "noteapp://w/…").
    static func link(_ path: String?) -> URL? {
        guard let path, path.hasPrefix("/") else { return URL(string: "noteapp://") }
        return URL(string: "noteapp:/" + path)
    }
}
