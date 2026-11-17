// The drawing page's model (Sources/NvInk/DrawingModel.swift): undo/redo, erase steps and saving.
import XCTest
@testable import NvInk

final class DrawingDocTests: XCTestCase {
    func stroke(x: Float = 10, y: Float = 20, z: String = "a0") -> Data {
        let b = StrokeBuilder(tool: InkToolID.pen, color: 0x1F2328FF, width: 3, z: z, flags: InkFlag.pressure)
        for i in 0..<10 { b.push(x: x + Float(i) * 5, y: y, pressure: 0.5, altitude: 1, azimuth: 0, t: Double(i) * 8) }
        return b.finish()!
    }

    func testCommitUndoRedo() {
        let doc = DrawingDoc()
        XCTAssertFalse(doc.canUndo)
        doc.commit(DrawingOp(added: [(id: "a", blob: stroke())]))
        doc.commit(DrawingOp(added: [(id: "b", blob: stroke(y: 200, z: doc.nextZ))]))
        XCTAssertEqual(doc.strokeCount, 2)
        XCTAssertGreaterThan(doc.inkBottom, 199)
        XCTAssertNotNil(doc.undo())
        XCTAssertEqual(Set(doc.store.page.keys), ["a"])
        XCTAssertTrue(doc.canRedo)
        XCTAssertNotNil(doc.redo())
        XCTAssertEqual(Set(doc.store.page.keys), ["a", "b"])
        doc.undo()
        doc.commit(DrawingOp(added: [(id: "c", blob: stroke())]))
        XCTAssertFalse(doc.canRedo, "a new change drops the redo steps")
        XCTAssertNil(doc.redo())
    }

    func testAnEraseGestureIsOneUndoStep() {
        let doc = DrawingDoc()
        let a = stroke()
        doc.commit(DrawingOp(added: [(id: "a", blob: a)]))
        // Applied as the eraser moves, recorded once at the end.
        let pieces = InkEngine.erase(a, track: [30, 20, 30, 21], radius: 4) ?? []
        XCTAssertEqual(pieces.count, 2)
        let step = DrawingOp(added: pieces.enumerated().map { (id: "p\($0.offset)", blob: $0.element) }, removed: [(id: "a", blob: a)])
        doc.applyUnrecorded(step)
        doc.record(step)
        XCTAssertEqual(Set(doc.store.page.keys), ["p0", "p1"])
        doc.undo()
        XCTAssertEqual(Set(doc.store.page.keys), ["a"], "undo puts the whole stroke back")
        doc.redo()
        XCTAssertEqual(Set(doc.store.page.keys), ["p0", "p1"])
    }

    func testClearIsUndoable() {
        let doc = DrawingDoc()
        doc.commit(DrawingOp(added: [(id: "a", blob: stroke()), (id: "b", blob: stroke(z: "a1"))]))
        doc.clear()
        XCTAssertEqual(doc.strokeCount, 0)
        doc.undo()
        XCTAssertEqual(doc.strokeCount, 2)
    }

    func testSaveAndLoad() {
        let doc = DrawingDoc()
        doc.title = "Sketches ✏️"
        doc.commit(DrawingOp(added: [(id: "a", blob: stroke()), (id: "b", blob: stroke(y: 90, z: "a1"))]))
        let back = DrawingDoc.decode(doc.encoded())
        XCTAssertEqual(back?.title, "Sketches ✏️")
        XCTAssertEqual(back?.store.page["a"]?.blob, doc.store.page["a"]?.blob)
        XCTAssertEqual(back?.strokeCount, 2)
        XCTAssertFalse(back?.canUndo ?? true, "undo history isn't saved")
        XCTAssertNil(DrawingDoc.decode(Data("nope".utf8)))
        XCTAssertNil(DrawingDoc.decode(doc.encoded().prefix(20)), "a cut-off file doesn't load")
        XCTAssertEqual(DrawingDoc.decode(DrawingDoc().encoded())?.strokeCount, 0)
    }

    func testPageSizes() {
        XCTAssertEqual(DrawingPage.height(current: 0, inkBottom: 0), DrawingPage.minHeight)
        XCTAssertEqual(DrawingPage.height(current: 1400, inkBottom: 2000), 2000 + DrawingPage.roomBelow, "grows below the ink")
        XCTAssertEqual(DrawingPage.height(current: 5000, inkBottom: 100), 5000, "never shrinks")
        XCTAssertEqual(DrawingPage.fitZoom(viewWidth: 2000), 1, "never above 1:1")
        XCTAssertEqual(DrawingPage.fitZoom(viewWidth: 832), 0.8, accuracy: 1e-9)
        XCTAssertEqual(DrawingPage.fitZoom(viewWidth: 100), DrawingPage.minZoom)
        XCTAssertEqual(DrawingPage.centringInset(view: 1000, content: 800), 100)
        XCTAssertEqual(DrawingPage.centringInset(view: 800, content: 1000), 0)
    }
}
