#if canImport(UIKit)
// Pen input for the native pen layer: a gesture recogniser on the web view that takes Pencil
// touches (and finger touches only with finger drawing on), so fingers keep scrolling the page and
// a resting palm never draws. It begins on the first touch (no delay) and, by recognising, cancels
// that touch for the web view, so the web never sees the pen as a tap.
import UIKit
import UIKit.UIGestureRecognizerSubclass

final class PenInputRecognizer: UIGestureRecognizer {
    /// The touch being followed, and the event it came with.
    private(set) var touch: UITouch?
    private(set) var event: UIEvent?

    var onBegan: ((UITouch, UIEvent) -> Void)?
    var onMoved: ((UITouch, UIEvent) -> Void)?
    var onEnded: ((UITouch, UIEvent?, Bool) -> Void)?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = true
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        // A resting palm (a finger touch) must not interrupt a Pencil stroke (Devon's first native round:
        // strokes cut short). Only the Pencil is allowed here anyway (allowedTouchTypes).
        requiresExclusiveTouchType = false
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard touch == nil, let t = touches.first else {
            for t in touches where t !== touch { ignore(t, for: event) }
            return
        }
        touch = t
        self.event = event
        for other in touches where other !== t { ignore(other, for: event) }
        onBegan?(t, event)
        state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = touch, touches.contains(t) else { return }
        onMoved?(t, event)
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = touch, touches.contains(t) else { return }
        onMoved?(t, event) // the last samples
        onEnded?(t, event, false)
        state = .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = touch, touches.contains(t) else { return }
        onEnded?(t, event, true)
        state = .cancelled
    }

    override func reset() {
        super.reset()
        touch = nil
        event = nil
    }
}
#endif
