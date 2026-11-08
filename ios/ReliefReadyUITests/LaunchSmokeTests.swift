import XCTest

/// launches against the local demo server and checks the shell renders. SMOKE_SERVER (TEST_RUNNER_SMOKE_SERVER to
/// xcodebuild) picks the server, default http://127.0.0.1:3200
final class LaunchSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testRootRenders() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-ServerURL", ProcessInfo.processInfo.environment["SMOKE_SERVER"] ?? "http://127.0.0.1:3200"]
        app.launch()

        // with an episode the tabs show; without one, Start; a down server shows the connection screen
        let tabs = app.tabBars.buttons["Urgent"]
        let start = app.descendants(matching: .any)["screen.start"]
        let problem = app.descendants(matching: .any)["connectionProblem"]
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline, !(tabs.exists || start.exists || problem.exists) {
            _ = tabs.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(tabs.exists || start.exists, "the shell did not render; connection problem shown: \(problem.exists)")

        if tabs.exists {
            app.tabBars.buttons["More"].tap()
            XCTAssertTrue(app.staticTexts["Outbox"].waitForExistence(timeout: 5))
        }
    }
}
