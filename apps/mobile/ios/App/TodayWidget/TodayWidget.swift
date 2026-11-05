import WidgetKit
import SwiftUI

/// "Today" home-screen widget: my open tasks due today or overdue, from the
/// snapshot the app writes to the App Group (SharedStore). Tapping opens Today
/// (or the tapped task, on the medium and large sizes).
struct TodayEntry: TimelineEntry {
    let date: Date
    let snapshot: TodaySnapshot?
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: Date(), snapshot: TodaySnapshot(v: 1, date: "", signedIn: true, locked: false, path: nil, total: 2, items: [
            .init(id: "1", title: "Review the plan", overdue: false, time: "09:00", priority: 2, path: "/"),
            .init(id: "2", title: "Pay rent", overdue: true, time: nil, priority: 1, path: "/"),
        ]))
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : TodayEntry(date: Date(), snapshot: SharedStore.loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        // The app reloads the widget whenever tasks change; redraw after midnight so "today" rolls over.
        let entry = TodayEntry(date: Date(), snapshot: SharedStore.loadSnapshot())
        let midnight = Calendar.current.startOfDay(for: Date().addingTimeInterval(86_400)).addingTimeInterval(60)
        completion(Timeline(entries: [entry], policy: .after(midnight)))
    }
}

private let localDay: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

struct TodayWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TodayEntry

    private var maxRows: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        default: return 8
        }
    }

    var body: some View {
        content
            .widgetURL(TodaySnapshot.link(entry.snapshot?.path))
            .modifier(WidgetBackground())
    }

    @ViewBuilder private var content: some View {
        if let snap = entry.snapshot, snap.signedIn {
            // A snapshot from an earlier day: everything it lists is overdue now.
            let stale = snap.date != localDay.string(from: entry.date)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Today").font(.headline)
                    Spacer()
                    Text("\(snap.total)").font(.headline).foregroundColor(.accentColor)
                }
                if snap.locked == true {
                    Spacer()
                    Label(snap.total == 1 ? "1 task · Locked" : "\(snap.total) tasks · Locked", systemImage: "lock.fill")
                        .font(.subheadline).foregroundColor(.secondary)
                    Spacer()
                } else if snap.items.isEmpty {
                    Spacer()
                    Text("All clear").font(.subheadline).foregroundColor(.secondary)
                    Spacer()
                } else {
                    ForEach(snap.items.prefix(maxRows)) { item in
                        row(item, overdue: item.overdue || stale)
                    }
                    if snap.total > min(maxRows, snap.items.count) {
                        Text("+\(snap.total - min(maxRows, snap.items.count)) more").font(.caption2).foregroundColor(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Today").font(.headline)
                Spacer()
                Text("Open the app to sign in").font(.subheadline).foregroundColor(.secondary)
            }
        }
    }

    @ViewBuilder private func row(_ item: TodaySnapshot.Item, overdue: Bool) -> some View {
        let line = HStack(spacing: 6) {
            Circle().strokeBorder(priorityColor(item.priority), lineWidth: 1.5).frame(width: 11, height: 11)
            Text(item.title).font(.caption).lineLimit(1)
            Spacer(minLength: 0)
            if overdue {
                Text("Overdue").font(.caption2).foregroundColor(.red)
            } else if let time = item.time {
                Text(time).font(.caption2).foregroundColor(.secondary)
            }
        }
        if family == .systemSmall {
            line
        } else if let url = TodaySnapshot.link(item.path) {
            Link(destination: url) { line }
        } else {
            line
        }
    }

    private func priorityColor(_ p: Int) -> Color {
        switch p {
        case 1: return .red
        case 2: return .orange
        case 3: return .blue
        default: return .secondary
        }
    }
}

/// iOS 17 wants a container background; earlier versions use padding.
private struct WidgetBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 17.0, *) {
            content.containerBackground(for: .widget) { Color(UIColor.systemBackground) }
        } else {
            content.padding().background(Color(UIColor.systemBackground))
        }
    }
}

@main
struct TodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TodayWidget", provider: TodayProvider()) { entry in
            TodayWidgetView(entry: entry)
        }
        .configurationDisplayName("Today")
        .description("Your tasks due today and overdue.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
