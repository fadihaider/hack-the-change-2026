import Foundation
import Observation

/// the state behind RecoverView (RecoverScreen.tsx): the list, which row is busy or confirming, and what just happened
@Observable
final class RecoverModel {
    enum BusyKind: Sendable, Hashable { case send, cancel }

    struct Busy: Sendable, Hashable {
        var id: String
        var kind: BusyKind
    }

    /// what the last send or cancel did; good ones show as a receipt above the heading, bad ones as an error note
    struct Done: Sendable, Hashable {
        var good: Bool
        var text: String
        var systemImage: String = "checkmark"
    }

    private(set) var data: RecoverResponse?
    private(set) var loadError: String?
    private(set) var busy: Busy?
    /// the row whose "Don't send it" asks for a confirm
    var confirming: String?
    private(set) var done: Done?
    private(set) var checking = false
    private(set) var checked: String?
    /// bumped after each send or cancel, so the view can scroll back to the heading
    private(set) var actionCount = 0

    @ObservationIgnored private var sequence = 0
    /// a seam for tests and voiceover: called with each line the web announces
    @ObservationIgnored var announce: (String) -> Void = { _ in }

    init() {}

    /// POST /api/recover runs the owner's expiry sweep first, so a passed deadline already shows as "No reply in time".
    /// a later call wins over an earlier one that comes back late
    @discardableResult
    func load(api: APIClient) async -> RecoverResponse? {
        sequence += 1
        let mine = sequence
        do {
            let next = try await api.recoverRefresh()
            guard mine == sequence else { return nil }
            data = next
            loadError = nil
            return next
        } catch {
            guard mine == sequence else { return nil }
            loadError = error.userMessage
            return nil
        }
    }

    /// "Check for new replies"
    func check(api: APIClient) async {
        guard !checking else { return }
        checking = true
        checked = nil
        let before = data.map { RecoverLines.signature($0.groups) }
        let next = await load(api: api)
        checking = false
        guard let next else { return }
        let text = RecoverLines.checkMessage(before: before, after: next)
        checked = text
        announce(text)
    }

    /// "Send to X" on an approved row
    func send(_ request: RequestView, api: APIClient, mail: String) async {
        guard busy == nil else { return }
        let name = request.recipient.name
        busy = Busy(id: request.id, kind: .send)
        done = nil
        checked = nil
        do {
            let result = try await api.sendRequest(id: request.id)
            let message = RecoverLines.sendMessage(result, name: name, mail: mail)
            report(Done(good: message.good, text: message.text, systemImage: "paperplane"))
        } catch {
            report(Done(good: false, text: RecoverLines.actionMessage(error)))
        }
        busy = nil
        await load(api: api)
        actionCount += 1
    }

    /// "Yes, don't send it" after the confirm
    func cancel(_ request: RequestView, api: APIClient) async {
        guard busy == nil else { return }
        let name = request.recipient.name
        busy = Busy(id: request.id, kind: .cancel)
        done = nil
        checked = nil
        do {
            _ = try await api.cancelRequest(id: request.id)
            report(Done(good: true, text: "The message to \(name) won\u{2019}t be sent."))
        } catch {
            report(Done(good: false, text: RecoverLines.actionMessage(error)))
        }
        busy = nil
        confirming = nil
        await load(api: api)
        actionCount += 1
    }

    func isBusy(_ id: String, _ kind: BusyKind) -> Bool {
        busy == Busy(id: id, kind: kind)
    }

    private func report(_ next: Done) {
        done = next
        announce(next.text)
    }
}
