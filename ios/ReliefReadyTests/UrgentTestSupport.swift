import Foundation
@testable import ReliefReady

/// a scripted UrgentAPI: each call runs its handler and is recorded by name
final class FakeUrgentAPI: UrgentAPI, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    var calls: [String] { lock.withLock { recorded } }

    func record(_ call: String) {
        lock.withLock { recorded.append(call) }
    }

    static let unexpected = APIError(code: "unexpected_call", status: 0)

    var impactHandler: (String) throws(APIError) -> ImpactResponse = { _ throws(APIError) in throw unexpected }
    var decideHandler: (DecideInput) throws(APIError) -> DecideResponse = { _ throws(APIError) in throw unexpected }
    var reopenHandler: (String) throws(APIError) -> ReopenResponse = { id throws(APIError) in
        ReopenResponse(commitment: ReopenedCommitment(id: id, decision: nil, reopened: true))
    }
    var timelineHandler: (String) throws(APIError) -> TimelineAddResponse = { _ throws(APIError) in
        TimelineAddResponse(eventId: "event-1", created: true)
    }
    var guideHandler: (String, Tenure) throws(APIError) -> GuideResponse = { _, _ throws(APIError) in throw unexpected }
    var requestsHandler: () throws(APIError) -> RequestList = { () throws(APIError) in
        RequestList(requests: [], appNow: "2026-11-08T08:00:00.000Z")
    }
    var refreshHandler: () throws(APIError) -> RequestRefresh = { () throws(APIError) in throw unexpected }
    var editHandler: (String, RequestChanges) throws(APIError) -> RequestEnvelope = { _, _ throws(APIError) in throw unexpected }
    var redraftHandler: (String, DisclosureTier) throws(APIError) -> RedraftResult = { _, _ throws(APIError) in throw unexpected }
    var approveHandler: (String, String, Bool) throws(APIError) -> RequestEnvelope = { _, _, _ throws(APIError) in throw unexpected }
    var cancelHandler: (String) throws(APIError) -> RequestEnvelope = { _ throws(APIError) in throw unexpected }
    var sendHandler: (String) throws(APIError) -> SendResult = { _ throws(APIError) in throw unexpected }
    var smsListHandler: (String?) throws(APIError) -> SmsList = { _ throws(APIError) in SmsList(provider: .demo, texts: []) }
    var smsRecipientsHandler: () throws(APIError) -> SmsRecipients = { () throws(APIError) in throw unexpected }
    var smsDraftHandler: (SmsDraftInput) throws(APIError) -> SmsDraft = { _ throws(APIError) in throw unexpected }
    var smsApproveHandler: (SmsApproveInput) throws(APIError) -> SmsEnvelope = { _ throws(APIError) in throw unexpected }
    var smsSendHandler: (String) throws(APIError) -> SmsEnvelope = { _ throws(APIError) in throw unexpected }

    func impact(episodeId: String) async throws(APIError) -> ImpactResponse {
        record("impact")
        return try impactHandler(episodeId)
    }

    func decide(_ input: DecideInput) async throws(APIError) -> DecideResponse {
        record("decide:\(input.decision.rawValue)")
        return try decideHandler(input)
    }

    func reopen(commitmentId: String) async throws(APIError) -> ReopenResponse {
        record("reopen:\(commitmentId)")
        return try reopenHandler(commitmentId)
    }

    func addToTimeline(commitmentId: String) async throws(APIError) -> TimelineAddResponse {
        record("timeline:\(commitmentId)")
        return try timelineHandler(commitmentId)
    }

    func guide(address: String, tenure: Tenure) async throws(APIError) -> GuideResponse {
        record("guide:\(tenure.rawValue)")
        return try guideHandler(address, tenure)
    }

    func requests() async throws(APIError) -> RequestList {
        record("requests")
        return try requestsHandler()
    }

    func refreshRequests() async throws(APIError) -> RequestRefresh {
        record("refresh")
        return try refreshHandler()
    }

    func editRequest(id: String, changes: RequestChanges) async throws(APIError) -> RequestEnvelope {
        record("edit:\(id)")
        return try editHandler(id, changes)
    }

    func redraftRequest(id: String, tier: DisclosureTier) async throws(APIError) -> RedraftResult {
        record("redraft:\(tier.rawValue)")
        return try redraftHandler(id, tier)
    }

    func approveRequest(id: String, revision: String, healthOverride: Bool) async throws(APIError) -> RequestEnvelope {
        record("approve:\(revision.prefix(8)):\(healthOverride)")
        return try approveHandler(id, revision, healthOverride)
    }

    func cancelRequest(id: String) async throws(APIError) -> RequestEnvelope {
        record("cancel:\(id)")
        return try cancelHandler(id)
    }

    func sendRequest(id: String) async throws(APIError) -> SendResult {
        record("send:\(id)")
        return try sendHandler(id)
    }

    func smsList(episodeId: String?) async throws(APIError) -> SmsList {
        record("smsList")
        return try smsListHandler(episodeId)
    }

    func smsRecipients() async throws(APIError) -> SmsRecipients {
        record("smsRecipients")
        return try smsRecipientsHandler()
    }

    func smsDraft(_ input: SmsDraftInput) async throws(APIError) -> SmsDraft {
        record("smsDraft")
        return try smsDraftHandler(input)
    }

    func smsApprove(_ input: SmsApproveInput) async throws(APIError) -> SmsEnvelope {
        record("smsApprove")
        return try smsApproveHandler(input)
    }

    func smsSend(requestId: String) async throws(APIError) -> SmsEnvelope {
        record("smsSend")
        return try smsSendHandler(requestId)
    }
}

/// fixture shortcuts for the urgent tests
enum UrgentFixtures {
    static let groupMeetingId = "f414e65a-a9c0-402c-85cf-090a24924e66"
    static let rosaId = "a4ae1747-377b-41b0-a9a5-c78e6a2a37dd"
    static let jordanId = "9aa372e6-941c-45e5-949c-8c611d18aaf7"
    static let samId = "c1f2e3f8-dafe-4528-8d51-135c0dd1a6f6"
    static let appNow = "2026-11-08T08:00:00.000Z"

    static func impact() throws -> ImpactResponse { try Fixtures.decode(ImpactResponse.self, "impact") }
    static func decide() throws -> DecideResponse { try Fixtures.decode(DecideResponse.self, "decide") }
    /// Jordan's draft, awaiting approval
    static func draft() throws -> RequestView { try Fixtures.decode(RequestList.self, "requests").requests[0] }
    static func edited() throws -> RequestView { try Fixtures.decode(RequestEnvelope.self, "request-edit").request }
    static func approved() throws -> RequestView { try Fixtures.decode(RequestEnvelope.self, "request-approve").request }
    static func refreshed() throws -> RequestRefresh { try Fixtures.decode(RequestRefresh.self, "requests-refresh") }

    static let care = CareName(name: "Rosa", alias: "Mom")
}
