import NotiveloCore
import SwiftUI

/// "From the note" (src/components/TaskDetail.tsx NoteNotes): what is written under the task in its page (bullets,
/// checklists, subtasks), read-only, as the core's `taskNotes` Markdown, with a link that opens the page.
struct TaskNotesSection: View {
    let task: CoreTask
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var markdown = ""

    var body: some View {
        let p = palette
        let lines = markdown.components(separatedBy: "\n")
        Group {
            if task.pageId != nil, !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Icon("file-text", 15, p.text2.color)
                        Text("From the note").font(.web(13, 600)).foregroundStyle(p.text2.color)
                        Spacer(minLength: 0)
                        if let pid = task.pageId, session.shownTree?.pages.contains(where: { $0.id == pid }) == true {
                            Button {
                                shell.taskDetailId = nil
                                shell.open(page: pid)
                            } label: {
                                Text("Open page").font(.web(12.5, 500)).foregroundStyle(p.accent.color)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, raw in line(raw, p) }
                    }
                    .padding(.leading, 10).padding(.vertical, 2)
                    .overlay(alignment: .leading) { Rectangle().fill(p.border.color).frame(width: 2) }
                }
                .padding(.top, 16).padding(.bottom, 8)
            }
        }
        .task(id: "\(task.id)|\(task.updatedAt)") { await load() }
    }

    private func load() async {
        guard !session.preview else { return }
        let id = task.id
        let text: String = await withCheckedContinuation { cont in
            session.call({ try $0.taskNotes(taskId: id) }) { result in
                if case let .success(s) = result { cont.resume(returning: s) } else { cont.resume(returning: "") }
            }
        }
        guard !Task.isCancelled else { return }
        markdown = text
    }

    @ViewBuilder
    private func line(_ raw: String, _ p: Palette) -> some View {
        let indent = raw.prefix { $0 == " " }.count
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text.isEmpty {
            Color.clear.frame(height: 6)
        } else {
            let check = text.hasPrefix("- [x] ") ? true : (text.hasPrefix("- [ ] ") ? false : nil)
            let bullet = text.hasPrefix("- ") || text.hasPrefix("* ")
            let body = check != nil ? String(text.dropFirst(6)) : (bullet ? String(text.dropFirst(2)) : text)
            let marker = check == true ? "\u{2611}" : (check == false ? "\u{2610}" : (bullet ? "\u{2022}" : ""))
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if !marker.isEmpty { Text(marker).font(.web(14)).foregroundStyle(p.textMuted.color).frame(width: 14) }
                Text(inline(body))
                    .font(.web(14)).lineSpacing(3)
                    .strikethrough(check == true)
                    .foregroundStyle(check == true ? p.textMuted.color : p.text2.color)
                    .tint(p.accent.color)
            }
            .padding(.leading, CGFloat(indent / 2) * 18)
        }
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
