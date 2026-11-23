import Foundation
import CoreGraphics
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The box being edited, as the shell sees it (ribbon, menus, comments). iPad/iPhone: `BoxTextView`; the Mac's
/// TextKit 2 box view conforms to it too (docs/rewrite/status/apple.md, M6 part 2).
protocol EditorTarget: AnyObject {
    /// An engine command (`EditorSession.command`, EDITOR.md 4); false when it was not applied.
    @discardableResult func command(_ name: String, _ argsJSON: String) -> Bool
}

/// What the renderers read about the signed-in person and the open comment threads (set by the shell).
enum EditorMarks {
    /// Mention ids that are the signed-in person (drawn yellow, as "yourself").
    static var selfMentionIds: Set<String> = []
    /// Comment threads that are resolved (their text is drawn plain) and the one open in the comments panel (drawn stronger).
    static var resolvedThreads: Set<String> = []
    static var activeThread: String?
}

/// The size of the main screen (the phone's bottom sheet is 55 % of it).
var mainScreenSize: CGSize {
    #if canImport(UIKit)
    return UIScreen.main.bounds.size
    #else
    return NSScreen.main?.frame.size ?? CGSize(width: 1440, height: 900)
    #endif
}
