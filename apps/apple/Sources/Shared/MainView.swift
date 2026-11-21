import SwiftUI

/// The shell: sidebar (notebooks, sections, task views) and a detail area. Placeholder data until M3.
struct MainView: View {
    @Environment(SessionModel.self) private var session
    @State private var selection: SidebarItem? = .today

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
            if let selection {
                ContentUnavailableView(selection.title, systemImage: selection.symbol,
                                       description: Text("Coming in the native rewrite."))
            } else {
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
        case .page(let name): name
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

    private let notebooks: [(name: String, pages: [String])] = [
        ("Personal", ["Ideas", "Reading list"]),
        ("Work", ["Meeting notes", "Roadmap"]),
    ]

    var body: some View {
        List(selection: $selection) {
            Section("Tasks") {
                ForEach([SidebarItem.today, .myTasks, .upcoming, .calendar]) { item in
                    Label(item.title, systemImage: item.symbol).tag(item)
                }
            }
            ForEach(notebooks, id: \.name) { notebook in
                Section(notebook.name) {
                    ForEach(notebook.pages, id: \.self) { page in
                        Label(page, systemImage: "doc.text").tag(SidebarItem.page(page))
                    }
                }
            }
        }
        .navigationTitle("Notivelo")
    }
}
