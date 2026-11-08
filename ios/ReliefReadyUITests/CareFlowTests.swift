import XCTest

/// walks the docs/DEMO.md Care steps against a fresh demo server with a seeded care week and no care notes yet:
/// typed note, one-at-a-time review, a conflicting 8:30 note, Ask, the passport, the day and Emergency / Help.
/// set CARE_SERVER_URL (default http://127.0.0.1:3203) and, to save screenshots, CARE_SHOTS_DIR
/// (pass them to xcodebuild as TEST_RUNNER_CARE_SERVER_URL and TEST_RUNNER_CARE_SHOTS_DIR)
final class CareFlowTests: XCTestCase {
    private var app: XCUIApplication!

    private var serverURL: String {
        ProcessInfo.processInfo.environment["CARE_SERVER_URL"] ?? "http://127.0.0.1:3203"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    private func launch(_ extra: [String] = []) throws {
        app = XCUIApplication()
        app.launchArguments = ["-ServerURL", serverURL, "-StartTab", "care"] + extra
        app.launch()
        let care = app.descendants(matching: .any)["screen.care"]
        let problem = app.descendants(matching: .any)["connectionProblem"]
        let start = app.descendants(matching: .any)["screen.start"]
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !(care.exists || problem.exists || start.exists) {
            _ = care.waitForExistence(timeout: 1)
        }
        if problem.exists { throw XCTSkip("no demo server at \(serverURL)") }
        if start.exists { throw XCTSkip("the demo server at \(serverURL) has no care week; POST /api/intake first") }
        XCTAssertTrue(care.exists)
    }

    @MainActor
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["CARE_SHOTS_DIR"], !dir.isEmpty {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("care-\(name).png"))
        }
    }

    @MainActor
    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    @MainActor
    private func button(_ id: String) -> XCUIElement {
        app.buttons[id].firstMatch
    }

    /// swipes the screen until the element is on screen and hittable
    @MainActor
    @discardableResult
    private func reveal(_ element: XCUIElement, up: Bool = true, timeout: TimeInterval = 15) -> XCUIElement {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "missing \(element)")
        // the element may be above or below the screen: try the given way first, then the other
        var tries = 0
        while !element.isHittable && tries < 30 {
            let forward = tries < 12 ? up : !up
            if forward { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
            tries += 1
        }
        return element
    }

    @MainActor
    private func tap(_ element: XCUIElement) {
        reveal(element).tap()
    }

    /// moves to the end of a multi-line field, clears it and types new text
    @MainActor
    private func replaceText(in field: XCUIElement, with text: String) {
        reveal(field)
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.9)).tap()
        let current = (field.value as? String) ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
        field.typeText(text)
    }

    @MainActor
    private func waitFor(_ text: String, timeout: TimeInterval = 20) -> XCUIElement {
        let match = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: timeout), "never saw \(text)")
        return match
    }

    @MainActor
    private func scrollToTop() {
        for _ in 0..<12 { app.swipeDown(velocity: .fast) }
    }

    @MainActor
    func testCareDemoFlow() throws {
        try launch()
        guard element("care.empty").waitForExistence(timeout: 15) else {
            throw XCTSkip("the care profile is not empty; restart the demo server with --reset and seed /api/intake")
        }
        XCTAssertTrue(element("care.title").exists)
        shot("01-empty")

        // voice: speech is off on the demo server, so it offers a typed note
        tap(button("care.tell.voice"))
        XCTAssertTrue(element("care.voice.off").waitForExistence(timeout: 10))
        shot("02-voice-off")
        tap(button("care.voice.typeNote"))

        // the demo note, typed
        let field = element("care.add.field")
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(
            "Her spare glasses are in the top drawer of the hallway dresser. She has breakfast at 8:00 every morning. Speak slowly and face her, she reads lips a bit. She likes the radio on in the afternoon."
        )
        shot("03-add-note")
        tap(button("care.add.submit"))

        // review one at a time: approve the glasses and breakfast, edit the lip-reading tip, approve the radio
        XCTAssertTrue(element("screen.careReview").waitForExistence(timeout: 60))
        _ = waitFor("glasses are in the top drawer")
        shot("04-review-fact")
        tap(button("review.approve"))
        _ = waitFor("breakfast at 8:00")
        XCTAssertTrue(element("review.consequence").waitForExistence(timeout: 5))
        shot("05-review-timed")
        tap(button("review.approve"))
        _ = waitFor("reads lips")
        tap(button("review.edit"))
        replaceText(in: element("review.editField"), with: "Speak slowly and face her. She reads lips a bit.")
        shot("06-review-edit")
        tap(button("review.saveEdit"))
        _ = waitFor("radio on in the afternoon")
        tap(button("review.approve"))
        _ = waitFor("That\u{2019}s everything for now")
        shot("07-review-summary")
        tap(button("review.backToCare"))

        // the overview with its receipt
        XCTAssertTrue(element("care.receipt").waitForExistence(timeout: 10))
        shot("08-home")

        // an 8:30 note disagrees with breakfast at 8:00
        tap(button("care.quick.note"))
        let note = element("care.add.field")
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        note.tap()
        note.typeText("Breakfast at 8:30 with medication.")
        tap(button("care.add.submit"))
        _ = waitFor("Two notes disagree", timeout: 60)
        shot("09-review-conflict")
        tap(button("review.conflict.later"))
        _ = waitFor("That\u{2019}s everything for now")
        tap(button("review.backToCare"))
        XCTAssertTrue(element("care.receipt").waitForExistence(timeout: 10))

        // ask: found with a citation, its source, not found, medical, and conflict pending
        ask("Where are her spare glasses?")
        let citation = reveal(button("care.ask.citation"))
        citation.tap()
        reveal(element("care.ask.provenance"))
        shot("10-ask-found")
        tap(button("care.ask.viewSource"))
        XCTAssertTrue(element("source.text").waitForExistence(timeout: 10))
        shot("11-source")
        app.buttons["Close the full source"].firstMatch.tap()

        ask("What is her pharmacy\u{2019}s phone number?")
        XCTAssertTrue(element("care.ask.saved").waitForExistence(timeout: 20))
        reveal(element("care.ask.addAnswer"))
        shot("12-ask-not-found")

        ask("Should she take more pain medicine?")
        XCTAssertTrue(reveal(button("care.ask.call811")).exists)
        shot("13-ask-medical")

        ask("When does she have breakfast?")
        XCTAssertTrue(reveal(element("care.ask.conflictPending")).exists)
        shot("14-ask-conflict-pending")

        // the passport: open sections, then settle the conflict in open questions & conflicts
        tap(button("passport.section.practical"))
        reveal(button("passport.fact.viewSource"))
        tap(button("passport.section.open"))
        let keep = reveal(button("passport.conflict.keep"))
        shot("15-passport")
        keep.tap()
        XCTAssertTrue(button("passport.section.routine").waitForExistence(timeout: 15))

        // the day now follows the time that was kept
        scrollToTop()
        let mark = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'care.today.mark.'")).firstMatch
        reveal(mark, timeout: 20)
        shot("16-today")
        mark.tap()
        _ = waitFor("Done \u{2014} recorded by you")
        shot("17-today-done")

        // emergency / help: 911, 811 and a trusted contact
        scrollToTop()
        tap(button("care.emergency"))
        XCTAssertTrue(element("care.call911").waitForExistence(timeout: 10))
        shot("18-emergency")
        tap(button("care.contacts.add"))
        let name = element("care.contactForm.name")
        tap(name)
        name.typeText("Aunt Lucia")
        let relationship = element("care.contactForm.relationship")
        tap(relationship)
        relationship.typeText("Sister")
        let phone = element("care.contactForm.phone")
        tap(phone)
        phone.typeText("403-555-0142")
        tap(button("care.contactForm.kind.trusted"))
        shot("19-contact-form")
        tap(button("care.contactForm.save"))
        XCTAssertTrue(button("care.contact.call.Aunt Lucia").waitForExistence(timeout: 15))
        reveal(button("care.contact.call.Aunt Lucia"))
        shot("20-contact-added")
    }

    @MainActor
    private func ask(_ question: String) {
        let field = reveal(element("care.ask.field"))
        field.tap()
        if let current = field.value as? String, !current.isEmpty, !current.hasPrefix("Ask where") {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
        }
        field.typeText(question)
        tap(button("care.ask.submit"))
        XCTAssertTrue(waitFor("You asked: \u{201C}\(question)\u{201D}").exists)
    }

    /// the recorder's consent step, shown with -CareSpeech on against a server with speech off
    @MainActor
    func testVoiceConsentScreen() throws {
        try launch(["-CareSpeech", "on"])
        let voice = app.buttons["care.quick.voice"].firstMatch
        let tell = app.buttons["care.tell.voice"].firstMatch
        _ = voice.waitForExistence(timeout: 15) || tell.waitForExistence(timeout: 5)
        tap(voice.exists ? voice : tell)
        XCTAssertTrue(element("care.voice.consent").waitForExistence(timeout: 10))
        XCTAssertTrue(button("care.voice.record").exists)
        XCTAssertTrue(button("care.voice.typeInstead").exists)
        shot("21-voice-consent")
    }
}
