import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Light haptics on iPhone and iPad (the web app's Capacitor layer: a selection tap on checkbox toggles, a light impact
/// on success). Nothing on the Mac.
enum Haptics {
    /// A light selection tap: ticking a task or checklist item, entering select mode.
    static func tap() {
        #if os(iOS)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    /// A light impact: something done (a task completed from a swipe, a drag lifted).
    static func light() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}
