import XCTest

/// walks the care access explorer and the Near Rosa section against a live demo server with a care week.
/// the server defaults to the shared 3200 one; set TEST_RUNNER_ACCESS_SERVER to use another. set
/// TEST_RUNNER_ACCESS_SHOTS to a folder to also write each step's screenshot there as access-<step>.png
@MainActor
final class AccessFlowTests: XCTestCase {
    private var app: XCUIApplication!

    nonisolated private static var server: String {
        ProcessInfo.processInfo.environment["ACCESS_SERVER"] ?? "http://127.0.0.1:3200"
    }

    private func launch() throws {
        continueAfterFailure = false
        try XCTSkipUnless(Self.hasEpisode(), "the demo server at \(Self.server) has no care week, so the tabs don't show")
        app = XCUIApplication()
        app.launchArguments = ["-ServerURL", Self.server, "-StartTab", "more", "-AccessHarness", "nearby"]
        app.launch()
    }

    /// GET /api/session: the explorer needs a care recipient, and the tabs need an episode
    nonisolated private static func hasEpisode() -> Bool {
        guard let url = URL(string: "\(server)/api/session") else { return false }
        let done = XCTestExpectation(description: "session")
        nonisolated(unsafe) var ok = false
        URLSession.shared.dataTask(with: url) { data, _, _ in
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                ok = json["episode"] is [String: Any] && json["careRecipient"] is [String: Any]
            }
            done.fulfill()
        }.resume()
        _ = XCTWaiter.wait(for: [done], timeout: 15)
        return ok
    }

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any)[id].firstMatch
    }

    private func shot(_ step: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "access-\(step)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACCESS_SHOTS"] {
            let url = URL(fileURLWithPath: folder).appendingPathComponent("access-\(step).png")
            try? screenshot.pngRepresentation.write(to: url)
        }
    }

    /// swipes up until the element is fully on screen, above the tab bar
    private func reveal(
        _ target: XCUIElement, whole: Bool = false, maxSwipes: Int = 14, file: StaticString = #filePath, line: UInt = #line
    ) {
        let window = app.windows.firstMatch
        var swipes = 0
        while swipes < maxSwipes {
            if target.exists && target.isHittable {
                let frame = target.frame
                let limit = window.frame.maxY - 110
                if frame.minY > 90 && (whole ? frame.maxY < limit : frame.minY < limit) { return }
            }
            app.swipeUp(velocity: .slow)
            swipes += 1
        }
        XCTAssertTrue(target.exists, "\(target) never came on screen", file: file, line: line)
    }

    private func openExplorer() {
        let tab = app.tabBars.buttons["More"]
        XCTAssertTrue(tab.waitForExistence(timeout: 30), "the tabs never showed")
        tab.tap()
        let link = element("more.careAccess")
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        XCTAssertTrue(element("screen.careAccess").waitForExistence(timeout: 10))
    }

    func testExplorerFlow() throws {
        try launch()
        openExplorer()

        // 1. the question, the intro and what to measure
        XCTAssertTrue(element("access.mode.driving").waitForExistence(timeout: 60), "the basemap and scores never loaded")
        XCTAssertTrue(app.staticTexts["How do other Calgary communities compare?"].exists
            || element("access.question").exists)
        shot("1-explorer")

        // 2. the map of communities, coloured by access, with her community shown in the details
        reveal(element("access.map"), whole: true)
        shot("2-map-access")

        // 3. coloured by the two access groups
        let groups = element("access.view.groups")
        if !groups.isHittable { app.swipeDown(velocity: .slow) }
        groups.tap()
        XCTAssertTrue(app.staticTexts["Access groups across Calgary"].waitForExistence(timeout: 5))
        reveal(element("access.map"), whole: true)
        shot("3-map-groups")
        let access = element("access.view.access")
        if !access.isHittable { app.swipeDown(velocity: .slow) }
        access.tap()

        // tapping a community on the map shows it in the details
        let map = element("access.map")
        reveal(map, whole: true)
        let before = element("access.detail.title").label
        map.coordinate(withNormalizedOffset: CGVector(dx: 0.42, dy: 0.62)).tap()
        let changed = NSPredicate(format: "label != %@", before)
        expectation(for: changed, evaluatedWith: element("access.detail.title"))
        waitForExpectations(timeout: 10)
        sleep(1)
        shot("4-map-tapped")

        // 4. the shown community's score, counts and places in reach; an unscored one says why instead
        reveal(element("access.detail.title"))
        let score = element("access.detail.score")
        XCTAssertTrue(score.waitForExistence(timeout: 10))
        if score.label != "Not scored" {
            XCTAssertTrue(element("access.places.title").waitForExistence(timeout: 30), "the places never loaded")
        }
        shot("5-detail")

        // 5. straight-line distance instead of driving, with a 5 km window
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        let distance = element("access.mode.proximity")
        XCTAssertTrue(distance.waitForExistence(timeout: 5))
        distance.tap()
        let five = element("access.window.5")
        XCTAssertTrue(five.waitForExistence(timeout: 5))
        five.tap()
        XCTAssertTrue(app.staticTexts["Distance"].exists)
        shot("6-distance")

        // 6. another community from the list
        let community = element("access.community")
        reveal(community)
        community.tap()
        XCTAssertTrue(element("screen.communityPicker").waitForExistence(timeout: 5))
        app.searchFields.firstMatch.tap()
        app.searchFields.firstMatch.typeText("Beltline")
        let beltline = element("access.picker.BLN")
        if beltline.waitForExistence(timeout: 5) {
            shot("7-picker")
            beltline.tap()
        } else {
            shot("7-picker")
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'access.picker.'")).element(boundBy: 0).tap()
        }
        XCTAssertFalse(element("screen.communityPicker").waitForExistence(timeout: 2) && element("screen.communityPicker").isHittable)
        reveal(element("access.detail.title"))
        XCTAssertTrue(element("access.places.title").waitForExistence(timeout: 30))
        shot("8-other-community")

        // 7. how this works
        reveal(element("access.how"), maxSwipes: 30)
        shot("9-how")
    }

    func testNearbyFlow() throws {
        try launch()
        openExplorer()
        let harness = element("access.harness.nearby")
        XCTAssertTrue(harness.waitForExistence(timeout: 10))
        harness.tap()
        XCTAssertTrue(element("screen.nearbyHarness").waitForExistence(timeout: 10))

        // 1. the filters and the numbered cards, closest of each kind first
        XCTAssertTrue(element("nearby.summary").waitForExistence(timeout: 60), "the nearby places never loaded")
        XCTAssertTrue(element("nearby.card.1").exists)
        shot("nearby-1-filters")
        reveal(element("nearby.summary"))
        shot("nearby-2-cards")

        // 2. show a card on the map: the map comes into view with its marker ringed
        let show = element("nearby.card.2.show")
        reveal(show)
        show.tap()
        XCTAssertTrue(element("nearby.map").waitForExistence(timeout: 5))
        sleep(2)
        shot("nearby-3-map")

        // 3. a marker brings its card back
        let marker = element("nearby.marker.1")
        if marker.waitForExistence(timeout: 5) && marker.isHittable {
            marker.tap()
            sleep(1)
            shot("nearby-4-marker")
        }

        // 4. the legend, the limits and the credits under the map
        reveal(element("nearby.limits"))
        shot("nearby-5-limits")

        // 5. filters ask again: 1 km, transit stops added
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        let oneKm = element("nearby.radius.1")
        reveal(oneKm)
        oneKm.tap()
        element("nearby.type.transit").tap()
        XCTAssertTrue(element("nearby.summary").waitForExistence(timeout: 30))
        sleep(2)
        shot("nearby-6-filtered")

        // 6. the folded drive-time summary
        let fold = element("nearby.home.toggle")
        reveal(fold, maxSwipes: 40)
        fold.tap()
        XCTAssertTrue(element("nearby.home.summary").waitForExistence(timeout: 30), "the home summary never loaded")
        reveal(element("nearby.home.summary"))
        shot("nearby-7-home")

        // 7. explore all calgary access leads to the explorer
        app.swipeDown(velocity: .fast)
        let explore = element("nearby.explore")
        reveal(explore)
        explore.tap()
        XCTAssertTrue(element("screen.careAccess").waitForExistence(timeout: 10))
    }
}
