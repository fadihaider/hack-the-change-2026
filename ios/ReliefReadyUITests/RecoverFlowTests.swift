import XCTest

/// walks the recover demo against a local demo server on port 3205 (ios/scripts/demo-server.sh --reset 3205):
/// seeds four requests by api, cancels one and sends one from Recover, accepts one through the Outbox reply link,
/// sees it under Handled, then moves the clock three days so the unanswered one needs follow-up.
/// skipped when the server isn't running; needs a freshly reset demo database. RECOVER_SERVER
/// (TEST_RUNNER_RECOVER_SERVER to xcodebuild) points it at another server
final class RecoverFlowTests: XCTestCase {
    static let base = ProcessInfo.processInfo.environment["RECOVER_SERVER"].flatMap(URL.init(string:))
        ?? URL(string: "http://127.0.0.1:3205")!
    private var server: DemoServer!

    /// ios/screenshots, next to this folder
    private static let screenshots = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().appending(path: "screenshots")

    override func setUp() async throws {
        continueAfterFailure = false
        server = DemoServer(base: Self.base)
        guard await server.isUp() else {
            throw XCTSkip("no demo server on \(Self.base); start ios/scripts/demo-server.sh --reset 3205")
        }
    }

    override func tearDown() async throws {
        if let server, await server.isUp() {
            _ = try? await server.post("/api/clock/reset", [:])
        }
    }

    @MainActor
    func testRecoverFlow() async throws {
        let seeded = try await server.seed()

        let app = XCUIApplication()
        app.launchArguments = ["-ServerURL", Self.base.absoluteString, "-StartTab", "recover"]
        app.launch()

        // 1. the list: not sent and waiting
        let heading = app.descendants(matching: .any)["recover.heading"]
        XCTAssertTrue(heading.waitForExistence(timeout: 30), "recover did not load")
        XCTAssertTrue(app.descendants(matching: .any)["recover.group.notSent"].waitForExistence(timeout: 5))
        shot(app, "recover-1-list")

        // 2. "Don't send it", then confirm
        let cancel = app.buttons["recover.cancel.\(seeded.cancel)"]
        reveal(cancel, in: app)
        cancel.tap()
        let confirm = app.buttons["recover.confirmCancel.\(seeded.cancel)"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        reveal(confirm, in: app)
        shot(app, "recover-2-confirm-cancel")
        confirm.tap()
        let receipt = app.descendants(matching: .any)["recover.receipt"]
        XCTAssertTrue(receipt.waitForExistence(timeout: 15))
        XCTAssertTrue(receipt.label.contains("won\u{2019}t be sent"), receipt.label)
        shot(app, "recover-3-cancelled")

        // 3. "Send to X" on the approved one
        let send = app.buttons["recover.send.\(seeded.send)"]
        reveal(send, in: app)
        send.tap()
        let sent = NSPredicate(format: "label CONTAINS %@", "Placed in the demo outbox")
        XCTAssertTrue(waitFor(receipt, sent, timeout: 20), receipt.label)
        shot(app, "recover-4-sent")

        // 4. the outbox, and the accept link for the first request
        app.tabBars.buttons["More"].tap()
        let outboxLink = app.buttons["more.outbox"]
        XCTAssertTrue(outboxLink.waitForExistence(timeout: 5))
        outboxLink.tap()
        XCTAssertTrue(app.descendants(matching: .any)["outbox.heading"].waitForExistence(timeout: 20))
        shot(app, "recover-5-outbox")

        let messages = try await server.outboxIndex()
        let acceptIndex = try XCTUnwrap(messages[seeded.accept], "no outbox message for the accept request")
        let proposeIndex = try XCTUnwrap(messages[seeded.expire], "no outbox message for the waiting request")

        // a propose link shows the date picker; go back without sending
        let propose = app.buttons["outbox.link.\(proposeIndex).propose"]
        reveal(propose, in: app)
        propose.tap()
        XCTAssertTrue(app.descendants(matching: .any)["response.date"].waitForExistence(timeout: 20))
        shot(app, "recover-6-propose-form")
        app.navigationBars.buttons.firstMatch.tap()

        let accept = app.buttons["outbox.link.\(acceptIndex).accept"]
        XCTAssertTrue(accept.waitForExistence(timeout: 10))
        reveal(accept, in: app)
        accept.tap()
        let confirmAnswer = app.buttons["response.confirm"]
        XCTAssertTrue(confirmAnswer.waitForExistence(timeout: 20))
        shot(app, "recover-7-response")
        confirmAnswer.tap()
        let doneHeading = app.descendants(matching: .any)["response.done"]
        XCTAssertTrue(doneHeading.waitForExistence(timeout: 20))
        XCTAssertTrue(doneHeading.label.contains("Your answer was recorded: Accepted."), doneHeading.label)
        shot(app, "recover-8-accepted")

        // 5. back on Recover the accepted one is handled
        app.tabBars.buttons["Recover"].tap()
        let check = app.buttons["recover.check"]
        reveal(check, in: app)
        check.tap()
        let handled = app.descendants(matching: .any)["recover.group.handled"]
        XCTAssertTrue(handled.waitForExistence(timeout: 20))
        XCTAssertTrue(app.descendants(matching: .any)["recover.row.\(seeded.accept)"].waitForExistence(timeout: 5))
        reveal(handled, in: app)
        shot(app, "recover-9-handled")

        // 6. a day forward three times: the unanswered requests run out of time
        for _ in 0..<3 { _ = try await server.post("/api/clock/jump", ["days": 1]) }
        reveal(check, in: app)
        check.tap()
        let checked = app.descendants(matching: .any)["recover.checked"]
        XCTAssertTrue(checked.waitForExistence(timeout: 20))
        // POST /api/clock/jump already runs the expiry sweep, so the check usually just sees the list change;
        // a pull to refresh while scrolling may have checked first. the follow-up rows below are what count
        let checkLines = [
            "The list now shows the newest replies.", "Nothing new since you last looked.",
        ]
        XCTAssertTrue(checked.label.contains("ran out of time") || checkLines.contains(checked.label), checked.label)
        shot(app, "recover-10-checked")
        let followUp = app.descendants(matching: .any)["recover.group.followUp"]
        XCTAssertTrue(followUp.waitForExistence(timeout: 5))
        let status = app.descendants(matching: .any)["recover.status.\(seeded.expire)"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(status.label.hasPrefix("No reply by"), status.label)
        // needs follow-up is the first group, right under the heading
        for _ in 0..<10 where !heading.isHittable { app.swipeDown() }
        app.swipeUp(velocity: 300)
        shot(app, "recover-11-follow-up")

        // 7. "Choose what to do in Urgent" switches tabs and reopens that step
        let toUrgent = app.buttons["recover.urgent.\(seeded.expire)"]
        reveal(toUrgent, in: app)
        toUrgent.tap()
        let urgentTab = app.tabBars.buttons["Urgent"]
        XCTAssertTrue(waitFor(urgentTab, NSPredicate(format: "isSelected == true"), timeout: 10), "Urgent was not selected")
        let urgentReceipt = app.descendants(matching: .any)["urgent.receipt"]
        XCTAssertTrue(urgentReceipt.waitForExistence(timeout: 120), "urgent never opened the linked message")
        XCTAssertTrue(urgentReceipt.label.contains("Choose what to do now."), urgentReceipt.label)

        _ = try await server.post("/api/clock/reset", [:])
    }

    // MARK: - helpers

    /// scrolls until the element can be tapped
    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        _ = element.waitForExistence(timeout: 10)
        var tries = 0
        while !element.isHittable && tries < 12 {
            app.swipeUp(velocity: .slow)
            tries += 1
        }
        if !element.isHittable {
            for _ in 0..<12 where !element.isHittable { app.swipeDown(velocity: .slow) }
        }
    }

    @MainActor
    private func waitFor(_ element: XCUIElement, _ predicate: NSPredicate, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && predicate.evaluate(with: element) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return false
    }

    /// keeps a screenshot as an attachment and, when the folder is reachable, as ios/screenshots/<name>.png
    @MainActor
    private func shot(_ app: XCUIApplication, _ name: String) {
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if FileManager.default.fileExists(atPath: Self.screenshots.path) {
            try? screenshot.pngRepresentation.write(to: Self.screenshots.appending(path: "\(name).png"))
        }
    }
}

/// the few demo server calls the flow needs, sent as the web would
struct DemoServer {
    var base: URL

    /// the requests the flow uses, by role
    struct Seeded {
        /// sent by api; accepted through the outbox link in the app
        var accept: String
        /// sent by api; left unanswered so it runs out of time
        var expire: String
        /// approved by api; sent from Recover
        var send: String
        /// waiting for approval; cancelled from Recover
        var cancel: String
    }

    struct Failure: Error, CustomStringConvertible {
        var description: String
    }

    func isUp() async -> Bool {
        var request = URLRequest(url: base.appending(path: "/api/session"))
        request.timeoutInterval = 10
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func get(_ path: String) async throws -> [String: Any] {
        var request = URLRequest(url: base.appending(path: path))
        request.timeoutInterval = 90
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    /// next dev answers invalid_origin while a route is still compiling on its first hit, so it retries
    @discardableResult
    func post(_ path: String, _ body: [String: Any], headers: [String: String] = [:]) async throws -> [String: Any] {
        for attempt in 1...3 {
            var request = URLRequest(url: base.appending(path: path))
            request.httpMethod = "POST"
            request.timeoutInterval = 90
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("http://127.0.0.1:\(base.port ?? 80)", forHTTPHeaderField: "Origin")
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, _) = try await URLSession.shared.data(for: request)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            let code = (json["error"] as? [String: Any])?["code"] as? String
            if code == "invalid_origin" && attempt < 3 {
                try await Task.sleep(for: .seconds(3))
                continue
            }
            return json
        }
        return [:]
    }

    /// the care week, one request per suggested commitment, and the states the flow starts from
    func seed() async throws -> Seeded {
        var session = try await get("/api/session")
        if session["episode"] is NSNull || session["episode"] == nil {
            try await post("/api/intake", ["statement": "My mom Rosa has hip surgery today and I'm caring for her until Saturday."])
            session = try await get("/api/session")
        }
        guard let episode = (session["episode"] as? [String: Any])?["id"] as? String else {
            throw Failure(description: "no care week after intake")
        }
        let impact = try await post("/api/impact", ["episodeId": episode])
        let commitments = impact["commitments"] as? [[String: Any]] ?? []
        for commitment in commitments {
            guard let action = commitment["suggestedAction"] as? String,
                ["notify", "reschedule", "extension", "coverage"].contains(action),
                let id = commitment["id"] as? String
            else { continue }
            let contact = commitment["suggestedContactId"] as? String
                ?? (commitment["suggestedContactIds"] as? [String])?.first
            guard let contact else { continue }
            try await post("/api/commitments/decide", ["commitmentId": id, "decision": action, "contactId": contact])
        }
        let list = try await get("/api/requests")["requests"] as? [[String: Any]] ?? []
        let open = list.filter { ($0["state"] as? String) == "awaiting_approval" }
        guard open.count >= 4 else {
            throw Failure(description: "needs four requests awaiting approval; restart the demo server with --reset")
        }
        let ids = open.compactMap { $0["id"] as? String }
        let revisions = Dictionary(uniqueKeysWithValues: open.compactMap { row -> (String, String)? in
            guard let id = row["id"] as? String, let revision = row["revision"] as? String else { return nil }
            return (id, revision)
        })
        let seeded = Seeded(accept: ids[0], expire: ids[1], send: ids[2], cancel: ids[3])
        for id in [seeded.accept, seeded.expire, seeded.send] {
            try await post(
                "/api/requests/approve", ["requestId": id, "healthOverride": false],
                headers: ["If-Match": "\"\(revisions[id] ?? "")\""]
            )
        }
        for id in [seeded.accept, seeded.expire] {
            let result = try await post("/api/requests/send", ["requestId": id])
            guard (result["state"] as? String) == "requested" else {
                throw Failure(description: "send did not reach requested: \(result)")
            }
        }
        return seeded
    }

    /// request id to its message's position in the outbox list, through the gmail_message_id evidence
    func outboxIndex() async throws -> [String: Int] {
        let messages = try await get("/api/outbox")["messages"] as? [[String: Any]] ?? []
        let requests = try await get("/api/requests")["requests"] as? [[String: Any]] ?? []
        var out: [String: Int] = [:]
        for request in requests {
            guard let id = request["id"] as? String else { continue }
            let refs = (request["evidence"] as? [[String: Any]] ?? [])
                .filter { ($0["evidenceKind"] as? String) == "gmail_message_id" }
                .compactMap { $0["evidenceRef"] as? String }
            if let index = messages.firstIndex(where: { refs.contains(($0["id"] as? String) ?? "") }) {
                out[id] = index
            }
        }
        return out
    }
}
