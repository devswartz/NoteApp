import Foundation
import NotiveloCore
import Observation

/// Moving the page canvas from outside it: the outline's "go to this heading" and following a collaborator. The canvases
/// (UIKit `PageScrollView`, AppKit `MacCanvasView`) listen for `revealNote`; they also hand the other people's carets here.
@Observable
final class CanvasNav {
    static let shared = CanvasNav()
    static let revealNote = Notification.Name("CanvasNav.reveal")

    /// The carets of the others on the page, as the open canvas has them (set by the canvas).
    private(set) var carets: [BoxCursor] = []
    /// Who the canvas is following (their caret stays in view), until the person scrolls.
    private(set) var following: PagePerson?
    @ObservationIgnored private var lastSeen: String?

    /// Scroll a box (or the line at `offset` in it, a view offset) into view. `caret`: also put our caret there (editable pages).
    /// `onlyIfHidden`: do nothing when the spot is comfortably in view (following).
    func reveal(boxId: String, offset: UInt32?, caret: Bool, onlyIfHidden: Bool = false) {
        var info: [String: Any] = ["box": boxId, "caret": caret, "onlyIfHidden": onlyIfHidden]
        if let offset { info["offset"] = offset }
        NotificationCenter.default.post(name: Self.revealNote, object: nil, userInfo: info)
    }

    /// The canvas got other people's carets.
    func publish(_ list: [BoxCursor]) {
        if list != carets { carets = list }
        guard let person = following else { return }
        guard let c = list.first(where: { $0.userId == person.id }) else { return }
        let key = "\(c.boxId):\(c.head)"
        if key == lastSeen { return }
        lastSeen = key
        reveal(boxId: c.boxId, offset: c.head, caret: false, onlyIfHidden: true)
    }

    func follow(_ person: PagePerson) {
        if following?.id == person.id {
            stopFollowing()
            return
        }
        following = person
        lastSeen = nil
        publish(carets)
    }

    func stopFollowing() {
        following = nil
        lastSeen = nil
    }

    /// The person scrolled or clicked: following ends.
    func userMoved() {
        if following != nil { stopFollowing() }
    }

    func reset() {
        carets = []
        stopFollowing()
    }
}
