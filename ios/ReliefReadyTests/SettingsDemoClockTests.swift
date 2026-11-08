import Foundation
import Testing
@testable import ReliefReady

@MainActor
struct SettingsDemoClockTests {
    @Test func wordingMatchesTheShellMenu() {
        #expect(DemoClock.timeLabel(nil) == "App time")
        #expect(DemoClock.timeLabel(true) == "Simulated time")
        #expect(DemoClock.timeLabel(false) == "Real time")
        #expect(DemoClock.sentence("Mon, Nov 9, 2:13 a.m.") == "Mon, Nov 9, 2:13 a.m.")
        #expect(DemoClock.sentence("No time set") == "No time set.")
        #expect(DemoClock.jumpMessage(appNow: "2026-11-09T08:13:32.649Z", expired: 0)
            == "Moved forward a day. It\u{2019}s now Mon, Nov 9, 2:13 a.m.")
        #expect(DemoClock.jumpMessage(appNow: "2026-11-09T20:00:00Z", expired: 1)
            == "Moved forward a day. It\u{2019}s now Mon, Nov 9, 2:00 p.m. 1 message ran out of time for a reply.")
        #expect(DemoClock.jumpMessage(appNow: "2026-11-09T20:00:00Z", expired: 3).hasSuffix(" 3 messages ran out of time for a reply."))
    }

    @Test func demoRunWhenAnyAdapterIsAStandIn() {
        let live = SessionMode(db: "supabase", ai: "gemini", mail: "gmail", calendar: "google", auth: "google", sms: "twilio")
        #expect(!DemoClock.isDemoRun(live))
        var outbox = live
        outbox.mail = "outbox"
        #expect(DemoClock.isDemoRun(outbox))
        var demoAI = live
        demoAI.ai = "demo"
        #expect(DemoClock.isDemoRun(demoAI))
    }

    @Test func jumpPostsOneDayReloadsAndReports() async throws {
        let body = #"{"appNow":"2026-11-09T08:13:32.649Z","realNow":"2026-11-08T08:13:32.649Z","offsetMilliseconds":86400000,"expiredRequestIds":["a","b"]}"#
        let (client, host) = StubProtocol.client(reply: .init(body: Data(body.utf8)))
        let reloads = StartRecorder()
        let spoken = StartRecorder()
        let clock = DemoClock(
            api: { client },
            reload: { reloads.count += 1 },
            announce: { text in spoken.items.append(text) }
        )
        await clock.jump()
        let sent = try #require(StubProtocol.requests(host: host).first)
        #expect(sent.request.url?.path() == "/api/clock/jump")
        #expect(sent.request.httpMethod == "POST")
        let json = try JSONSerialization.jsonObject(with: sent.body) as? [String: Any]
        #expect((json?["days"] as? NSNumber)?.intValue == 1)
        #expect(reloads.count == 1)
        #expect(clock.status == "Moved forward a day. It\u{2019}s now Mon, Nov 9, 2:13 a.m. 2 messages ran out of time for a reply.")
        #expect(spoken.items == [clock.status])
        #expect(clock.busy == nil)
    }

    @Test func aForbiddenJumpSaysOnlyAnAdminCan() async {
        let (client, _) = StubProtocol.client(reply: .init(status: 403, body: Data(#"{"error":{"code":"forbidden"}}"#.utf8)))
        let reloads = StartRecorder()
        let clock = DemoClock(api: { client }, reload: { reloads.count += 1 })
        await clock.jump()
        #expect(clock.status == "Only an admin account can move the demo clock.")
        #expect(reloads.count == 0)
    }

    @Test func resetReportsRealTime() async throws {
        let (client, host) = StubProtocol.client(reply: .init(body: try Fixtures.data("clock")))
        let clock = DemoClock(api: { client }, reload: {})
        await clock.reset()
        #expect(StubProtocol.requests(host: host).first?.request.url?.path() == "/api/clock/reset")
        #expect(clock.status == "Clock is back to real time. It\u{2019}s Sun, Nov 8, 2:12 a.m.")
        await clock.refreshSimulated()
        #expect(clock.simulated == false)
        clock.clearStatus()
        #expect(clock.status.isEmpty)
    }

    @Test func simulatedIsUnknownWhenTheClockFails() async {
        let (client, _) = StubProtocol.client(reply: .init(status: 500, body: Data("oops".utf8)))
        let clock = DemoClock(api: { client }, reload: {})
        await clock.refreshSimulated()
        #expect(clock.simulated == nil)
        #expect(clock.timeLabel == "App time")
    }
}
