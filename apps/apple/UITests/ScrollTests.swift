import XCTest

/// A finger scrolls a long page (iPhone and iPad). Swipes the window for real, so a pan swallowed by a
/// view or gesture recognizer fails here. Corpus mode: no network. CI: scripts/scroll-test.sh.
final class ScrollTests: XCTestCase {
    func testLongPageScrollsWithAFinger() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-previewSignedIn", "YES", "-lookState", "page-long", "-theme", "light"]
        app.launch()
        let title = app.staticTexts["page-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 40), "the long page did not open")
        let before = title.frame.minY
        let window = app.windows.firstMatch

        func moved() -> Bool { !title.exists || title.frame.minY < before - 80 }
        var tried: [String] = []

        window.swipeUp()
        Thread.sleep(forTimeInterval: 1.0)
        tried.append("swipeUp=\(moved())")
        if !moved() {
            // A slow drag (press, hold, drag), in case only the flick is lost.
            let from = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            let to = window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            from.press(forDuration: 0.1, thenDragTo: to)
            Thread.sleep(forTimeInterval: 1.0)
            tried.append("pressDrag=\(moved())")
        }
        XCTAssertTrue(moved(), "swiping the page did not scroll it (title y=\(before) -> \(title.frame.minY)); tried \(tried)")
    }
}
