import SwiftUI
#if os(macOS)
import AppKit
#endif

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
            // After the first layout, so the focus system has the view (and a field that took the keyboard first keeps it).
            .onAppear { DispatchQueue.main.async { if !typing { focused = true } } }
            .onKeyPress(characters: CharacterSet(charactersIn: "?")) { _ in
                guard !shell.hasOverlay, !typing else { return .ignored }
                shell.openSettings("shortcuts")
                return .handled
            }
    }

    /// A text field or the page editor has the keyboard: the web ignores `?` then.
    private var typing: Bool {
        if EditorFocus.shared.active { return true }
        #if os(macOS)
        return NSApp.keyWindow?.firstResponder is NSText
        #else
        return false
        #endif
    }
}
