import SwiftUI

/// The shell: sidebar (task views, and for now the page-format corpus as sample pages) and a detail area.
struct MainView: View {
    @Environment(SessionModel.self) private var session
    @State private var selection: SidebarItem? = CorpusPage.caseNames.first.map(SidebarItem.page) ?? .today

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection)
                .toolbar {
                    ToolbarItem {
                        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                            session.signOut()
                        }
                    }
                }
        } detail: {
            switch selection {
            case let .page(name):
                PageScreen(name: name)
            case let item?:
                ContentUnavailableView(item.title, systemImage: item.symbol,
                                       description: Text("Coming in the native rewrite."))
            case nil:
                ContentUnavailableView("Pick something", systemImage: "sidebar.left")
            }
        }
    }
}

enum SidebarItem: Hashable, Identifiable {
    case today, myTasks, upcoming, calendar
    case page(String)

    var id: Self { self }

    var title: String {
        switch self {
        case .today: "Today"
        case .myTasks: "My Tasks"
        case .upcoming: "Upcoming"
        case .calendar: "Calendar"
        case let .page(name): name
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.max"
        case .myTasks: "person.crop.circle"
        case .upcoming: "calendar.badge.clock"
        case .calendar: "calendar"
        case .page: "doc.text"
        }
    }
}

struct SidebarView: View {
    @Binding var selection: SidebarItem?

    var body: some View {
        List(selection: $selection) {
            Section("Tasks") {
                ForEach([SidebarItem.today, .myTasks, .upcoming, .calendar]) { item in
                    Label(item.title, systemImage: item.symbol).tag(item)
                }
            }
            Section("Sample pages (corpus)") {
                ForEach(CorpusPage.caseNames, id: \.self) { name in
                    Label(name, systemImage: "doc.text").tag(SidebarItem.page(name))
                }
            }
        }
        .navigationTitle("Notivelo")
    }
}

/// One page, read through the core. iPad/iPhone: the native canvas. Mac: the core's Markdown for now (M6).
struct PageScreen: View {
    let name: String

    var body: some View {
        switch Result(catching: { try CorpusPage.load(name) }) {
        case let .success(page):
            content(page)
                .navigationTitle(page.title)
        case let .failure(error):
            ContentUnavailableView("Can't open this page", systemImage: "exclamationmark.triangle",
                                   description: Text(String(describing: error)))
        }
    }

    @ViewBuilder
    private func content(_ page: CorpusPage) -> some View {
        #if os(iOS)
        PageCanvasView(page: page)
            .ignoresSafeArea(edges: .bottom)
        #else
        ScrollView {
            Text(page.markdown())
                .font(.body.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        #endif
    }
}
