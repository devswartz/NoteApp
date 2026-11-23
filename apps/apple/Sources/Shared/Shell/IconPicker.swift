import SwiftUI

/// The emoji picker for page icons (src/editor/IconPicker.tsx): a search field, Random and Remove, and a grid of a small,
/// curated set (the web's list, with its search keywords). Typing or pasting an emoji and pressing Return uses it directly.
struct IconPickerCard: View {
    let palette: Palette
    let hasIcon: Bool
    let pick: (String?) -> Void
    @State private var query = ""
    @Environment(\.phoneLayout) private var phone

    static let emoji: [(String, String)] = [
        ("📄", "page document doc"), ("📝", "memo note write"), ("📓", "notebook"),
        ("📒", "ledger notebook"), ("📚", "books library"), ("📌", "pin"),
        ("📎", "clip attachment"), ("🗂️", "folders index"), ("🗓️", "calendar date"),
        ("⏰", "alarm clock time"), ("✅", "done check tick"), ("☑️", "checkbox"),
        ("🎯", "goal target"), ("🚀", "launch rocket ship"), ("💡", "idea bulb"),
        ("🔥", "fire hot"), ("⭐", "star favourite"), ("❤️", "heart love"),
        ("⚠️", "warning"), ("❗", "important"), ("❓", "question"),
        ("🔒", "lock private secret"), ("🔑", "key password"), ("🛠️", "tools build"),
        ("⚙️", "settings gear"), ("🐛", "bug"), ("💻", "computer laptop code"),
        ("🧪", "test experiment"), ("📊", "chart bar stats"), ("📈", "growth up chart"),
        ("💰", "money budget"), ("💳", "card payment"), ("🧾", "receipt invoice"),
        ("🏠", "home house"), ("🏢", "office work"), ("✈️", "travel plane flight"),
        ("🌍", "world globe"), ("🍽️", "food meal recipe"), ("☕", "coffee"),
        ("🏋️", "gym workout"), ("🧘", "health calm"), ("🎨", "design art"),
        ("🎵", "music"), ("🎬", "film movie video"), ("📷", "photo camera"),
        ("🎉", "party celebrate"), ("🎁", "gift"), ("👥", "team people"),
        ("🤝", "meeting deal"), ("💬", "chat discussion"), ("📣", "announce"),
        ("📧", "email mail"), ("📞", "phone call"), ("🧠", "brain think"),
        ("📖", "read book"), ("🌱", "plant growth"), ("🌟", "sparkle"),
        ("🧭", "compass direction"), ("🗺️", "map roadmap"), ("🏁", "finish flag"),
    ]

    private var list: [(String, String)] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? Self.emoji : Self.emoji.filter { $0.1.contains(q) }
    }

    var body: some View {
        let p = palette
        MenuCard(palette: p, width: phone ? 340 : 336, radius: 10, padding: 8) {
            HStack(spacing: 4) {
                TextField("Search icons…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.web(14))
                    .foregroundStyle(p.text.color)
                    .padding(.horizontal, 10).frame(height: 32)
                    .background(p.bg.color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(p.border.color, lineWidth: 1))
                    .onSubmit {
                        if let first = list.first {
                            pick(first.0)
                        } else if query.unicodeScalars.contains(where: { $0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0xFF) }) {
                            pick(query.trimmingCharacters(in: .whitespaces))
                        }
                    }
                ghost("Random") { pick(Self.emoji.randomElement()?.0) }
                if hasIcon { ghost("Remove") { pick(nil) } }
            }
            .padding(.bottom, 6)
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 34, maximum: 34), spacing: 2)], alignment: .leading, spacing: 2) {
                    ForEach(list, id: \.0) { item in
                        Button { pick(item.0) } label: {
                            Text(item.0).font(.system(size: 20)).frame(width: 32, height: 32)
                        }
                        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
                        .accessibilityLabel(item.1.split(separator: " ").first.map(String.init) ?? item.0)
                    }
                }
                .padding(4)
                if list.isEmpty {
                    Text("No match. Paste any emoji and press Enter.").font(.web(12.5)).foregroundStyle(p.textMuted.color)
                        .padding(.horizontal, 4).padding(.bottom, 8)
                }
            }
            .frame(height: 240)
        }
    }

    private func ghost(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.web(13, 500)).foregroundStyle(palette.text2.color).padding(.horizontal, 8).frame(height: 28)
        }
        .buttonStyle(PressStyle(radius: 6, pressed: palette.bgHover.color))
    }
}
