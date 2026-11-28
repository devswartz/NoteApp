import SwiftUI

/// The web's `?` (src/hooks/useShortcuts.ts, `app.shortcuts`): with a hardware keyboard, opens the keyboard-shortcuts list.
/// Like the web it is ignored while a text field has the key (the field takes the character first) and while a dialog,
/// menu, sheet, task or the search is open. The shell takes keyboard focus once, so the key has somewhere to land.
struct ShellKeys: ViewModifier {
    let shell: Shell
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onAppear { focused = true }
            .onKeyPress(characters: CharacterSet(charactersIn: "?")) { _ in
                guard !shell.hasOverlay else { return .ignored }
                shell.openSettings("shortcuts")
                return .handled
            }
    }
}
