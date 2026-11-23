import SwiftUI
#if os(macOS)
import AppKit
#endif

/// SwiftUI modifiers that exist on one platform only (keyboard behaviour on iPad/iPhone); on the Mac they do nothing.
extension View {
    @ViewBuilder func dismissKeyboardOnScroll() -> some View {
        #if os(iOS)
        scrollDismissesKeyboard(.interactively)
        #else
        self
        #endif
    }

    @ViewBuilder func noAutocapitalization() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder func sentenceAutocapitalization() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.sentences)
        #else
        self
        #endif
    }

    @ViewBuilder func emailKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.emailAddress)
        #else
        self
        #endif
    }
}

extension View {
    /// A right-click (two-finger click) on the Mac, as the web's context menu on a tree row; nothing on iPad/iPhone (long press).
    @ViewBuilder func onSecondaryClick(_ action: @escaping () -> Void) -> some View {
        #if os(macOS)
        overlay(SecondaryClickCatcher(action: action))
        #else
        self
        #endif
    }
}

#if os(macOS)
/// Takes a right mouse press and nothing else (every other event passes through to the view below).
private struct SecondaryClickCatcher: NSViewRepresentable {
    let action: () -> Void

    final class Catcher: NSView {
        var action: () -> Void = {}
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let type = NSApp.currentEvent?.type, type == .rightMouseDown else { return nil }
            return super.hitTest(point)
        }
        override func rightMouseDown(with event: NSEvent) { action() }
    }

    func makeNSView(context: Context) -> Catcher {
        let view = Catcher()
        view.action = action
        return view
    }

    func updateNSView(_ view: Catcher, context: Context) { view.action = action }
}
#endif
