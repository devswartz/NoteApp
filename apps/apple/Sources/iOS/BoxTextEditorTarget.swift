import Foundation

extension BoxTextView: EditorTarget {
    var engineCanUndo: Bool { editor?.session.canUndo() ?? false }
    var engineCanRedo: Bool { editor?.session.canRedo() ?? false }
}
