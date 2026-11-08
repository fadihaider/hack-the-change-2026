import XCTest

/// walks the docs/DEMO.md urgent steps against a freshly seeded demo server (default http://127.0.0.1:3202, or
/// TEST_RUNNER_RR_UI_SERVER): accept a suggestion, open the letter, edit it, change the tier, send, keep the
/// other steps, add Rosa's appointment to her timeline, check for replies, send a text and answer the tenure question
final class UrgentFlowTests: XCTestCase {
    private var app: XCUIApplication!
    private let shots = "/tmp/rr-urgent-shots"

    private var server: String {
        ProcessInfo.processInfo.environment["RR_UI_SERVER"] ?? "http://127.0.0.1:3202"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
    }

    @MainActor
    func testUrgentDemoFlow() throws {
        app = XCUIApplication()
        app.launchArguments = ["-ServerURL", server, "-StartTab", "urgent"]
        app.launch()

        // step 1: the group meeting, with both people ticked
        let reschedule = app.buttons["urgent.decision.reschedule"]
        XCTAssertTrue(reschedule.waitForExistence(timeout: 120), "the first step did not load; is the server seeded?")
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'urgent.pick.'")).count >= 2,
            "the group step should offer a checkbox per person"
        )
        shot("step-group")
        tap(reschedule)

        // the letter opens for the first person
        let send = app.buttons["letter.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 90), "the letter did not open")
        XCTAssertTrue(app.staticTexts["Ask Jordan to move it"].exists)
        shot("letter")

        // an edit: approval is bound to the words, so sending saves, approves and sends these exact words
        let body = app.textViews["letter.body"].exists ? app.textViews["letter.body"] : app.textFields["letter.body"]
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        typeAtEnd(body, " See you soon.")
        dismissKeyboard()
        shot("letter-edited")

        // a different tier: picked, then applied, then the message is written again at that level
        tap(app.buttons["letter.tier.general"])
        let keepWords = app.buttons["letter.keepWords"]
        XCTAssertTrue(keepWords.waitForExistence(timeout: 5), "the tier question did not show")
        shot("letter-tier")
        tap(app.buttons["letter.rewrite"])
        XCTAssertTrue(app.buttons["letter.tier.general"].waitForExistence(timeout: 60))
        waitGone(app.buttons["letter.rewrite"], timeout: 60)
        shot("letter-redrafted")

        // health words hold it back
        let body2 = app.textViews["letter.body"].exists ? app.textViews["letter.body"] : app.textFields["letter.body"]
        typeAtEnd(body2, " Mom had hip surgery.")
        dismissKeyboard()
        tap(app.buttons["letter.send"])
        let remove = app.buttons["letter.remove"]
        XCTAssertTrue(remove.waitForExistence(timeout: 30), "the health warning did not show")
        shot("letter-health")
        tap(remove)
        waitGone(app.otherElements["letter.warn"], timeout: 30)

        tap(app.buttons["letter.send"])
        let receipt = app.descendants(matching: .any)["urgent.receipt"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 60), "the send did not finish")
        shot("sent")

        // the second person's message waits on the same step
        let review = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'urgent.row.review.'")).firstMatch
        if review.waitForExistence(timeout: 5) {
            tap(review)
            XCTAssertTrue(app.buttons["letter.send"].waitForExistence(timeout: 30))
            tap(app.buttons["letter.send"])
            // the last message of the step sent: the flow moves on by itself
            XCTAssertTrue(app.staticTexts["Step 2 of 6"].waitForExistence(timeout: 60), "did not move on after the last send")
        } else {
            tap(app.buttons["urgent.next"])
        }

        // steps 2 to 5: keep them, with "Change the plan" shown on one of them
        for step in 2...5 {
            let keep = app.buttons["urgent.decision.keep"]
            XCTAssertTrue(keep.waitForExistence(timeout: 30), "step \(step) did not show")
            if step == 2 { shot("step-deadline") }
            tap(keep)
            if step == 2 {
                // keeping moves on; going back shows the kept step with "Change the plan"
                XCTAssertTrue(app.descendants(matching: .any)["urgent.receipt"].waitForExistence(timeout: 30))
                tap(app.buttons["Back"])
                XCTAssertTrue(app.buttons["urgent.changePlan"].waitForExistence(timeout: 10))
                shot("step-kept")
                tap(app.buttons["urgent.changePlan"])
                XCTAssertTrue(app.buttons["urgent.decision.keep"].waitForExistence(timeout: 30), "change the plan did not reopen")
                tap(app.buttons["urgent.decision.keep"])
            }
            waitStepAdvanced(from: step)
        }

        // step 6: Rosa's own appointment goes on her timeline
        let timeline = app.buttons["urgent.addTimeline"]
        XCTAssertTrue(timeline.waitForExistence(timeout: 30), "Rosa's step did not show")
        shot("step-rosa")
        tap(timeline)

        // the summary
        let sendText = app.buttons["urgent.sendText"]
        XCTAssertTrue(sendText.waitForExistence(timeout: 30), "the summary did not show")
        XCTAssertTrue(app.staticTexts["Added to Rosa\u{2019}s timeline in Care."].exists)
        shot("summary")
        tap(app.buttons["urgent.checkReplies"])
        XCTAssertTrue(app.descendants(matching: .any)["urgent.checkedAt"].waitForExistence(timeout: 30))
        shot("summary-checked")

        // send a text
        scrollToTop()
        tap(app.buttons["urgent.sendText"])
        let draft = app.buttons["sms.draft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 15))
        // a fresh demo has no saved care contacts, so the text goes to a typed number
        let careOption = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sms.to.care:'")).firstMatch
        if !careOption.waitForExistence(timeout: 5) {
            let phone = app.textFields["sms.phone"]
            tap(phone)
            phone.typeText("403 555 0142")
            let name = app.textFields["sms.name"]
            tap(name)
            name.typeText("Lucia")
            dismissKeyboard()
        }
        shot("sms")
        tap(draft)
        let approve = app.buttons["sms.approve"]
        waitEnabled(approve, timeout: 60)
        tap(approve)
        shot("sms-approved")
        tap(app.buttons["sms.send"])
        XCTAssertTrue(app.buttons["sms.done"].waitForExistence(timeout: 30), "the text did not send")
        shot("sms-sent")
        tap(app.buttons["sms.done"])

        // the texts group and help nearby
        let texts = app.descendants(matching: .any)["urgent.group.Texts"]
        XCTAssertTrue(texts.waitForExistence(timeout: 15))
        scrollTo(app.buttons["urgent.checkReplies"])
        shot("summary-texts")
        let heading = app.staticTexts["help.title"]
        scrollTo(heading)
        app.swipeUp(velocity: .slow)
        shot("help")
        let no = app.buttons["help.tenure.no"]
        scrollTo(no)
        shot("help-tenure")
        tap(no)
        let hint = app.staticTexts["help.tenureHint"]
        XCTAssertTrue(hint.waitForExistence(timeout: 5))
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !hint.label.contains("isn\u{2019}t shown") { _ = hint.waitForExistence(timeout: 1) }
        XCTAssertTrue(hint.label.contains("isn\u{2019}t shown"))
        sleep(3)
        shot("help-tenure-no")
        let support = app.descendants(matching: .any)["help.group.support"]
        scrollTo(support)
        shot("help-support")
    }

    // MARK: - helpers

    @MainActor
    private func shot(_ name: String) {
        sleep(1)
        let image = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = "urgent-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        try? image.pngRepresentation.write(to: URL(fileURLWithPath: "\(shots)/urgent-\(name).png"))
    }

    @MainActor
    private func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: 30), "missing \(element)", file: file, line: line)
        scrollTo(element)
        element.tap()
    }

    @MainActor
    private func scrollTo(_ element: XCUIElement) {
        var tries = 0
        while !reachable(element) && tries < 12 {
            app.swipeUp(velocity: .slow)
            tries += 1
        }
        tries = 0
        while !reachable(element) && tries < 12 {
            app.swipeDown(velocity: .slow)
            tries += 1
        }
    }

    /// hittable and not under the tab bar
    @MainActor
    private func reachable(_ element: XCUIElement) -> Bool {
        guard element.isHittable else { return false }
        let bar = app.tabBars.firstMatch
        if bar.exists && bar.isHittable && element.frame.maxY > bar.frame.minY - 8 { return false }
        return true
    }

    @MainActor
    private func scrollToTop() {
        for _ in 0..<8 { app.swipeDown(velocity: .fast) }
    }

    @MainActor
    private func waitHittable(_ element: XCUIElement) {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline, !element.isHittable { usleep(200_000) }
    }

    @MainActor
    private func waitEnabled(_ element: XCUIElement, timeout: TimeInterval) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout))
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, !element.isEnabled { usleep(300_000) }
        XCTAssertTrue(element.isEnabled, "\(element) stayed disabled")
    }

    @MainActor
    private func waitGone(_ element: XCUIElement, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, element.exists { usleep(300_000) }
    }

    @MainActor
    private func waitStepAdvanced(from step: Int) {
        let count = app.staticTexts["Step \(step + 1) of 6"]
        if !count.waitForExistence(timeout: 30) {
            XCTFail("did not move on from step \(step)")
        }
    }

    /// puts the cursor after the last line, then types
    @MainActor
    private func typeAtEnd(_ field: XCUIElement, _ text: String) {
        scrollTo(field)
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.97)).tap()
        sleep(1)
        field.typeText(text)
    }

    @MainActor
    private func dismissKeyboard() {
        let done = app.buttons["keyboard.done"]
        if done.waitForExistence(timeout: 3) { done.tap() }
    }
}
