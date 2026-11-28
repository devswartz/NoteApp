import NotiveloCore
import SwiftUI

/// A page from the Trash, opened read-only (src/pages/PageView.tsx, the `trashed` page): the page's saved document read
/// through the core (`pageDocument`, `readPage`), drawn with no editing host so nothing can be changed, under the web's banner
/// ("This page is in the Trash. It is read-only until you restore it.") with its Restore button. Restore puts the page back
/// (the server refuses with 409 while its notebook is in the Trash too, and says so) and opens it editable.
struct TrashedPageScreen: View {
    let pageId: String
    let title: String
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    @Environment(\.phoneLayout) private var phone
    @State private var snapshot: PageSnapshot?
    @State private var failed: String?
    @State private var restoring = false
    let theme = Theme.shared

    var body: some View {
        let palette = theme.page.tinted(snapshot?.info.settings.color ?? "none")
        let hybrid = theme.isHybrid && !phone
        let shape = UnevenRoundedRectangle(cornerRadii: .init(topLeading: hybrid ? 12 : 0, bottomLeading: 0, bottomTrailing: 0, topTrailing: hybrid ? 12 : 0), style: .continuous)
        VStack(spacing: 0) {
            if !phone { topBar(palette) }
            banner(palette)
            content(palette)
        }
        .background(palette.bg.color)
        .clipShape(shape)
        .background(
            shape.fill(palette.bg.color)
                .shadow(color: hybrid ? Color.black.opacity(0.45) : .clear, radius: 12, x: 0, y: 6)
                .overlay(shape.stroke(hybrid ? Color.black.opacity(0.55) : .clear, lineWidth: 1).padding(-0.5))
        )
        .padding(.top, hybrid ? 6 : 0).padding(.horizontal, hybrid ? 6 : 0)
        .onAppear(perform: load)
    }

    // MARK: Parts

    /// The page's top bar, reduced: the way back to the Trash (the page options and sharing don't apply to a trashed page).
    private func topBar(_ p: Palette) -> some View {
        HStack(spacing: 6) {
            Button { shell.showTrashList() } label: {
                HStack(spacing: 4) {
                    Icon("chevron-left", 14, p.text2.color)
                    Text("Trash").font(.web(13)).foregroundStyle(p.text2.color)
                }
                .padding(.horizontal, 6).frame(height: 28)
            }
            .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
            Spacer(minLength: 0)
        }
        .padding(.leading, 14).padding(.trailing, 16)
        .frame(height: 48)
        .background(p.bg.withAlphaComponent(0.88).color)
    }

    /// `.trash-banner`: elevated, 1 pt border, radius 8, 13 pt text, Restore (secondary) at the right.
    private func banner(_ p: Palette) -> some View {
        HStack(spacing: 10) {
            Icon("trash", 15, p.text.color)
            Text("This page is in the Trash. It is read-only until you restore it.")
                .font(.web(13)).foregroundStyle(p.text.color).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if session.canEditTree || session.preview { restoreButton(p) }
        }
        .padding(.vertical, 8).padding(.horizontal, 14)
        .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
        .padding(.horizontal, phone ? 12 : 16).padding(.top, phone ? 8 : 0).padding(.bottom, 8)
    }

    private func restoreButton(_ p: Palette) -> some View {
        Button { restore() } label: {
            Text(restoring ? "Restoring…" : "Restore").font(.web(14, 500)).foregroundStyle(p.text.color)
                .padding(.horizontal, 12).frame(height: 32)
                .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                .shadowSm(p)
        }
        .buttonStyle(.plain)
        .disabled(restoring)
        .opacity(restoring ? 0.5 : 1)
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        if let snapshot {
            PageCanvas(page: snapshot, host: nil, title: title, subline: "In the Trash", palette: p, stacked: phone)
        } else if let failed {
            Text(failed).font(.web(14)).foregroundStyle(p.textMuted.color).multilineTextAlignment(.center)
                .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Reading and restoring

    private func load() {
        guard snapshot == nil else { return }
        if let name = LookData.caseName(pageId) {
            // Corpus mode (CI screenshots): a bundled page stands in for the trashed one.
            snapshot = (try? CorpusPage.load(name))?.snapshot
            return
        }
        let id = pageId
        session.call({ core -> (Data, PageInfo) in
            let document = try core.pageDocument(pageId: id)
            return (document, try readPage(update: document))
        }) { result in
            switch result {
            case let .success((document, info)):
                snapshot = PageSnapshot(id: id, title: title, info: info, tasks: session.taskLines, pageTitles: session.pageTitles, document: document)
            case let .failure(e):
                failed = SettingsMessage.text(e) ?? "This page can’t be read."
            }
        }
    }

    private func restore() {
        guard !restoring else { return }
        if session.preview { shell.notYet("Restoring a page"); return }
        restoring = true
        let id = pageId
        session.changeTree({ core, ws in try core.restoreFromTrash(workspaceId: ws, kind: .page, id: id) }) { result in
            restoring = false
            switch result {
            case let .success(place):
                shell.say(place.map { "Restored to \($0)" } ?? "Restored")
                session.scheduleTaskRefresh()
                shell.route = .page(id)
            case let .failure(e):
                // The server's words, e.g. "Its notebook is in the Trash too. Restore the notebook first." (409).
                if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
            }
        }
    }
}

extension Shell {
    /// Open a trashed page read-only (a tap on its row in the Trash).
    func openTrashedPage(_ id: String, title: String) {
        sheet = nil
        route = .trashedPage(id, title.isEmpty ? "Untitled" : title)
    }

    /// Back from a trashed page to the Trash list.
    func showTrashList() {
        route = .notes
        sheet = .trash
    }
}
