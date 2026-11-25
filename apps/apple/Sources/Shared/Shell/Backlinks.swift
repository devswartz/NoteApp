import NotiveloCore
import SwiftUI

// "Linked from N pages" (src/pages/PageView.tsx `Backlinks`): the pages that link to this one with [[…]], newest edit first.
// The web lists them under the canvas; here they are a bar at the bottom of the page that opens into the list.

struct BacklinksBar: View {
    let pageId: String
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var links: [BacklinkInfo] = []
    @State private var open = LookData.state == "backlinks"

    /// The newest edit in the tree: links are looked up again when any page is saved.
    private var version: String { session.tree?.pages.map(\.updatedAt).max() ?? "" }

    var body: some View {
        let p = palette
        Group {
            if !links.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button { open.toggle() } label: {
                        HStack(spacing: 6) {
                            Icon("link-2", 13, p.textMuted.color)
                            Text("Linked from \(links.count) \(links.count == 1 ? "page" : "pages")").font(.web(12, 600)).foregroundStyle(p.textMuted.color)
                            Spacer(minLength: 0)
                            Icon(open ? "chevron-down" : "chevron-up", 13, p.textMuted.color)
                        }
                        .padding(.horizontal, 14).frame(height: 34)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if open {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(links, id: \.pageId) { l in
                                    Button { shell.open(page: l.pageId) } label: {
                                        HStack(spacing: 8) {
                                            if let icon = l.icon, !icon.isEmpty {
                                                Text(icon).font(.system(size: 13)).frame(width: 18)
                                            } else {
                                                Icon("file-text", 15, p.textMuted.color).frame(width: 18)
                                            }
                                            Text(l.title.isEmpty ? "Untitled" : l.title).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                                            Spacer(minLength: 8)
                                            Text("\(l.notebookName) › \(l.sectionName)").font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
                                                .frame(maxWidth: 220, alignment: .trailing)
                                        }
                                        .padding(.horizontal, 14).frame(minHeight: 34)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                                }
                            }
                            .padding(.bottom, 6)
                        }
                        .frame(maxHeight: 190)
                    }
                }
                .background(p.bgElevated.color)
                .overlay(alignment: .top) { Rectangle().fill(p.border.color).frame(height: 1) }
            }
        }
        .task(id: pageId + version) {
            if session.preview {
                if LookData.state == "backlinks" { links = LookData.backlinks }
                return
            }
            try? await _Concurrency.Task.sleep(nanoseconds: 300_000_000)
            if _Concurrency.Task.isCancelled { return }
            let id = pageId
            session.call({ try $0.backlinks(pageId: id) }) { result in
                if case let .success(list) = result, id == pageId { links = list }
            }
        }
    }
}

extension LookData {
    static let backlinks: [BacklinkInfo] = [
        BacklinkInfo(pageId: "corpus:blocks", title: "Weekly planning", icon: "📅", sectionName: "Planning", notebookName: "Look reference", updatedAt: ""),
        BacklinkInfo(pageId: "corpus:lists", title: "Meeting notes", icon: nil, sectionName: "Corpus", notebookName: "Look reference", updatedAt: ""),
    ]
}
