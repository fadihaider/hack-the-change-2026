import Foundation

/// the calls the urgent flow, its sheets and help nearby make; APIClient is the live one, tests pass a fake
nonisolated protocol UrgentAPI: Sendable {
    func impact(episodeId: String) async throws(APIError) -> ImpactResponse
    func decide(_ input: DecideInput) async throws(APIError) -> DecideResponse
    func reopen(commitmentId: String) async throws(APIError) -> ReopenResponse
    func addToTimeline(commitmentId: String) async throws(APIError) -> TimelineAddResponse
    func guide(address: String, tenure: Tenure) async throws(APIError) -> GuideResponse

    func requests() async throws(APIError) -> RequestList
    func refreshRequests() async throws(APIError) -> RequestRefresh
    func editRequest(id: String, changes: RequestChanges) async throws(APIError) -> RequestEnvelope
    func redraftRequest(id: String, tier: DisclosureTier) async throws(APIError) -> RedraftResult
    func approveRequest(id: String, revision: String, healthOverride: Bool) async throws(APIError) -> RequestEnvelope
    func cancelRequest(id: String) async throws(APIError) -> RequestEnvelope
    func sendRequest(id: String) async throws(APIError) -> SendResult

    func smsList(episodeId: String?) async throws(APIError) -> SmsList
    func smsRecipients() async throws(APIError) -> SmsRecipients
    func smsDraft(_ input: SmsDraftInput) async throws(APIError) -> SmsDraft
    func smsApprove(_ input: SmsApproveInput) async throws(APIError) -> SmsEnvelope
    func smsSend(requestId: String) async throws(APIError) -> SmsEnvelope
}

extension APIClient: UrgentAPI {}
