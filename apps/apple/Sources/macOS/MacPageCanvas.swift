import NotiveloCore
import SwiftUI

/// The page area on the Mac for now: title, sub-line and the page as the core's Markdown, read-only, on the page's colour,
/// scaled by View > Zoom. M6 part 2 swaps this view for the TextKit 2 box canvas over `EditorSession` (it keeps this
/// initialiser, and registers the focused box with `EditorFocus` so the ribbon and the Format menu work).
struct MacPageCanvas: View {
    let page: PageSnapshot
    let host: PageEditHost?
    let title: String
    let subline: String
    let palette: Palette
    @Environment(Shell.self) private var shell

    var body: some View {
        let z = shell.zoom
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(title.isEmpty ? "Untitled" : title)
                    .font(.web(32 * z, 700)).tracking(-0.02 * 32 * z)
                    .foregroundStyle(palette.text.color)
                Text(subline)
                    .font(.web(12.5 * z))
                    .foregroundStyle(palette.textMuted.color)
                    .padding(.top, 6)
                Text(page.markdown())
                    .font(Font(WebType.mono(13 * z) as CTFont))
                    .foregroundStyle(palette.text.color)
                    .textSelection(.enabled)
                    .padding(.top, 24)
                Text("Editing arrives with the native Mac editor.")
                    .font(.web(12.5 * z))
                    .foregroundStyle(palette.textMuted.color)
                    .padding(.top, 24)
            }
            .padding(.horizontal, 56).padding(.top, 30).padding(.bottom, 80)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(palette.bg.color)
    }
}
