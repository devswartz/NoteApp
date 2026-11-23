import NotiveloCore
import SwiftUI

/// "Tasks on this page" (PageView.tsx `PageTasks`): the page panel's Tasks tab. The tasks written on the page, open ones
/// first with a "done / total" progress line, completed ones behind "Show n completed". Ticking and opening a task work
/// as in the Tasks lists; "Add task" opens quick add for this page.
struct PageTasksList: View {
    let palette: Palette
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var showDone = false

    private var pageId: String? {
        if case let .page(id) = shell.route { return id }
        return nil
    }

    private func sorted(_ list: [CoreTask]) -> [CoreTask] {
        list.sorted { a, b in
            switch (a.dueDate, b.dueDate) {
            case let (x?, y?) where x != y: return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.priority < b.priority
            }
        }
    }

    var body: some View {
        let p = palette
        let all = sorted(session.shownTasks.filter { $0.pageId == pageId && pageId != nil && !$0.locked })
        let open = all.filter { !session.isDone($0) }
        let done = all.filter { session.isDone($0) }
        VStack(spacing: 0) {
            if !all.isEmpty {
                HStack(spacing: 10) {
                    Text("\(done.count)/\(all.count) done").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                    GeometryReader { g in
                        Capsule().fill(p.bgHover.color)
                            .overlay(alignment: .leading) {
                                Capsule().fill(p.success.color).frame(width: g.size.width * CGFloat(done.count) / CGFloat(all.count))
                            }
                    }
                    .frame(height: 6)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(open, id: \.id) { t in TaskRowView(task: t) }
                    if all.isEmpty {
                        Text("No tasks yet. Type /task in the page, or select text and press ⌘↵ to turn it into a task.")
                            .font(.web(12.5)).foregroundStyle(p.textMuted.color).lineSpacing(2)
                            .padding(.horizontal, 4).padding(.vertical, 8)
                    }
                    if !done.isEmpty {
                        Button { showDone.toggle() } label: {
                            Text("\(showDone ? "Hide" : "Show") \(done.count) completed")
                                .font(.web(13, 500)).foregroundStyle(p.text2.color)
                                .padding(.horizontal, 10).frame(height: 30)
                        }
                        .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                        .padding(.top, 6)
                    }
                    if showDone {
                        ForEach(done, id: \.id) { t in TaskRowView(task: t) }
                    }
                    Button { shell.openQuickAdd(session, pageId: pageId) } label: {
                        HStack(spacing: 8) {
                            Icon("plus", 15, p.textMuted.color)
                            Text("Add task").font(.web(13.5)).foregroundStyle(p.textMuted.color)
                        }
                        .padding(.vertical, 8).padding(.horizontal, 6)
                    }
                    .buttonStyle(PressStyle(radius: 6, pressed: p.bgPressed.color))
                    .padding(.top, 4)
                }
                .padding(.horizontal, 6).padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .noEdgeEffect()
        }
    }
}
