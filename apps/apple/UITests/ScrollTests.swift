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
        window.swipeUp()
        window.swipeUp()
        Thread.sleep(forTimeInterval: 1.5)
        // The title has moved up (or scrolled out of the tree altogether).
        let moved = !title.exists || title.frame.minY < before - 80
        XCTAssertTrue(moved, "swiping the page did not scroll it (title still at y=\(before) -> \(title.frame.minY))")
    }
}
