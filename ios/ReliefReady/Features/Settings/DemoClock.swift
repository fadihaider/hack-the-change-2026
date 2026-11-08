import Foundation
import Observation

/// the demo clock in Settings: whether time is simulated, and moving it a day or back to real time
/// (DemoMenu in components/app/Shell.tsx)
@Observable
final class DemoClock {
    enum Busy: Equatable {
        case jump, reset
    }

    /// nil until GET /api/clock answers; true when the clock has been moved away from real time
    private(set) var simulated: Bool?
    private(set) var busy: Busy?
    /// the last result in words, also announced
    private(set) var status = ""

    @ObservationIgnored private let api: () -> APIClient
    @ObservationIgnored private let reload: () async -> Void
    @ObservationIgnored private let announce: (String) -> Void

    init(api: @escaping () -> APIClient, reload: @escaping () async -> Void, announce: @escaping (String) -> Void = { _ in }) {
        self.api = api
        self.reload = reload
        self.announce = announce
    }

    var timeLabel: String { Self.timeLabel(simulated) }

    /// asks again on each new appNow, which a moved clock causes by reloading the session
    func refreshSimulated() async {
        do {
            let clock = try await api().clock()
            simulated = clock.offsetMilliseconds != 0
        } catch {
            simulated = nil
        }
    }

    /// "Move time forward a day"
    func jump() async {
        guard busy == nil else { return }
        busy = .jump
        defer { busy = nil }
        do {
            let result = try await api().jumpClock(days: 1)
            await reload()
            report(Self.jumpMessage(appNow: result.appNow, expired: result.expiredRequestIds.count))
        } catch {
            report(error.userMessage)
        }
    }

    /// "Reset the clock"
    func reset() async {
        guard busy == nil else { return }
        busy = .reset
        defer { busy = nil }
        do {
            let result = try await api().resetClock()
            await reload()
            report("Clock is back to real time. It\u{2019}s \(Self.sentence(AlbertaTime.format(result.appNow)))")
        } catch {
            report(error.userMessage)
        }
    }

    func clearStatus() {
        status = ""
    }

    private func report(_ text: String) {
        status = text
        announce(text)
    }

    // MARK: - wording

    nonisolated static func timeLabel(_ simulated: Bool?) -> String {
        switch simulated {
        case true?: "Simulated time"
        case false?: "Real time"
        case nil: "App time"
        }
    }

    nonisolated static func jumpMessage(appNow: String, expired: Int) -> String {
        let extra = expired == 0
            ? ""
            : " \(expired) \(expired == 1 ? "message" : "messages") ran out of time for a reply."
        return "Moved forward a day. It\u{2019}s now \(sentence(AlbertaTime.format(appNow)))\(extra)"
    }

    /// "p.m." already ends a sentence; never write "p.m.."
    nonisolated static func sentence(_ text: String) -> String {
        text.hasSuffix(".") ? text : "\(text)."
    }

    /// isDemoRun: any adapter is a demo stand-in
    nonisolated static func isDemoRun(_ mode: SessionMode) -> Bool {
        mode.ai == "demo" || mode.mail == "outbox" || mode.calendar == "seed" || mode.auth == "demo"
    }
}
