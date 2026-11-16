// The pen layer's engine binding and model (run with `swift test` on a Mac; CI: .github/workflows/rust.yml).
// The UIKit and Metal parts are checked on the iPad (docs/ink-i2-test.md).
import CoreGraphics
import XCTest
@testable import NvInk

final class NvInkTests: XCTestCase {
    /// A wavy pen stroke from (x, y), drawn with the builder as the pen layer does.
    func stroke(x: Float = 10, y: Float = 20, color: UInt32 = 0x1F2328FF, tool: UInt8 = InkToolID.pen, z: String = "a0") -> Data {
        let b = StrokeBuilder(tool: tool, color: color, width: 2.5, z: z, flags: InkFlag.pressure, created: 1_700_000_000_000)
        for i in 0..<40 {
            let f = Float(i)
            b.push(x: x + f * 3, y: y + sin(f * 0.3) * 8, pressure: 0.5, altitude: 1.2, azimuth: 0.3, t: Double(i) * 8)
        }
        return b.finish()!
    }

    func testBuilderMakesABlobTheEngineReads() {
        let b = StrokeBuilder(tool: InkToolID.pen, color: 0x1D4ED8FF, width: 2.5, z: "a3", flags: 0)
        XCTAssertNil(StrokeBuilder(tool: 0, color: 0, width: 1, z: "a0", flags: 0).finish(), "no points, no blob")
        b.push(x: 0, y: 0, pressure: 0.5, altitude: 1.5, azimuth: 0, t: 0)
        b.push(x: 40, y: 10, pressure: 0.5, altitude: 1.5, azimuth: 0, t: 16)
        XCTAssertFalse(b.previewTriangles(predicted: [60, 12, 0.5]).isEmpty)
        let blob = b.finish()!
        XCTAssertNil(b.finish(), "spent")
        let info = InkEngine.info(blob)!
        XCTAssertEqual(info.color, 0x1D4ED8FF)
        XCTAssertEqual(info.z, "a3")
        XCTAssertEqual(info.tool, InkToolID.pen)
        XCTAssertLessThan(info.minX, 0)
        XCTAssertGreaterThan(info.maxX, 2, "reaches toward the second point (smoothing pulls a two-point stroke short)")
        XCTAssertEqual(InkEngine.formatVersion, 1)
    }

    func testPathAndTrianglesAndBadBlobs() {
        let blob = stroke()
        let ops = InkEngine.path(blob)
        XCTAssertTrue([InkOp.move, InkOp.circle].contains(ops.first ?? -1), "starts a shape")
        let path = InkPaths.cgPath(ops)
        XCTAssertFalse(path.isEmpty)
        let r = InkEngine.info(blob)!
        XCTAssertGreaterThanOrEqual(path.boundingBoxOfPath.minX, CGFloat(r.minX) - 0.5, "the header box covers the ink")
        XCTAssertLessThan(path.boundingBoxOfPath.minX - CGFloat(r.minX), 4)
        XCTAssertEqual(InkEngine.triangles(blob).count % 6, 0)
        let junk = Data([1, 2, 3])
        XCTAssertNil(InkEngine.info(junk))
        XCTAssertTrue(InkEngine.path(junk).isEmpty)
        XCTAssertNil(InkEngine.erase(junk, track: [0, 0], radius: 4))
        XCTAssertNil(InkEngine.info(Data()))
    }

    func testHitAndErase() {
        let blob = stroke()
        let cross: [Float] = [60, 0, 60, 60]
        XCTAssertTrue(InkEngine.hitPath(blob, track: cross, radius: 4))
        XCTAssertFalse(InkEngine.hitPath(blob, track: [900, 900], radius: 4))
        let pieces = InkEngine.erase(blob, track: cross, radius: 4)!
        XCTAssertEqual(pieces.count, 2)
        for p in pieces { XCTAssertNotNil(InkEngine.info(p)) }
        XCTAssertNil(InkEngine.erase(blob, track: [900, 900], radius: 4))
    }

    func testEncode() {
        let blob = InkEngine.encode(tool: 0, color: 0xFF0000FF, width: 2, z: "a1", flags: 0, created: 5, points: [0, 0, 0.5, 1.5, 0, 0, 10, 5, 0.5, 1.5, 0, 16])
        XCTAssertEqual(InkEngine.info(blob)?.count, 2)
    }

    func testStoreOverlaysAndAcks() {
        let s = InkStore()
        let a = stroke(), b = stroke(x: 2000, y: 2000, z: "a1")
        let dirty = s.replaceAll([("a", a), ("b", b), ("bad", Data([9]))])
        XCTAssertEqual(dirty, [TileKey.of(InkEngine.info(a)!), TileKey(x: 1, y: 1)])
        XCTAssertEqual(s.page.count, 2, "a blob that doesn't decode is skipped")
        XCTAssertEqual(s.visible().map(\.id), ["a", "b"])

        // A stroke drawn here shows at once, under its token, until the web confirms it.
        let c = stroke(x: 100, y: 100, z: "a2")
        s.setOverlay("s1", removed: [], added: [c])
        XCTAssertEqual(s.visible().count, 3)
        XCTAssertEqual(s.pendingTokens, ["s1"])
        s.apply(added: [("c", c)], removed: [], ack: "s1")
        XCTAssertEqual(s.visible().map(\.id), ["a", "b", "c"], "the real stroke replaces the overlay in the same update")
        XCTAssertTrue(s.pendingTokens.isEmpty)

        // An erase hides strokes and shows pieces until confirmed.
        s.setOverlay("e1", removed: ["a"], added: [stroke(x: 10, y: 20, z: "a0")])
        XCTAssertEqual(s.visible().map(\.id), ["e1#0", "b", "c"])
        s.apply(added: [], removed: ["a"], ack: "e1")
        XCTAssertEqual(s.visible().map(\.id), ["b", "c"])

        // Remote changes: removed and replaced strokes.
        // Undo on the web removes a stroke drawn here (it arrived through the ack above).
        s.apply(added: [("b", stroke(x: 50, y: 50, z: "a1"))], removed: ["c"])
        XCTAssertEqual(s.visible().map(\.id), ["b"])
        XCTAssertEqual(s.visible(in: TileKey(x: 0, y: 0)).map(\.id), ["b"])
        XCTAssertTrue(s.visible(in: TileKey(x: 1, y: 1)).isEmpty, "the old b left its tile")
    }

    func testRunsGroupOpaquePensOnly() {
        func e(_ id: String, _ color: UInt32, _ tool: UInt8 = InkToolID.pen) -> StrokeEntry {
            StrokeEntry(id: id, blob: stroke(color: color, tool: tool))!
        }
        let runs = InkStore.runs([e("1", 0x000000FF), e("2", 0x000000FF), e("3", 0xFF0000FF), e("4", 0xFACC1559, InkToolID.highlighter), e("5", 0xFACC1559, InkToolID.highlighter), e("6", 0xFF0000FF)])
        XCTAssertEqual(runs.map { $0.map(\.id) }, [["1", "2"], ["3"], ["4"], ["5"], ["6"]])
    }

    func testRules() {
        XCTAssertTrue(InkRules.touchDraws(isPencil: true, fingerDrawing: false))
        XCTAssertFalse(InkRules.touchDraws(isPencil: false, fingerDrawing: false), "palm and fingers don't draw")
        XCTAssertTrue(InkRules.touchDraws(isPencil: false, fingerDrawing: true))
        XCTAssertFalse(InkRules.scribbleAllowed(toolActive: true), "a pen or eraser: the Pencil draws, never writes text")
        XCTAssertTrue(InkRules.scribbleAllowed(toolActive: false))
        XCTAssertFalse(InkRules.scribbleAllowed(toolActive: false, pencilSwitches: true), "the Pencil will switch to Draw and draw instead")
        // Type mode: only the Pencil, and only with the auto-switch, starts ink (and switches to draw mode).
        XCTAssertTrue(InkRules.touchStartsInk(isPencil: true, toolActive: false, fingerDrawing: false, pencilSwitches: true))
        XCTAssertFalse(InkRules.touchStartsInk(isPencil: true, toolActive: false, fingerDrawing: false, pencilSwitches: false), "setting off: the Pencil acts like a finger")
        XCTAssertFalse(InkRules.touchStartsInk(isPencil: false, toolActive: false, fingerDrawing: true, pencilSwitches: true), "a finger never switches modes")
        XCTAssertTrue(InkRules.touchStartsInk(isPencil: false, toolActive: true, fingerDrawing: true, pencilSwitches: false))
        XCTAssertFalse(InkRules.touchStartsInk(isPencil: false, toolActive: true, fingerDrawing: false, pencilSwitches: true))
        XCTAssertEqual(InkRules.displayColor(0x1F2328FF, dark: true), 0xE6E6E6FF)
        XCTAssertEqual(InkRules.displayColor(0x1F2328FF, dark: false), 0x1F2328FF)
        XCTAssertEqual(InkRules.displayColor(0xDC2626FF, dark: true), 0xDC2626FF)
        XCTAssertEqual(InkRules.clampZoom(10), InkRules.maxZoom)
        XCTAssertEqual(InkRules.clampZoom(0.1), InkRules.minZoom)
    }

    func testPinchKeepsThePageUnderTheFingers() {
        let offset = CGPoint(x: 0, y: 300), surface = CGPoint(x: 40, y: 120), z: CGFloat = 1
        let f0 = CGPoint(x: 200, y: 400), f1 = CGPoint(x: 230, y: 380), s: CGFloat = 2
        let o1 = InkRules.offsetAfterPinch(offset: offset, surface: surface, scale: s, focalStart: f0, focalEnd: f1)
        // Any viewport point q: where the snapshot showed it vs where the page now is.
        for q in [CGPoint(x: 0, y: 0), f0, CGPoint(x: 500, y: 700)] {
            let page = CGPoint(x: (q.x + offset.x - surface.x) / z, y: (q.y + offset.y - surface.y) / z)
            let shown = CGPoint(x: f1.x + s * (q.x - f0.x), y: f1.y + s * (q.y - f0.y))
            let now = CGPoint(x: surface.x + page.x * z * s - o1.x, y: surface.y + page.y * z * s - o1.y)
            XCTAssertEqual(shown.x, now.x, accuracy: 0.001)
            XCTAssertEqual(shown.y, now.y, accuracy: 0.001)
        }
    }

    func testFingerTapsAndPinch() {
        let a = CGPoint(x: 100, y: 100), b = CGPoint(x: 200, y: 100), c = CGPoint(x: 150, y: 200)
        // Two fingers down and up quickly without moving: a two-finger tap (undo).
        var g = FingerGestures()
        g.down(count: 1, points: [a], time: 0)
        g.down(count: 2, points: [a, b], time: 0.02)
        XCTAssertEqual(g.moved(points: [CGPoint(x: 102, y: 101), CGPoint(x: 201, y: 99)], allowPinch: true), .none, "a wobble is still a tap")
        XCTAssertEqual(g.up(time: 0.15, cancelled: false), 2)
        // Three fingers: redo.
        g.down(count: 3, points: [a, b, c], time: 1)
        XCTAssertEqual(g.up(time: 1.2, cancelled: false), 3)
        // Too slow, one finger, moved, or cancelled: no tap.
        g.down(count: 2, points: [a, b], time: 2)
        XCTAssertNil(g.up(time: 2.9, cancelled: false))
        g.down(count: 1, points: [a], time: 3)
        XCTAssertNil(g.up(time: 3.1, cancelled: false))
        g.down(count: 2, points: [a, b], time: 4)
        _ = g.moved(points: [CGPoint(x: 100, y: 140), CGPoint(x: 200, y: 140)], allowPinch: true)
        XCTAssertNil(g.up(time: 4.1, cancelled: false), "a two-finger scroll isn't a tap")
        g.down(count: 2, points: [a, b], time: 5)
        XCTAssertNil(g.up(time: 5.1, cancelled: true))
        // Pinch: begins once the distance changes enough, then reports the scale.
        g.down(count: 2, points: [a, b], time: 6)
        XCTAssertEqual(g.moved(points: [CGPoint(x: 99, y: 100), CGPoint(x: 202, y: 100)], allowPinch: true), .none)
        XCTAssertEqual(g.moved(points: [CGPoint(x: 90, y: 100), CGPoint(x: 210, y: 100)], allowPinch: true), .pinchBegan(1.2))
        XCTAssertEqual(g.moved(points: [CGPoint(x: 50, y: 100), CGPoint(x: 250, y: 100)], allowPinch: true), .pinchChanged(2))
        g.endPinch()
        XCTAssertNil(g.up(time: 6.2, cancelled: false), "a pinch isn't a tap")
        // Where a pinch isn't allowed (outside the page, while drawing), it never starts.
        g.down(count: 2, points: [a, b], time: 7)
        XCTAssertEqual(g.moved(points: [CGPoint(x: 50, y: 100), CGPoint(x: 250, y: 100)], allowPinch: false), .none)
    }

    func testZKeysMatchTheWeb() {
        // The same keys as the web (src/ink/strokes.ts zAfter; pinned in tests/nativeInk.test.ts).
        XCTAssertEqual(ZKeys.after(nil), "a0")
        XCTAssertEqual(ZKeys.after("a0"), "a1")
        XCTAssertEqual(ZKeys.after("a9"), "aA")
        XCTAssertEqual(ZKeys.after("az"), "b10")
        XCTAssertEqual(ZKeys.after("b1z"), "b20")
        XCTAssertEqual(ZKeys.after("weird"), "weirdV")
        XCTAssertLessThan("az", ZKeys.after("az"))
    }

    func testWirePayloads() {
        let b = stroke()
        let items = InkWire.strokes([["id": "x", "data": b.base64EncodedString()], ["id": "y"], ["data": "zz"]])
        XCTAssertEqual(items.map(\.0), ["x"])
        XCTAssertEqual(items.first?.1, b)
        let l = InkLayout(["scroller": ["x": 0, "y": 50, "w": 800, "h": 900], "surface": ["x": 40, "y": 14, "w": 1200, "h": 3000], "zoom": 1.5,
                           "exclusions": [["x": 600, "y": 56, "w": 200, "h": 40]]])!
        XCTAssertEqual(l.scroller, CGRect(x: 0, y: 50, width: 800, height: 900))
        XCTAssertEqual(l.surfaceOrigin, CGPoint(x: 40, y: 14))
        XCTAssertEqual(l.surfaceSize, CGSize(width: 1200, height: 3000))
        XCTAssertEqual(l.zoom, 1.5)
        XCTAssertEqual(l.exclusions.count, 1)
        XCTAssertNil(InkLayout(["zoom": 1]))
        let t = InkToolState(["tool": "highlighter", "color": NSNumber(value: 0xFACC1559 as UInt32), "width": 18, "fingerDrawing": true, "dark": true])
        XCTAssertTrue(t.draws)
        XCTAssertEqual(t.strokeTool, InkToolID.highlighter)
        XCTAssertEqual(t.color, 0xFACC1559)
        XCTAssertTrue(InkToolState(["tool": "partialEraser"]).erases)
        let typing = InkToolState(["tool": "select", "penTool": "highlighter", "pencilSwitches": false])
        XCTAssertEqual(typing.penTool, "highlighter")
        XCTAssertFalse(typing.pencilSwitches)
        XCTAssertTrue(InkToolState().pencilSwitches, "on by default")
        XCTAssertEqual(InkToolState(["penTool": "select"]).penTool, "pen", "only pen tools")
        XCTAssertFalse(InkToolState().active)
    }
}
