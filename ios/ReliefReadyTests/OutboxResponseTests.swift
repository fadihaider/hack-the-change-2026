import Foundation
import Testing
@testable import ReliefReady

struct OutboxResponseTests {
    static let accept = "QOBaDgUnG_AW7SShGnZiZy12HUQDC-W8ma2DOx8QqLY"
    static let decline = "O2kA-wcpVk_V3bDjDDauPUitDMphRpH-9E5cSMC2Ml4"
    static let propose = "wA5Ffeh74VA8CY_HvWEiGMvw7-XCN81NIcb_ikZgtyo"

    @Test func segmentsKeepTextAndMakeOnlyReplyLinksTappable() throws {
        let outbox = try Fixtures.decode(Outbox.self, "outbox")
        let message = try #require(outbox.messages.first)
        let segments = OutboxContent.segments(message.body)
        #expect(segments.count == 5, "\(segments)")
        try #require(segments.count == 5)
        #expect(segments[0] == .text("Hi, I need to step away this week for a family matter. Could we sort out a plan? Thanks, Alex"))
        #expect(segments[1] == .text("Respond (each link asks you to confirm):"))
        guard case .link(let label, let link) = segments[2] else { Issue.record("no accept link"); return }
        #expect(label == "Accept:")
        #expect(link.token == Self.accept)
        #expect(link.choice == .accept)
        guard case .link(_, let last) = segments[4] else { Issue.record("no propose link"); return }
        #expect(last.choice == .propose)
        #expect(last.token == Self.propose)

        // a lookalike link with a short token stays plain text
        let plain = OutboxContent.segments("See https://example.test/r/short and https://evil.test/x")
        #expect(plain == [.text("See https://example.test/r/short and https://evil.test/x")])
    }

    @Test func letterBodyDropsTheLinkBlock() throws {
        let message = try #require(try Fixtures.decode(Outbox.self, "outbox").messages.first)
        #expect(OutboxContent.letterBody(message.body)
            == "Hi, I need to step away this week for a family matter. Could we sort out a plan? Thanks, Alex")
        #expect(OutboxContent.letterBody("Hello\nAccept: http://h:1/r/\(Self.accept)") == "Hello")
    }

    @Test func outboxHeadings() {
        #expect(OutboxContent.question(count: 1) == "Here\u{2019}s the message that would have gone out.")
        #expect(OutboxContent.question(count: 3) == "Here are the 3 messages that would have gone out.")
        #expect(OutboxContent.textsTitle(count: 1) == "1 text that would have gone out")
        #expect(OutboxContent.textsTitle(count: 2) == "2 texts that would have gone out")
    }

    @Test func onlySimulatedTextsShowNewestFirst() {
        func text(_ id: String, _ delivery: SmsDelivery, _ at: String) -> SmsView {
            SmsView(
                id: id, episodeId: nil, state: .requested, delivery: delivery,
                recipient: SmsRecipient(label: "Lucia", phoneMasked: "***-***-0142"), senderName: "Alex", body: "Hi",
                disclosureTier: .minimal, healthTermsFound: [], healthOverride: false, provider: .demo,
                providerMessageId: nil, providerStatus: nil, errorCode: nil, submittedAt: at, statusAt: nil,
                approvedAt: nil, updatedAt: at
            )
        }
        let list = SmsList(provider: .demo, texts: [
            text("a", .simulated, "2026-11-08T08:00:00.000Z"),
            text("b", .notSent, "2026-11-08T09:00:00.000Z"),
            text("c", .simulated, "2026-11-08T10:00:00.000Z"),
        ])
        #expect(OutboxContent.simulatedTexts(list).map(\.id) == ["c", "a"])
    }

    @Test func previewComesFromTheMessageAndItsRequest() throws {
        let outbox = try Fixtures.decode(Outbox.self, "outbox")
        let requests = try Fixtures.decode(RecoverResponse.self, "recover-refresh").groups.handled
        let link = ResponseLink(url: "http://127.0.0.1:3107/r/\(Self.decline)", token: Self.decline, choice: .decline)
        let preview = try #require(ResponsePreview.build(link: link, outbox: outbox, requests: requests))
        #expect(preview.subject == "Request to reschedule ENGG 513 group project meeting")
        #expect(preview.choice == .decline)
        // the fixture's request was already accepted, so the page shows the closed message
        #expect(preview.state == "accepted")
        #expect(!preview.isOpen)
        #expect(preview.respondBy == "2026-11-10T08:11:52.098Z")
        #expect(ResponseLabels.closedMessage(preview.state) == "This request already has a recorded answer: Accepted.")

        // with no matching request it reads the message itself and stays open
        let bare = try #require(ResponsePreview.build(link: link, outbox: outbox, requests: []))
        #expect(bare.isOpen)
        #expect(bare.body == "Hi, I need to step away this week for a family matter. Could we sort out a plan? Thanks, Alex")

        // an unknown token is the 404 page
        let unknown = ResponseLink(url: "x", token: String(repeating: "z", count: 43), choice: .accept)
        #expect(ResponsePreview.build(link: unknown, outbox: outbox, requests: requests) == nil)
    }

    @Test func responseCopy() {
        #expect(ResponseCopy.ask(.accept).button == "Accept the request")
        #expect(ResponseCopy.ask(.decline).ask == "Decline this request?")
        #expect(ResponseCopy.ask(.propose).lead == "Nothing is recorded until you send it.")
        let recorded = ResponseCopy.doneHeading(ResponseResult(state: "accepted", recorded: true))
        #expect(recorded.lead == "Thank you.")
        #expect(recorded.question == "Your answer was recorded: Accepted.")
        let proposed = ResponseCopy.doneHeading(ResponseResult(state: "needs_review", recorded: true))
        #expect(proposed.question == "Your answer was recorded: Another time was proposed.")
        let late = ResponseCopy.doneHeading(ResponseResult(state: "expired", recorded: false))
        #expect(late.lead == nil)
        #expect(late.question == "This request expired before an answer was recorded.")
        #expect(ResponseCopy.Failure.notFound.title == "This link is invalid or has expired.")
    }

    @Test func noteLimitCountsCodePoints() {
        #expect(ResponseCopy.length("ab\u{1F600}") == 3)
        let long = String(repeating: "x", count: 310)
        #expect(ResponseCopy.clipped(long).count == ResponseCopy.noteMax)
        #expect(ResponseCopy.clipped("short") == "short")
    }

    @Test func defaultProposalIsTenTomorrowInAlberta() throws {
        let now = try #require(AlbertaTime.parse("2026-11-08T08:54:49.974Z"))
        let picked = ResponseCopy.defaultProposal(after: now)
        #expect(AlbertaTime.isoString(picked) == "2026-11-09T10:00:00-06:00")
        #expect(ResponseProposal(at: picked, note: "Tuesday works").at == "2026-11-09T10:00:00-06:00")
    }

    @Test func respondSendsTheProposalBody() async throws {
        let (client, host) = StubProtocol.client(reply: .init(body: Data(#"{"state":"needs_review","recorded":true}"#.utf8)))
        let at = try #require(AlbertaTime.parse("2026-11-10T15:00:00Z"))
        let result = try await client.respond(token: Self.propose, proposal: ResponseProposal(at: at, note: " Tuesday "))
        #expect(result == ResponseResult(state: "needs_review", recorded: true))
        let sent = try #require(StubProtocol.requests(host: host).first)
        #expect(sent.request.url?.path() == "/api/responses/\(Self.propose)")
        let body = try JSONSerialization.jsonObject(with: sent.body) as? [String: [String: String]]
        #expect(body == ["proposal": ["at": "2026-11-10T09:00:00-06:00", "note": "Tuesday"]])
    }

    @Test func responseErrorsUseTheReplyPageWording() {
        #expect(APIError(code: "not_found", status: 404).responseMessage == "This link is invalid or has expired.")
        #expect(APIError.network.responseMessage == "The connection dropped before your answer was recorded. Try again.")
    }
}
