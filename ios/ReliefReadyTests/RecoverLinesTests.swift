import Foundation
import Testing
@testable import ReliefReady

// expected strings follow components/app/recover/lines.ts and RecoverScreen.tsx word for word
struct RecoverLinesTests {
    static func request(
        _ state: RequestState, name: String = "Jordan Lee", id: String = UUID().uuidString,
        evidence: [RequestEvidence] = [], respondBy: String? = nil, proposedAt: String? = nil,
        approvalAt: String? = nil
    ) -> RequestView {
        RequestView(
            id: id, revision: String(repeating: "a", count: 64), state: state, action: .reschedule,
            recipient: RequestRecipient(contactId: "c", name: name, email: "x@example.test"),
            subject: "Request to reschedule", body: "Hi", disclosureTier: .minimal, defaultDisclosureTier: .minimal,
            healthTermsFound: [], healthOverride: false, respondBy: respondBy, proposedAt: proposedAt, proposedNote: nil,
            approval: approvalAt.map { RequestApproval(id: "1", hash: "h", at: $0) }, evidence: evidence
        )
    }

    static func event(
        _ kind: EvidenceKind, to: RequestState, from: RequestState? = nil, ref: String? = nil,
        at: String = "2026-11-08T08:11:52.102Z"
    ) -> RequestEvidence {
        RequestEvidence(
            id: UUID().uuidString, fromState: from, toState: to, evidenceKind: kind, evidenceRef: ref, actor: "system", at: at
        )
    }

    static let episode = EpisodeSummary(id: "e", startsOn: "2026-11-08", endsOn: "2026-11-14", status: "active")

    static func groups(
        handled: [RequestView] = [], waiting: [RequestView] = [], followUp: [RequestView] = [],
        notSent: [RequestView] = [], new: [RecoverNewItem] = []
    ) -> RecoverGroups {
        RecoverGroups(handled: handled, waiting: waiting, needsFollowUp: followUp, notSent: notSent, new: new)
    }

    @Test func sortPutsOpenUnsentFirstAndCountsWhatNeedsYou() {
        let cancelled = Self.request(.cancelled, id: "c1")
        let approved = Self.request(.approved, id: "a1")
        let expired = Self.request(.expired, id: "x1")
        let sorted = RecoverLines.sort(Self.groups(followUp: [expired], notSent: [cancelled, approved]))
        #expect(sorted.notSent.map(\.id) == ["a1", "c1"])
        #expect(sorted.needsYou.map(\.id) == ["x1", "a1"])
        #expect(sorted.total == 3)
    }

    @Test func headingVariants() {
        let name = "Rosa"
        let empty = RecoverLines.heading(RecoverLines.sort(Self.groups()), name: name, today: "2026-11-08", episode: Self.episode)
        #expect(empty == RecoverHeading(lead: "Nothing has gone out for Rosa\u{2019}s care week yet.", question: "Start with what the week affects?"))

        let waiting = RecoverLines.sort(Self.groups(waiting: [Self.request(.requested), Self.request(.requested, name: "Morgan Chen")]))
        #expect(
            RecoverLines.heading(waiting, name: name, today: "2026-11-08", episode: Self.episode)
                == RecoverHeading(lead: "Nothing needs you right now.", question: "Waiting for Jordan Lee and Morgan Chen to reply.")
        )

        let clear = RecoverLines.sort(Self.groups(handled: [Self.request(.accepted)], notSent: [Self.request(.cancelled)]))
        #expect(
            RecoverLines.heading(clear, name: name, today: "2026-11-15", episode: Self.episode)
                == RecoverHeading(lead: "Rosa\u{2019}s care week ended Saturday, Nov 14.", question: "You\u{2019}re clear to get back to normal.")
        )

        let open = RecoverLines.sort(Self.groups(notSent: [Self.request(.awaitingApproval)]))
        #expect(
            RecoverLines.heading(open, name: name, today: "2026-11-08", episode: Self.episode)
                == RecoverHeading(
                    lead: "Rosa\u{2019}s care week ends Saturday, Nov 14.",
                    question: "What\u{2019}s left before things are back to normal?"
                )
        )
        #expect(
            RecoverLines.weekLine(name: "Lucas", today: "2026-11-01", episode: Self.episode)
                == "Lucas\u{2019} care week starts Sunday, Nov 8."
        )
    }

    @Test func summaryLine() {
        let sorted = RecoverLines.sort(Self.groups(
            handled: [Self.request(.accepted)], waiting: [Self.request(.requested)],
            followUp: [Self.request(.expired), Self.request(.rejected)], notSent: [Self.request(.approved)]
        ))
        #expect(RecoverLines.summaryLine(sorted) == "2 need follow-up, 1 isn\u{2019}t sent, 1 is waiting for a reply and 1 is handled.")
        let one = RecoverLines.sort(Self.groups(waiting: [Self.request(.requested), Self.request(.requested)]))
        #expect(RecoverLines.summaryLine(one) == "2 are waiting for a reply.")
        #expect(RecoverLines.summaryLine(RecoverLines.sort(Self.groups())) == "")
    }

    @Test func statusLines() {
        let sent = Self.event(.gmailMessageId, to: .requested, at: "2026-11-08T08:11:52.102Z")
        let requested = Self.request(.requested, evidence: [sent], respondBy: "2026-11-10T08:11:52.098Z")
        #expect(
            RecoverLines.statusLine(requested, mail: "outbox")
                == "Placed in the demo outbox Sun, Nov 8, 2:11 a.m. No real email went out. Reply due by Tue, Nov 10, 2:11 a.m."
        )
        #expect(
            RecoverLines.statusLine(requested, mail: "gmail")
                == "Sent by email Sun, Nov 8, 2:11 a.m. Reply due by Tue, Nov 10, 2:11 a.m."
        )
        #expect(
            RecoverLines.statusLine(Self.request(.expired, respondBy: "2026-11-10T08:11:52.098Z"))
                == "No reply by Tue, Nov 10, 2:11 a.m."
        )
        #expect(RecoverLines.statusLine(Self.request(.expired)) == "No reply in time.")
        #expect(RecoverLines.statusLine(Self.request(.awaitingApproval)) == "Nothing has been sent. It\u{2019}s waiting for your OK.")
        #expect(
            RecoverLines.statusLine(Self.request(.approved, approvalAt: "2026-11-08T09:00:00Z"))
                == "You approved it Sun, Nov 8, 3:00 a.m., but it hasn\u{2019}t gone out yet."
        )
        let accepted = Self.request(.accepted, evidence: [Self.event(.linkClick, to: .accepted, at: "2026-11-08T20:30:00Z")])
        #expect(RecoverLines.statusLine(accepted) == "Said yes Sun, Nov 8, 2:30 p.m.")
        #expect(
            RecoverLines.statusLine(Self.request(.needsReview, proposedAt: "2026-11-16T16:00:00Z"))
                == "Asked for Mon, Nov 16, 10:00 a.m. instead."
        )
    }

    @Test func heldBackReadsAsHeldBackNeverAsAReply() {
        let held = Self.request(.needsReview, evidence: [
            Self.event(.error, to: .needsReview, from: .approved, ref: "health term at send", at: "2026-11-08T09:00:00Z")
        ])
        #expect(RecoverLines.heldBack(held))
        #expect(RecoverLines.pillLabel(held) == "Held back")
        #expect(
            RecoverLines.statusLine(held)
                == "Held back before sending Sun, Nov 8, 3:00 a.m.: a health word was found just before it went."
        )
        let replied = Self.request(.needsReview, evidence: [Self.event(.linkClick, to: .needsReview)])
        #expect(!RecoverLines.heldBack(replied))
        #expect(RecoverLines.pillLabel(replied) == nil)
        #expect(RecoverLines.statusLine(replied) == "Answered through their reply link. Check what they asked.")
    }

    @Test func evidenceLinesNeverShowRawRefs() {
        let request = Self.request(.accepted, name: "Jordan Lee")
        let lines = [
            Self.event(.userManual, to: .awaitingApproval, from: .draft),
            Self.event(.approval, to: .approved, ref: "20bfd31fc848a10e"),
            Self.event(.approval, to: .sending, ref: "3"),
            Self.event(.gmailMessageId, to: .requested, ref: "7851c431-d5ff"),
            Self.event(.linkClick, to: .accepted, ref: "629d5414a5a55b6c"),
            Self.event(.scheduler, to: .expired),
            Self.event(.error, to: .failed, ref: "gmail_send_failed"),
            Self.event(.error, to: .failed, ref: "secret-provider-text"),
        ].map { RecoverLines.evidenceLine($0, request: request, mail: "outbox") }
        #expect(lines == [
            "You chose this message to review.",
            "You approved this exact message.",
            "Placing it in the demo outbox started from your approval.",
            "Placed in the demo outbox. No real email went out.",
            "Jordan Lee chose Accept on their reply link.",
            "The reply deadline passed with no answer.",
            "It couldn\u{2019}t be placed in the demo outbox.",
            "Something stopped it.",
        ])
    }

    @Test func urgentLinks() {
        #expect(RecoverLines.urgentLabel(.awaitingApproval) == "Review and send in Urgent")
        #expect(RecoverLines.urgentLabel(.expired) == "Choose what to do in Urgent")
        #expect(RecoverLines.urgentLabel(.needsReview) == "Open it in Urgent")
        #expect(RecoverLines.urgentLabel(.accepted) == "See it in Urgent")
        #expect(RecoverLines.urgentLabel(.approved) == "See it in Urgent")
    }

    @Test func showUrgentPostsTheRequest() async {
        let center = NotificationCenter()
        let received = Locked<String?>(nil)
        let token = center.addObserver(forName: .reliefReadyShowUrgent, object: nil, queue: nil) { note in
            received.set(note.userInfo?[RecoverNavigation.requestIdKey] as? String)
        }
        defer { center.removeObserver(token) }
        await MainActor.run { RecoverNavigation.showUrgent(requestId: "r-42", center: center) }
        #expect(received.get() == "r-42")
    }

    @Test func checkAndSendMessages() throws {
        let before = RecoverLines.signature(Self.groups(waiting: [Self.request(.requested, id: "r1")]))
        let same = RecoverResponse(groups: Self.groups(waiting: [Self.request(.requested, id: "r1")]), appNow: "", expiredRequestIds: [])
        #expect(RecoverLines.checkMessage(before: before, after: same) == "Nothing new since you last looked.")
        let moved = RecoverResponse(groups: Self.groups(handled: [Self.request(.accepted, id: "r1")]), appNow: "", expiredRequestIds: [])
        #expect(RecoverLines.checkMessage(before: before, after: moved) == "The list now shows the newest replies.")
        let expired = RecoverResponse(groups: Self.groups(), appNow: "", expiredRequestIds: ["a", "b"])
        #expect(RecoverLines.checkMessage(before: before, after: expired) == "2 messages ran out of time for a reply.")

        let ok = RecoverLines.sendMessage(.requested(messageId: "m"), name: "Morgan Chen", mail: "outbox")
        #expect(ok.good)
        #expect(ok.text == "Placed in the demo outbox for Morgan Chen. No real email went out. Waiting for them to use a reply link.")
        #expect(!RecoverLines.sendMessage(.needsReview, name: "M", mail: "outbox").good)
        #expect(RecoverLines.actionMessage(APIError(code: "state_conflict", status: 409))
            == "This message changed somewhere else. The list now shows where it stands.")
        #expect(RecoverLines.newTimeTitle("Proposed: ENGG 513 meeting") == "ENGG 513 meeting")
        #expect(RecoverLines.newTimeTitle("  ") == "A new time")
    }

    @Test func fixtureGroupsDecodeAndSort() throws {
        let response = try Fixtures.decode(RecoverResponse.self, "recover-refresh")
        let sorted = RecoverLines.sort(response.groups)
        #expect(sorted.handled.first?.recipient.name == "Jordan Lee")
        #expect(RecoverLines.summaryLine(sorted).hasSuffix("handled."))
    }
}

/// a tiny thread-safe box for values set from notification callbacks
final class Locked<Value: Sendable>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    init(_ value: Value) { self.value = value }
    func set(_ next: Value) { lock.withLock { value = next } }
    func get() -> Value { lock.withLock { value } }
}
