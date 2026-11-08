import XCTest

/// the shell against a demo server with a care week: each tab's first screen, the pushed screens under More, and
/// the links that switch tabs (Recover's "Go to Urgent"). only looks; nothing on the server changes.
/// SHELL_SERVER (TEST_RUNNER_SHELL_SERVER to xcodebuild) picks the server, default http://127.0.0.1:3200;
/// SHELL_SHOTS, when set, also saves each screenshot there as shell-<name>.png
final class ShellFlowTests: XCTestCase {
    private var app: XCUIApplication!

    private var server: String {
        ProcessInfo.processInfo.environment["SHELL_SERVER"] ?? "http://127.0.0.1:3200"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testTabsAndLinks() throws {
        app = XCUIApplication()
        app.launchArguments = ["-ServerURL", server, "-StartTab", "urgent"]
        app.launch()

        let urgentTab = app.tabBars.buttons["Urgent"]
        let start = element("screen.start")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !(urgentTab.exists || start.exists) {
            _ = urgentTab.waitForExistence(timeout: 1)
        }
        if start.exists || !urgentTab.exists { throw XCTSkip("the demo server at \(server) has no care week") }

        // urgent: the first step, or the summary, once the week's scan is back
        XCTAssertTrue(element("urgent.progress").waitForExistence(timeout: 120), "the week's steps never loaded")
        shot("urgent")

        // care, with Near Rosa at its foot
        app.tabBars.buttons["Care"].tap()
        XCTAssertTrue(element("screen.care").waitForExistence(timeout: 10))
        XCTAssertTrue(element("care.today").waitForExistence(timeout: 30) || element("care.empty").exists)
        shot("care")

        // recover, and its link back to Urgent when nothing has gone out yet
        app.tabBars.buttons["Recover"].tap()
        XCTAssertTrue(element("recover.heading").waitForExistence(timeout: 30), "recover did not load")
        shot("recover")
        let goUrgent = app.buttons["recover.goUrgent"]
        if goUrgent.exists {
            goUrgent.tap()
            assertSelected(urgentTab)
            XCTAssertTrue(element("urgent.progress").waitForExistence(timeout: 10))
        }

        // more, and the screens it pushes, each with its back button
        let more = app.tabBars.buttons["More"]
        more.tap()
        XCTAssertTrue(app.buttons["more.settings"].waitForExistence(timeout: 5))
        shot("more")
        for (link, screen) in [("more.settings", "settings"), ("more.outbox", "outbox"), ("more.careAccess", "careAccess")] {
            app.buttons[link].tap()
            XCTAssertTrue(element("screen.\(screen)").waitForExistence(timeout: 10))
            sleep(2)
            shot(screen)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(app.buttons[link].waitForExistence(timeout: 5))
        }
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    @MainActor
    private func assertSelected(_ tab: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: tab)
        waitForExpectations(timeout: 10)
    }

    @MainActor
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "shell-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["SHELL_SHOTS"], !dir.isEmpty {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("shell-\(name).png"))
        }
    }
}
