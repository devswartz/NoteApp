import SwiftUI

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
