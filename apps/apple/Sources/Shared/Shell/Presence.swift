import SwiftUI

/// Someone else who has the page open (the web's `PagePresence`, collabPresenceModel.ts): one entry per person, even with
/// several devices.
struct PagePerson: Equatable, Identifiable {
    let id: String
    var name: String
    var color: String
    /// False when everyone with this user id is read-only here (viewers).
    var canEdit: Bool
    /// How many devices this person has the page open on.
    var sessions: Int

    /// Everyone else on the page from the core's presence states (JSON: `{"user": {id, name, color, canEdit}, …}`), sorted by name.
    static func from(states: [String], excluding me: String?) -> [PagePerson] {
        var byId: [String: PagePerson] = [:]
        for s in states {
            guard let data = s.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let user = object["user"] as? [String: Any],
                  let id = user["id"] as? String, id != me else { continue }
            let canEdit = (user["canEdit"] as? Bool) != false
            if var known = byId[id] {
                known.sessions += 1
                known.canEdit = known.canEdit || canEdit
                byId[id] = known
            } else {
                let name = (user["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Someone"
                byId[id] = PagePerson(id: id, name: name, color: (user["color"] as? String) ?? "#888888", canEdit: canEdit, sessions: 1)
            }
        }
        return byId.values.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }
}

extension Shell {
    /// Who else is on the open page: the live page's presence, or the demo people in the `presence` look state.
    func presenceList(_ session: SessionModel) -> [PagePerson] {
        if session.preview { return LookData.state == "presence" ? LookData.presence : [] }
        return openLive?.people ?? []
    }
}

/// The page bar's "who's here" (collabPresence.tsx `PresenceStack`): overlapping avatars (up to `max`, the last one "+N") that
/// open the list "On this page now".
struct PresenceStack: View {
    let people: [PagePerson]
    let max: Int
    let palette: Palette
    @Environment(Shell.self) private var shell

    var body: some View {
        let p = palette
        if !people.isEmpty {
            let shown = Array(people.prefix(people.count > max ? max - 1 : max))
            let extra = people.count - shown.count
            let label = people.count == 1 ? "\(people[0].name) is here" : "\(people.count) people are here"
            Button { shell.menu = shell.menu == .presence ? nil : .presence } label: {
                HStack(spacing: -6) {
                    ForEach(shown) { u in
                        AvatarView(name: u.name, color: PlatformColor(css: u.color), size: 24)
                            .overlay(Circle().stroke(p.bg.color, lineWidth: 2).padding(-1))
                    }
                    Text(extra > 0 ? "+\(extra)" : "\(people.count)").font(.web(10, 600)).foregroundStyle(p.text2.color)
                        .frame(width: 24, height: 24)
                        .background(p.bgSubtle.color, in: Circle())
                        .overlay(Circle().stroke(p.bg.color, lineWidth: 2).padding(-1))
                }
                .padding(.horizontal, 2).frame(height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .anchor("page-presence", shell)
        }
    }
}

/// "On this page now": who, and whether they are editing or viewing.
struct PresenceMenu: View {
    let palette: Palette
    let people: [PagePerson]

    var body: some View {
        let p = palette
        MenuCard(palette: p, width: 270) {
            MenuLabel(palette: p, text: "On this page now")
            ForEach(people) { u in
                HStack(spacing: 10) {
                    AvatarView(name: u.name, color: PlatformColor(css: u.color), size: 22)
                    Text(u.name).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                    Spacer(minLength: 8)
                    Text((u.canEdit ? "editing" : "viewing") + (u.sessions > 1 ? " · \(u.sessions) devices" : ""))
                        .font(.web(12)).foregroundStyle(p.textMuted.color)
                }
                .padding(.horizontal, 10).frame(minHeight: 32)
            }
        }
    }
}
