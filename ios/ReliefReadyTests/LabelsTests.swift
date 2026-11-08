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

    @Test func formatAlbertaWithoutATime() {
        #expect(AlbertaTime.format(nil) == "No time set")
        #expect(AlbertaTime.format("nope") == "No time set")
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
        #expect(APIError.network.userMessage == "The live service could not be reached. Refresh before taking another action.")
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
    }
}
