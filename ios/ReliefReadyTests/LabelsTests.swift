import Foundation
import Testing
@testable import ReliefReady

// expected values were computed by running the TypeScript helpers (live-api.ts, passport.ts, ui.tsx) under node
struct LabelsTests {
    @Test(arguments: [
        ("2026-11-08T08:13:32.649Z", "Sun, Nov 8, 2:13 a.m.", "Sun, Nov 8", "2:13 a.m."),
        ("2026-11-09T16:00:00.000Z", "Mon, Nov 9, 10:00 a.m.", "Mon, Nov 9", "10:00 a.m."),
        ("2026-11-14T05:59:00Z", "Fri, Nov 13, 11:59 p.m.", "Fri, Nov 13", "11:59 p.m."),
        ("2026-12-01T18:00:00Z", "Tue, Dec 1, 12:00 p.m.", "Tue, Dec 1", "12:00 p.m."),
        ("2026-11-10T06:00:00Z", "Tue, Nov 10, 12:00 a.m.", "Tue, Nov 10", "12:00 a.m."),
        ("2026-09-15T18:05:00-00:00", "Tue, Sep 15, 12:05 p.m.", "Tue, Sep 15", "12:05 p.m."),
    ])
    func formatAlberta(_ iso: String, _ full: String, _ day: String, _ time: String) {
        #expect(AlbertaTime.format(iso) == full)
        #expect(AlbertaTime.format(iso, style: .day) == day)
        #expect(AlbertaTime.format(iso, style: .time) == time)
    }

    @Test func possessive() {
        #expect(Labels.possessive("Rosa") == "Rosa\u{2019}s")
        #expect(Labels.possessive("James") == "James\u{2019}")
    }

    @Test func formatAlbertaWithoutATime() {
        #expect(AlbertaTime.format(nil) == "No time set")
        #expect(AlbertaTime.format("nope") == "No time set")
    }

    @Test func albertaISOStringFitsBothServerValidators() throws {
        // zod iso.datetime({offset:true}) needs seconds and a colon offset; the web form sends `${at}:00-06:00`
        let date = try #require(AlbertaTime.parse("2026-11-10T15:00:00Z"))
        #expect(AlbertaTime.isoString(date) == "2026-11-10T09:00:00-06:00")
        #expect(AlbertaTime.isoString(try #require(AlbertaTime.parse("2026-11-11T05:59:59.900Z"))) == "2026-11-10T23:59:59-06:00")
        #expect(AlbertaTime.parse(AlbertaTime.isoString(date)) == date)
        let proposal = ResponseProposal(at: date, note: "  ")
        #expect(proposal.at == "2026-11-10T09:00:00-06:00")
        #expect(proposal.note == nil)
        #expect(ResponseProposal(at: date, note: " Tuesday works ").note == "Tuesday works")
    }

    @Test func albertaDates() throws {
        #expect(AlbertaTime.dateString(of: try #require(AlbertaTime.parse("2026-11-09T05:59:00Z"))) == "2026-11-08")
        #expect(AlbertaTime.dateString(of: try #require(AlbertaTime.parse("2026-11-09T06:00:00Z"))) == "2026-11-09")
        #expect(AlbertaTime.addDays("2026-11-08", 1) == "2026-11-09")
        #expect(AlbertaTime.addDays("2026-11-30", 2) == "2026-12-02")
        #expect(AlbertaTime.addDays("2026-11-08", -8) == "2026-10-31")
        #expect(AlbertaTime.shortDate("2026-11-10") == "Nov 10")
        #expect(AlbertaTime.shortDate("bad") == "Confirm dates")
        #expect(AlbertaTime.weekRange("2026-11-08", "2026-11-14") == "Nov 8 to 14")
        #expect(AlbertaTime.weekRange("2026-11-28", "2026-12-03") == "Nov 28 to Dec 3")
        #expect(AlbertaTime.weekRange("x", "y") == "dates to confirm")
        #expect(AlbertaTime.dayLabel("2026-11-08") == "Sunday, Nov 8")
        #expect(AlbertaTime.dayLabel("2026-11-08", short: true) == "Sun, Nov 8")
        #expect(AlbertaTime.dayLabel("bad") == "a date to confirm")
        #expect(AlbertaTime.timeZone.secondsFromGMT() == -21600)
    }

    @Test func categoryAndSource() {
        #expect([nil, "medical_instruction", "practical", "daily_routine", "routine"].map(Labels.category) == [
            "appointment", "medical instruction as written", "practical needs and belongings", "daily routine", "routine",
        ])
        #expect(["voice", "document", "note", nil, "x"].map(Labels.source) == [
            "Voice note", "PDF document", "Typed note", "Unknown source", "Unknown source",
        ])
    }

    @Test(arguments: [
        (nil, "Once"),
        ("FREQ=DAILY", "Every day"),
        ("RRULE:FREQ=DAILY;INTERVAL=2", "Every 2 days"),
        ("FREQ=WEEKLY;BYDAY=MO", "Every week on Monday"),
        ("FREQ=WEEKLY;BYDAY=MO,WE,FR", "Every week on Monday, Wednesday and Friday"),
        ("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH", "Every 2 weeks on Tuesday and Thursday"),
        ("FREQ=WEEKLY", "Every week"),
        ("FREQ=MONTHLY", "Repeats"),
    ] as [(String?, String)])
    func rrule(_ rule: String?, _ expected: String) {
        #expect(Labels.rrule(rule) == expected)
    }

    @Test func modeLabels() {
        let demo = Labels.modes(
            SessionMode(db: "pglite", ai: "demo", mail: "outbox", calendar: "seed", auth: "demo", sms: "demo"),
            providers: Providers(speech: .off, retrieval: .keyword)
        )
        #expect(demo.map(\.name) == ["AI", "Mail", "Calendar", "Speech", "Ask retrieval", "DB", "Sign-in", "Texts"])
        #expect(demo.map(\.value) == [
            "Demo rules (offline)", "Demo outbox", "Seeded demo calendar", "Off", "Keyword", "Local PGlite",
            "Demo (fictional Alex)", "Demo text outbox (simulated)",
        ])
        let live = Labels.modes(
            SessionMode(db: "x", ai: "gemini", mail: "gmail", calendar: "google", auth: "google", sms: nil),
            providers: Providers(speech: .elevenlabs, retrieval: .vector)
        )
        #expect(live.map(\.value) == ["Gemini", "Gmail", "Google", "ElevenLabs Scribe", "Keyword + vectors", "x", "Google"])
    }

    @Test func passportSections() {
        #expect(["routine", "mobility", "preference", "medical_instruction", "logistics", "unknown"].map(PassportSection.section) == [
            .routine, .communication, .preferences, .instructions, .contacts, .practical,
        ])
        #expect(PassportSection.all.map(\.id) == PassportSectionID.allCases)
    }

    @Test func safeLinks() {
        #expect(Labels.safeURL("https://example.com/a b")?.absoluteString == "https://example.com/a%20b")
        #expect(Labels.safeURL("http://x.test")?.host() == "x.test")
        #expect(Labels.safeURL("javascript:alert(1)") == nil)
        #expect(Labels.safeURL("") == nil)
        #expect(Labels.safeURL("nope") == nil)
        #expect(Labels.safeURL(nil) == nil)
    }

    @Test func statesAndDecisions() {
        #expect(Labels.state(.awaitingApproval) == "Needs your OK")
        #expect(Labels.state(.failed) == "Didn\u{2019}t send")
        #expect(Labels.tone(.accepted) == .good)
        #expect(Labels.tone(.expired) == .warn)
        #expect(Labels.tone(.failed) == .bad)
        #expect(Labels.tone(.awaitingApproval) == .ask)
        #expect(Labels.tone(.requested) == .plain)
        #expect(Labels.decision(.extension) == "Request extension")
        #expect(Labels.decisionChoice(.coverage) == "Find someone to cover")
    }

    @Test func initials() {
        #expect(Labels.initials("Jordan Lee") == "JL")
        #expect(Labels.initials("Dr. Sam Patel") == "SP")
        #expect(Labels.initials("lucia") == "L")
        #expect(Labels.initials("  ") == "?")
        // toneFor in ui.tsx: (hash * 31 + code) >>> 0, then % 6
        #expect(Labels.avatarToneIndex("Jordan Lee") == 2)
        #expect(Labels.avatarToneIndex("Aunt Lucia") == 0)
    }
}

struct APIErrorMessageTests {
    @Test func liveMessages() {
        #expect(APIError(code: "invalid_input", status: 400).userMessage == "Some details were not accepted. Check them and try again.")
        #expect(APIError(code: "address_not_found", status: 422, detail: "Try a street address.").userMessage == "Try a street address.")
        #expect(APIError(code: "whatever", status: 409).userMessage == "This request changed elsewhere. Refresh and review its recorded state.")
        #expect(APIError(code: "precondition_required", status: 428).userMessage.hasPrefix("This approval preview is out of date."))
        #expect(APIError(code: "health_terms", status: 422).userMessage.hasPrefix("Health terms need your review."))
        #expect(APIError(code: "not_found", status: 404).userMessage == "The live workspace is not available yet. The demo remains available.")
        // the web turns a fetch failure into RequestApiError("network_error", 0): apiErrorMessage's last line
        #expect(APIError.network.userMessage == "The action could not be confirmed. Refresh the recorded state before trying again.")
        #expect(APIError.invalidResponse().userMessage.hasPrefix("The live service returned an unexpected response."))
    }

    @Test func speechMessages() {
        #expect(APIError(code: "speech_not_configured", status: 503).speechMessage == APIError.speechOffMessage)
        #expect(APIError(code: "invalid_response", status: 404).speechMessage == APIError.speechOffMessage)
        #expect(APIError(code: "x", status: 413).speechMessage.hasPrefix("That recording is too long"))
        #expect(APIError(code: "speech_off", status: 503).isSpeechUnavailable)
        #expect(!APIError(code: "invalid_audio", status: 400).canRetrySameRecording)
        #expect(APIError.network.canRetrySameRecording)
    }

    @Test func responsePageMessages() {
        #expect(APIError(code: "not_found", status: 404).responseMessage == "This link is invalid or has expired.")
        #expect(APIError(code: "rate_limited", status: 429).responseMessage.hasPrefix("Too many tries from this network."))
        #expect(APIError(code: "invalid_input", status: 400).responseMessage == "Check the date and time, and keep the note to 300 characters.")
        #expect(APIError(code: "x", status: 400).responseMessage == "This answer couldn\u{2019}t be read. Try again.")
        #expect(APIError(code: "invalid_origin", status: 403).responseMessage == "Open this page from the link in the email, then try again.")
        #expect(APIError(code: "state_conflict", status: 409).responseMessage.hasPrefix("This request changed while you were answering."))
        #expect(APIError.invalidResponse().responseMessage == "Your answer wasn\u{2019}t recorded. Nothing was saved, so try again.")
        #expect(APIError.network.responseMessage == "The connection dropped before your answer was recorded. Try again.")
        #expect(ResponseLabels.closedMessage("expired") == "This request expired before an answer was recorded.")
        #expect(ResponseLabels.closedMessage("needs_review") == "This request already has a recorded answer: Another time was proposed.")
        #expect(ResponseLabels.closedMessage("odd") == "This request already has a recorded answer: odd.")
    }

    @Test func homeMessages() {
        #expect(APIError(code: "no_home_area", status: 404).homeMessage(name: "Rosa").hasPrefix("Rosa\u{2019}s community"))
        #expect(APIError(code: "invalid_input", status: 400).homeMessage(name: "Rosa") == APIError.errorText["invalid_input"])
    }

    @Test func retryAfter() {
        #expect(APIError.parseRetryAfter("30") == 30)
        #expect(APIError.parseRetryAfter("soon") == nil)
        #expect(APIError.parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT") == 0)
    }
}

@MainActor
struct ServerConfigTests {
    private func freshDefaults() -> UserDefaults {
        let name = "rr-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test func launchArgumentWins() {
        let config = ServerConfig(defaults: freshDefaults(), arguments: ["app", "-ServerURL", "http://10.0.0.2:3107"])
        #expect(config.baseURL.absoluteString == "http://10.0.0.2:3107")
        #expect(config.origin == "http://10.0.0.2:3107")
        #expect(config.isOverridden)
    }

    @Test func defaultsOnTheSimulator() {
        let config = ServerConfig(defaults: freshDefaults(), arguments: ["app"])
        #expect(config.baseURL == ServerConfig.simulatorDefault)
    }

    @Test func updateKeepsOnlyTheOriginAndPersists() {
        let defaults = freshDefaults()
        let config = ServerConfig(defaults: defaults, arguments: ["app"])
        #expect(config.update(" 192.168.1.20:3000/care?x=1 "))
        #expect(config.baseURL.absoluteString == "http://192.168.1.20:3000")
        #expect(ServerConfig(defaults: defaults, arguments: ["app"]).baseURL.absoluteString == "http://192.168.1.20:3000")
        #expect(!config.update("ftp://example.com"))
        config.reset()
        #expect(config.baseURL == ServerConfig.platformDefault)
    }

    @Test func originOmitsADefaultPort() {
        #expect(ServerConfig.origin(of: URL(string: "https://relief.example")!) == "https://relief.example")
        // new URL(x).origin drops 80 for http and 443 for https
        #expect(ServerConfig.origin(of: URL(string: "http://h:80")!) == "http://h")
        #expect(ServerConfig.origin(of: URL(string: "https://abc.ngrok.app:443")!) == "https://abc.ngrok.app")
        #expect(ServerConfig.origin(of: URL(string: "https://h:80")!) == "https://h:80")
        #expect(ServerConfig.origin(of: URL(string: "http://h:443")!) == "http://h:443")
        #expect(ServerConfig.normalized("http://h:80/x")?.absoluteString == "http://h")
        #expect(ServerConfig.normalized("HTTPS://Abc.ngrok.app:443")?.absoluteString == "https://abc.ngrok.app")
        #expect(ServerConfig.normalized("h:80")?.absoluteString == "http://h")
        #expect(ServerConfig.normalized("http://127.0.0.1:3107")?.absoluteString == "http://127.0.0.1:3107")
    }
}
