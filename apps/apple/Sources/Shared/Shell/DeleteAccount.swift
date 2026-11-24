import NotiveloCore
import SwiftUI

/// Settings > Profile > the web's danger zone (src/components/DeleteAccount.tsx): the card with "Delete account…".
struct DeleteAccountSettingsCard: View {
    @Environment(Shell.self) private var shell
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        SettingsCard(title: "Delete account",
                     detail: "Permanently deletes your Notivelo account. This can’t be undone, and we can’t recover it for you.") {
            Button { shell.sheet = .deleteAccount } label: {
                HStack(spacing: 6) {
                    Icon("trash", 15, p.danger.color)
                    Text("Delete account…").font(.web(14, 500)).foregroundStyle(p.danger.color)
                }
                .padding(.horizontal, 12).frame(height: 32)
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.danger.color.opacity(0.5), lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// The confirmation sheet: what is deleted, what stays, what happens to each workspace (the server's preview), then the
/// password and the red button. On success the core has signed out: the app goes back to its sign-in screen.
struct DeleteAccountCard: View {
    let width: CGFloat
    let maxBodyHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var preview: AccountDeletionPreview?
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var bodyHeight: CGFloat = 0
    @FocusState private var focused: Bool
    let theme = Theme.shared

    private func names(_ list: [DeletionWorkspace]) -> String { list.map { "“\($0.name)”" }.joined(separator: ", ") }

    private func line(_ head: String, _ rest: String, _ p: Palette) -> some View {
        var a = AttributedString(head + " ")
        a.font = .web(13, 600)
        var b = AttributedString(rest)
        b.font = .web(13)
        a.append(b)
        return Text(a).foregroundStyle(p.text2.color).fixedSize(horizontal: false, vertical: true)
    }

    var body: some View {
        let p = theme.chrome
        DialogCard(title: "Delete your account?",
                   description: "This permanently deletes your Notivelo account and everything listed below. Enter your password to confirm.",
                   width: width, close: close) {
            VStack(alignment: .leading, spacing: 12) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        line("Deleted:", "your sign-in, your private notebooks with their pages, tasks, comments and files, your private tasks, reminders, notifications and devices, and any invitations you sent or received.", p)
                        line("Stays:", "what you shared with others in workspaces that continue: pages, tasks, comments and files. They show “Deleted user” as the author, and tasks assigned to you become unassigned.", p)
                        if let preview {
                            if !preview.deletedWorkspaces.isEmpty {
                                line("Workspaces deleted for everyone", "(you own them and there is no admin to hand them to): \(names(preview.deletedWorkspaces)).", p)
                            }
                            if !preview.transferredWorkspaces.isEmpty {
                                line("Handed over:", preview.transferredWorkspaces.map { "“\($0.name)” to \($0.newOwnerName)" }.joined(separator: ", ") + ".", p)
                            }
                            if !preview.sharedOwnership.isEmpty {
                                line("Other owners carry on:", names(preview.sharedOwnership) + ".", p)
                            }
                            if !preview.leftWorkspaces.isEmpty {
                                line("You leave:", names(preview.leftWorkspaces) + ".", p)
                            }
                            if preview.privateNotebooks > 0 {
                                line("Private notebooks deleted with their contents:", "\(preview.privateNotebooks).", p)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(GeometryReader { g in
                        Color.clear
                            .onAppear { bodyHeight = g.size.height }
                            .onChange(of: g.size.height) { _, h in bodyHeight = h }
                    })
                }
                .frame(height: min(max(bodyHeight, 20), maxBodyHeight))
                DialogField(label: "Password", placeholder: "", text: $password, secure: true, focused: $focused) { submit() }
                if let error { SheetNote(text: error, danger: true) }
            }
        } foot: {
            DialogButton(title: "Cancel", enabled: !busy) { close() }
            DialogButton(title: busy ? "Deleting…" : "Delete my account", style: .danger, enabled: !password.isEmpty && !busy) { submit() }
        }
        .onAppear {
            if session.preview {
                preview = AccountDeletionPreview(
                    deletedWorkspaces: [DeletionWorkspace(id: "demos-space", name: "Demo’s Space")],
                    transferredWorkspaces: [TransferredWorkspace(id: "demo-team", name: "Demo Team", newOwnerName: "Ana Silva")],
                    sharedOwnership: [],
                    leftWorkspaces: [DeletionWorkspace(id: "product", name: "Product")],
                    privateNotebooks: 1)
                return
            }
            session.call({ try $0.accountDeletionPreview() }) { result in
                if case let .success(p) = result { preview = p }
            }
        }
    }

    private func close() {
        if !busy { shell.sheet = nil }
    }

    private func submit() {
        guard !password.isEmpty, !busy else { return }
        if session.preview { error = "Corpus mode has no account to delete."; return }
        busy = true
        error = nil
        let pw = password
        session.deleteAccount(password: pw) { result in
            busy = false
            guard case let .failure(e) = result, !(e is CancellationError) else { return }
            if case let .Server(status, _, code)? = e as? CoreError, status == 401, code == "wrong_password" {
                error = "Current password is incorrect."
            } else {
                error = SettingsMessage.text(e) ?? SessionModel.plainMessage(e)
            }
        }
    }
}
