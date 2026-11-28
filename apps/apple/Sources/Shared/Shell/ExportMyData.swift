import NotiveloCore
import SwiftUI

/// Settings > Profile > "Your data" (src/components/WorkspaceData.tsx `ExportMyData`): a .zip of everything the person can
/// see, from the core's `exportMyData`, saved under the name the server suggests (the share sheet on iPad and iPhone, the
/// save panel on the Mac). The server's own words answer a refusal: locked notes still locked (403), too many exports (429).
struct ExportMyDataCard: View {
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var busy = false
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        SettingsCard(title: "Your data") {
            SettingsRow(title: "Export my data",
                        detail: "A .zip with your profile, every page you can open (as Markdown), files you uploaded, your tasks, your comments and your notification settings.") {
                Button { run() } label: {
                    HStack(spacing: 6) {
                        Icon("download", 15, p.text.color)
                        Text(busy ? "Exporting…" : "Export my data").font(.web(14, 500)).foregroundStyle(p.text.color)
                    }
                    .padding(.horizontal, 12).frame(height: 32)
                    .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .opacity(busy ? 0.5 : 1)
            }
        }
    }

    private func run() {
        guard !busy else { return }
        if session.preview { shell.notYet("Exporting your data"); return }
        busy = true
        session.call({ try $0.exportMyData() }) { result in
            busy = false
            switch result {
            case let .success(file): FileExport.save(data: file.bytes, filename: file.filename)
            case let .failure(e): if let message = SettingsMessage.text(e) { shell.say(message) }
            }
        }
    }
}
