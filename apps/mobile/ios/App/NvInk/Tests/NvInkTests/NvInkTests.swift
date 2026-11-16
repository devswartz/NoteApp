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
        XCTAssertGreaterThan(info.maxX, 40)
        XCTAssertEqual(InkEngine.formatVersion, 1)
    }

    func testPathAndTrianglesAndBadBlobs() {
        let blob = stroke()
        let ops = InkEngine.path(blob)
        XCTAssertEqual(ops.first, InkOp.move)
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
        XCTAssertFalse(InkToolState().active)
    }
}
