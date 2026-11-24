import Foundation
import SwiftUI

// Favourite pages, "Copy link", and deep links (notivelo://… and the web's own addresses) into the app.

// MARK: Favourites

extension Shell {
    /// Favourites are kept on this device for the account and workspace, as the web keeps them in its sidebar state.
    private func favouriteKey(_ session: SessionModel) -> String? {
        guard let user = session.shownUser?.id, let ws = session.workspaceId ?? session.shownWorkspace?.id else { return nil }
        return "\(user)|\(ws)"
    }

    /// The favourite pages of this workspace (ids, in the order they were added).
    func favouriteIds(_ session: SessionModel) -> [String] {
        guard let key = favouriteKey(session) else { return [] }
        return favourites[key] ?? []
    }

    func isFavourite(_ id: String, _ session: SessionModel) -> Bool { favouriteIds(session).contains(id) }

    func toggleFavourite(_ id: String, _ session: SessionModel) {
        menu = nil
        guard let key = favouriteKey(session) else { return }
        var list = favourites[key] ?? []
        if let i = list.firstIndex(of: id) { list.remove(at: i) } else { list.append(id) }
        favourites[key] = list
        if !session.preview { UserDefaults.standard.set(favourites, forKey: "favouritePages") }
    }

    // MARK: Copy link

    /// The page's web address (the web's `${origin}/w/${wsId}/p/${pageId}`), on the host this app is signed in to.
    func pageLink(_ id: String, _ session: SessionModel) -> String? {
        guard let ws = session.workspaceId ?? session.shownWorkspace?.id else { return nil }
        return "\(session.serverURL)/w/\(ws)/p/\(id)"
    }

    func copyPageLink(_ id: String, _ session: SessionModel) {
        menu = nil
        guard let link = pageLink(id, session) else { return }
        copyToClipboard(link)
        say("Link copied")
    }
}

// MARK: Deep links

/// Where a link into the app points (src/platform/deepLinks.ts): `notivelo://page/<id>`, `notivelo://w/<ws>/p/<page>`, and the
/// same paths on the web address (`https://app.notiveloapp.com/w/<ws>/p/<page>`, `/w/<ws>/tasks/today?task=<id>`).
struct DeepLink: Equatable {
    enum Target: Equatable {
        case page(String)
        case notes
        case tasks(String)
        case task(String)
        case settings
        case trash
    }

    var workspaceId: String?
    var target: Target

    static func parse(_ url: URL) -> DeepLink? {
        let isWeb = url.scheme == "http" || url.scheme == "https"
        var parts = url.pathComponents.filter { $0 != "/" }
        // For a custom scheme the first segment parses as the host: notivelo://page/x is host "page", path "/x".
        if !isWeb, let host = url.host { parts.insert(host, at: 0) }
        let taskId = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "task" }?.value
        guard let first = parts.first else { return nil }
        if first == "page", parts.count > 1 { return DeepLink(workspaceId: nil, target: .page(parts[1])) }
        guard first == "w", parts.count > 1 else { return nil }
        let ws = parts[1]
        let rest = Array(parts.dropFirst(2))
        switch rest.first {
        case "p" where rest.count > 1: return DeepLink(workspaceId: ws, target: .page(rest[1]))
        case "tasks":
            if let taskId { return DeepLink(workspaceId: ws, target: .task(taskId)) }
            return DeepLink(workspaceId: ws, target: .tasks(rest.count > 1 ? rest[1] : "today"))
        case "settings": return DeepLink(workspaceId: ws, target: .settings)
        case "trash": return DeepLink(workspaceId: ws, target: .trash)
        default: return DeepLink(workspaceId: ws, target: .notes)
        }
    }
}

extension Shell {
    /// Go where a link points: its workspace first (the tree is read before the page opens), then the page, task or list.
    /// Returns true once the link is handled (false: waiting for the workspace to load).
    func follow(_ link: DeepLink, _ session: SessionModel) -> Bool {
        guard session.phase == .signedIn, !session.preview else { return true }
        if let ws = link.workspaceId, ws != session.workspaceId {
            guard session.workspaces.contains(where: { $0.id == ws }) else {
                say("You don’t have access to that workspace.")
                return true
            }
            session.selectWorkspace(ws)
            return false
        }
        guard session.tree != nil else { return false }
        menu = nil
        searchOpen = false
        switch link.target {
        case let .page(id): open(page: id)
        case .notes: route = .notes
        case let .tasks(view): route = view == "calendar" ? .calendar : .tasks(TaskList(rawValue: view) ?? .today)
        case let .task(id):
            route = .tasks(.today)
            openTask(id)
        case .settings: openSettings(nil)
        case .trash: openSheet(.trash, session, "Trash")
        }
        return true
    }
}
