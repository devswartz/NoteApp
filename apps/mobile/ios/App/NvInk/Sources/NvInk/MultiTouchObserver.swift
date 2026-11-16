#if canImport(UIKit)
// Finger gestures for the pen layer: a two-finger tap (undo), a three-finger tap (redo) and a
// pinch (zoom), recognised from raw touches by a recogniser that never recognises, can't be
// prevented and never cancels or delays touches. UIKit's own tap and pinch recognisers lost to
// WebKit's touch handling on the device (Devon's 0.5.90 rounds), so this one only watches: it sees
// every finger touch on the web view whatever WebKit's recognisers do. The decisions are in
// FingerGestures (InkModel.swift), which is unit-tested.
import UIKit
import UIKit.UIGestureRecognizerSubclass

final class MultiTouchObserver: UIGestureRecognizer {
    var onTap: ((Int) -> Void)?
    /// Pinch: began / changed / ended, the scale since it began, the centre of the two fingers (in `view`).
    var onPinch: ((UIGestureRecognizer.State, CGFloat, CGPoint) -> Void)?
    /// Whether a pinch may start with its centre here (in `view`).
    var pinchAllowed: ((CGPoint) -> Bool)?

    private var gesture = FingerGestures()
    private var touches: [UITouch] = []

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    private func points() -> [CGPoint] { touches.map { $0.location(in: view) } }

    private func centre() -> CGPoint {
        let p = points()
        guard !p.isEmpty else { return .zero }
        return CGPoint(x: p.map(\.x).reduce(0, +) / CGFloat(p.count), y: p.map(\.y).reduce(0, +) / CGFloat(p.count))
    }

    override func touchesBegan(_ t: Set<UITouch>, with event: UIEvent) {
        for x in t where !touches.contains(x) { touches.append(x) }
        gesture.down(count: touches.count, points: points(), time: event.timestamp)
    }

    override func touchesMoved(_ t: Set<UITouch>, with event: UIEvent) {
        switch gesture.moved(points: points(), allowPinch: pinchAllowed?(centre()) ?? true) {
        case .pinchBegan(let s): onPinch?(.began, s, centre())
        case .pinchChanged(let s): onPinch?(.changed, s, centre())
        case .none: break
        }
    }

    private func lift(_ t: Set<UITouch>, _ event: UIEvent, cancelled: Bool) {
        let wasPinching = gesture.pinching
        let c = centre()
        touches.removeAll { t.contains($0) }
        if wasPinching, touches.count < 2 {
            onPinch?(cancelled ? .cancelled : .ended, gesture.scale, c)
            gesture.endPinch()
        }
        guard touches.isEmpty else { return }
        if let n = gesture.up(time: event.timestamp, cancelled: cancelled) { onTap?(n) }
        state = .failed // nothing to recognise: lets UIKit reset this for the next touches
    }

    override func touchesEnded(_ t: Set<UITouch>, with event: UIEvent) { lift(t, event, cancelled: false) }
    override func touchesCancelled(_ t: Set<UITouch>, with event: UIEvent) { lift(t, event, cancelled: true) }

    override func reset() {
        super.reset()
        touches = []
        gesture = FingerGestures()
    }
}
#endif
