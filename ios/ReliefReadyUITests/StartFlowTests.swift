import XCTest

/// walks the start and settings flows against a live demo server.
/// RR_SERVER_URL (TEST_RUNNER_RR_SERVER_URL to xcodebuild) picks a throwaway server and allows the steps that change it:
/// the intake, the demo clock and a new care week. without it the test uses the shared 3200 server and only looks.
/// RR_SCREENSHOT_DIR, when set, also saves each screenshot there as start-<step>.png
final class StartFlowTests: XCTestCase {
    private var app: XCUIApplication!
    private var screenshotDir: String?

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testStartAndSettingsFlow() throws {
        let env = ProcessInfo.processInfo.environment
        let server = env["RR_SERVER_URL"] ?? "http://127.0.0.1:3200"
        let mutates = env["RR_SERVER_URL"] != nil
        screenshotDir = env["RR_SCREENSHOT_DIR"]

        app = XCUIApplication()
        app.launchArguments = ["-ServerURL", server]
        app.launch()

        let start = element("screen.start")
        let tabs = app.tabBars.buttons["More"]
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !(start.exists || tabs.exists) {
            _ = start.waitForExistence(timeout: 1)
        }
        XCTAssertTrue(start.exists || tabs.exists, "neither the start nor the tabs appeared")

        if start.exists, mutates {
            try intakeWithAClarifyingQuestion()
        }

        // settings, from More
        XCTAssertTrue(tabs.waitForExistence(timeout: 20))
        tabs.tap()
        let settingsLink = app.buttons["more.settings"]
        XCTAssertTrue(settingsLink.waitForExistence(timeout: 5))
        settingsLink.tap()
        XCTAssertTrue(element("screen.settings").waitForExistence(timeout: 10))
        XCTAssertTrue(element("settings.mode.ai").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["What\u{2019}s running"].exists)
        snap("05-settings")

        if mutates {
            let jump = app.buttons["settings.jump"]
            XCTAssertTrue(jump.waitForExistence(timeout: 5))
            jump.tap()
            let status = element("settings.status")
            XCTAssertTrue(status.waitForExistence(timeout: 20))
            XCTAssertTrue(status.label.hasPrefix("Moved forward a day."), status.label)
            XCTAssertTrue(element("settings.simulated").waitForExistence(timeout: 10))
            snap("06-clock-moved")
            app.buttons["settings.resetClock"].tap()
            let reset = NSPredicate(format: "label BEGINSWITH 'Clock is back to real time.'")
            expectation(for: reset, evaluatedWith: element("settings.status"))
            waitForExpectations(timeout: 20)
        }

        // a new care week: the welcome back, then the intake that replaces this week
        let newWeek = app.buttons["settings.newWeek"]
        XCTAssertTrue(newWeek.waitForExistence(timeout: 5))
        if !newWeek.isHittable { element("screen.settings").swipeUp() }
        newWeek.tap()
        XCTAssertTrue(element("start.welcome").waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Pick up where you left off?'")).firstMatch.exists)
        snap("07-welcome")

        app.buttons["start.newWeek"].tap()
        XCTAssertTrue(element("start.write").waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["start.backToWeek"].waitForExistence(timeout: 5))
        let note = element("start.note")
        XCTAssertTrue(note.label.hasPrefix("This replaces your current week,"), note.label)
        snap("08-new-week")

        if mutates {
            app.buttons["start.example"].tap()
            dismissKeyboard()
            snap("09-new-week-example")
            app.buttons["start.check"].tap()
            // the saved week closes the sheet and settings shows the new dates
            XCTAssertTrue(element("start.welcome").waitForNonExistence(timeout: 60))
            XCTAssertTrue(element("start.write").waitForNonExistence(timeout: 30))
            XCTAssertTrue(element("settings.careWeek").waitForExistence(timeout: 10))
            snap("10-new-week-saved")
        } else {
            app.buttons["start.backToWeek"].tap()
            XCTAssertTrue(element("start.welcome").waitForExistence(timeout: 5))
            app.buttons["start.continue"].tap()
            XCTAssertTrue(element("start.welcome").waitForNonExistence(timeout: 10))
            XCTAssertTrue(element("screen.settings").exists)
        }
    }

    /// no care week yet: write a partial statement, answer the clarifying question, land on the tabs
    @MainActor
    private func intakeWithAClarifyingQuestion() throws {
        XCTAssertTrue(element("start.write").waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["start.example"].exists)
        XCTAssertFalse(app.buttons["start.backToWeek"].exists)
        snap("01-write")

        // nothing written: the error asks for a sentence
        app.buttons["start.check"].tap()
        XCTAssertTrue(element("start.error").waitForExistence(timeout: 5))

        let field = element("start.statementField")
        field.tap()
        field.typeText("My mom Rosa has hip surgery")
        dismissKeyboard()
        snap("02-typed")
        app.buttons["start.check"].tap()

        XCTAssertTrue(element("start.clarify").waitForExistence(timeout: 60))
        XCTAssertTrue(element("start.understood").exists)
        XCTAssertTrue(app.buttons["start.editStatement"].exists)
        snap("03-clarify")

        let answer = element("start.answerField")
        answer.tap()
        answer.typeText("It starts today and I am caring for her until Saturday.")
        dismissKeyboard()
        snap("04-answered")
        app.buttons["start.check"].tap()
        XCTAssertTrue(app.tabBars.buttons["Urgent"].waitForExistence(timeout: 60))
        snap("04b-tabs")
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }

    @MainActor
    private func dismissKeyboard() {
        guard app.keyboards.firstMatch.exists else { return }
        // the keyboard's Done button takes focus off the field
        let done = app.buttons["start.keyboardDone"]
        XCTAssertTrue(done.waitForExistence(timeout: 3))
        done.tap()
        _ = app.keyboards.firstMatch.waitForNonExistence(timeout: 3)
    }

    @MainActor
    private func snap(_ step: String) {
        // let the slide finish
        Thread.sleep(forTimeInterval: 0.6)
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "start-\(step)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = screenshotDir {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("start-\(step).png"))
        }
    }
}
