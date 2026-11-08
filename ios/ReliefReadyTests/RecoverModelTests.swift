import Foundation
import Testing
@testable import ReliefReady

@MainActor
struct RecoverModelTests {
    /// one body that decodes both as a send result and as the recover list, since a stub host has one reply
    static func body(groups: String, expired: [String] = [], extra: String = "") throws -> Data {
        let ids = expired.map { "\"\($0)\"" }.joined(separator: ",")
        return Data("{\(extra)\"groups\":\(groups),\"appNow\":\"2026-11-08T09:00:00.000Z\",\"expiredRequestIds\":[\(ids)]}".utf8)
    }

    static func fixtureGroups() throws -> String {
        let data = try Fixtures.data("recover-refresh")
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let groups = try JSONSerialization.data(withJSONObject: object["groups"] ?? [:])
        return String(decoding: groups, as: UTF8.self)
    }

    static let emptyGroups = #"{"handled":[],"waiting":[],"needsFollowUp":[],"notSent":[],"new":[]}"#

    @Test func loadPostsTheSweepAndKeepsTheList() async throws {
        let (client, host) = StubProtocol.client(reply: .init(body: try Self.body(groups: Self.fixtureGroups())))
        let model = RecoverModel()
        await model.load(api: client)
        #expect(model.data?.groups.handled.count == 1)
        #expect(model.loadError == nil)
        let sent = StubProtocol.requests(host: host)
        #expect(sent.count == 1)
        #expect(sent.first?.request.httpMethod == "POST")
        #expect(sent.first?.request.url?.path() == "/api/recover")
    }

    @Test func loadErrorKeepsPlainWords() async {
        let (client, _) = StubProtocol.client(reply: .init(status: 503, body: Data(#"{"error":{"code":"unavailable"}}"#.utf8)))
        let model = RecoverModel()
        await model.load(api: client)
        #expect(model.data == nil)
        #expect(model.loadError == "The live workspace is not available yet. The demo remains available.")
    }

    @Test func checkReportsExpiredMessages() async throws {
        let (client, _) = StubProtocol.client(reply: .init(body: try Self.body(groups: Self.emptyGroups, expired: ["r1"])))
        let model = RecoverModel()
        var announced: [String] = []
        model.announce = { announced.append($0) }
        await model.check(api: client)
        #expect(model.checked == "1 message ran out of time for a reply.")
        #expect(announced == ["1 message ran out of time for a reply."])
        #expect(!model.checking)
    }

    @Test func sendReportsTheOutboxAndReloads() async throws {
        let reply = try Self.body(groups: Self.emptyGroups, extra: #""state":"requested","messageId":"m1","#)
        let (client, host) = StubProtocol.client(reply: .init(body: reply))
        let model = RecoverModel()
        let request = RecoverLinesTests.request(.approved, name: "Dr. Avery Brooks", id: "r9")
        await model.send(request, api: client, mail: "outbox")
        #expect(model.done?.good == true)
        #expect(model.done?.text == "Placed in the demo outbox for Dr. Avery Brooks. No real email went out. Waiting for them to use a reply link.")
        #expect(model.busy == nil)
        #expect(model.actionCount == 1)
        let paths = StubProtocol.requests(host: host).map { $0.request.url?.path() ?? "" }
        #expect(paths == ["/api/requests/send", "/api/recover"])
        let body = try JSONSerialization.jsonObject(with: StubProtocol.requests(host: host)[0].body) as? [String: String]
        #expect(body == ["requestId": "r9"])
    }

    @Test func cancelConflictSaysWhereItStands() async {
        let (client, host) = StubProtocol.client(reply: .init(status: 409, body: Data(#"{"error":{"code":"state_conflict"}}"#.utf8)))
        let model = RecoverModel()
        let request = RecoverLinesTests.request(.awaitingApproval, id: "r3")
        model.confirming = "r3"
        await model.cancel(request, api: client)
        #expect(model.done == RecoverModel.Done(good: false, text: "This message changed somewhere else. The list now shows where it stands."))
        #expect(model.confirming == nil)
        #expect(StubProtocol.requests(host: host).first?.request.url?.path() == "/api/requests/cancel")
    }
}
