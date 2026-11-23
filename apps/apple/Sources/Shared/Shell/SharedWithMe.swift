import NotiveloCore
import SwiftUI

/// "Shared with me" (the web's `SharedWithMe`): pages other people shared with this person one by one, from any workspace.
/// Core: `sharedPages()` (loaded with the tree), `removePageShare` for the x.
struct SharedWithMeGroup: View {
    @Environment(\.phoneLayout) private var phone
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var open = true
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        if !session.preview && !session.sharedPages.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                GroupHeading(title: "Shared with me", icon: "users", open: open, plus: nil) { open.toggle() }
                if open {
                    ForEach(session.sharedPages, id: \.id) { entry in row(entry, p) }
                }
            }
        }
    }

    private func row(_ e: SharedPageEntry, _ p: Palette) -> some View {
        let active = shell.route == .page(e.id)
        return HStack(spacing: 6) {
            if let icon = e.icon, !icon.isEmpty {
                Text(icon).font(.system(size: 13)).frame(width: 14)
            } else {
                Icon("file-text", 14, p.textMuted.color)
            }
            Text(e.title.isEmpty ? "Untitled" : e.title)
                .font(.web(phone ? 15 : 14, active ? 500 : 400))
                .foregroundStyle(active ? p.accent.color : p.text2.color)
                .lineLimit(1)
            if e.workspaceId != session.workspaceId {
                Text(e.workspaceName).font(.web(11.5)).foregroundStyle(p.textMuted.color).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button { shell.leaveShare(e.id, session) } label: {
                Icon("x", 13, p.textMuted.color).frame(width: phone ? 36 : 22, height: phone ? 36 : 22)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove from Shared with me")
        }
        .padding(.leading, 26).padding(.trailing, phone ? 2 : 4)
        .frame(height: phone ? 40 : 28)
        .background(active ? p.bgActive.color : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { shell.open(page: e.id) }
    }
}
