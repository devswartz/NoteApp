import NotiveloCore
import SwiftUI

// The outline beside long pages (src/editor/Outline.tsx): a strip of bars in the page's right margin (one per heading, the
// current one accented) that opens into "On this page" with the headings; a tap goes to the heading and, on a page that can
// be edited, puts the caret there. Not on phones, and only with three headings or more.

extension LivePageModel {
    /// The page's headings with where each is in its box (`LivePage.outline()`, read on the page's queue).
    func loadOutline(_ done: @escaping ([OutlineItem]) -> Void) {
        outlineRead { done($0) }
    }
}

struct PageOutline: View {
    let headings: [PageHeading]
    let palette: Palette
    let live: LivePageModel?
    @Environment(Shell.self) private var shell
    @State private var open = LookData.state == "outline"
    @State private var current = 0

    var body: some View {
        let p = palette
        let minLevel = headings.map(\.level).min() ?? 1
        Group {
            if open {
                VStack(alignment: .leading, spacing: 0) {
                    Text("ON THIS PAGE").font(.web(11, 600)).tracking(0.55).foregroundStyle(p.textMuted.color).padding(.horizontal, 8).padding(.bottom, 6)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(headings.enumerated()), id: \.offset) { i, h in
                                Button { go(i, h) } label: {
                                    Text(h.text).font(.web(12.5)).foregroundStyle(i == current ? p.accent.color : p.text2.color).lineLimit(1)
                                        .padding(.leading, 8 + CGFloat(Int(h.level) - Int(minLevel)) * 12).padding(.trailing, 8).padding(.vertical, 4)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .overlay(alignment: .leading) { if i == current { Rectangle().fill(p.accent.color).frame(width: 2) } }
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(PressStyle(radius: 5, pressed: p.bgHover.color))
                            }
                        }
                    }
                    .frame(maxHeight: 360)
                }
                .padding(6)
                .frame(width: 240)
                .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(p.border.color, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
            } else {
                VStack(alignment: .trailing, spacing: 10) {
                    ForEach(0..<min(headings.count, 14), id: \.self) { i in
                        RoundedRectangle(cornerRadius: 1).fill((i == current ? p.accent : p.borderStrong).color).frame(width: 16, height: 2)
                    }
                }
                .frame(width: 28).padding(.vertical, 6)
                .contentShape(Rectangle())
                .onTapGesture { open = true }
            }
        }
        #if os(macOS)
        .onHover { open = $0 }
        #endif
        .accessibilityLabel("On this page")
    }

    private func go(_ i: Int, _ h: PageHeading) {
        current = i
        open = false
        let nav = CanvasNav.shared
        guard let live else {
            nav.reveal(boxId: h.boxId, offset: nil, caret: false)
            return
        }
        live.loadOutline { items in
            let inBox = items.filter { $0.boxId == h.boxId }
            let hit = Int(h.index) < inBox.count ? inBox[Int(h.index)] : nil
            nav.reveal(boxId: h.boxId, offset: hit?.offset, caret: hit != nil)
        }
    }
}

/// "Following Ann · Stop" over the top of the page while the canvas follows someone (the web's follow banner).
struct FollowChip: View {
    @Environment(Shell.self) private var shell

    var body: some View {
        if let person = CanvasNav.shared.following {
            let color = PlatformColor(css: person.color).color
            HStack(spacing: 8) {
                Text("Following \(person.name)").font(.web(12.5, 500)).foregroundStyle(.white).lineLimit(1)
                Button { CanvasNav.shared.stopFollowing() } label: {
                    Text("Stop").font(.web(12.5, 600)).foregroundStyle(.white)
                        .padding(.horizontal, 8).frame(height: 22)
                        .background(Color.white.opacity(0.22), in: Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, 12).padding(.trailing, 6).frame(height: 28)
            .background(color, in: Capsule())
            .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
            .padding(.top, 8)
        }
    }
}
