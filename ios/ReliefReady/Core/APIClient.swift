import Foundation

/// one described call: method, path, query, body, extra headers and timeout
nonisolated struct APIRequest: Sendable, Hashable {
    enum Body: Sendable, Hashable {
        case none
        case json(JSONValue)
        case multipart(MultipartFile)
    }

    var path: String
    var query: [URLQueryItem]
    var body: Body
    var headers: [String: String]
    var timeout: TimeInterval

    init(
        _ path: String, query: [URLQueryItem] = [], body: Body = .none, headers: [String: String] = [:],
        timeout: TimeInterval = APIClient.Timeout.standard
    ) {
        self.path = path
        self.query = query
        self.body = body
        self.headers = headers
        self.timeout = timeout
    }

    /// GET when there is no body, POST otherwise (createCaller in request-api.ts)
    var method: String {
        if case .none = body { return "GET" }
        return "POST"
    }
}

/// a multipart/form-data body with exactly one field named "file"
nonisolated struct MultipartFile: Sendable, Hashable {
    var data: Data
    var filename: String
    var contentType: String
    var boundary: String

    init(data: Data, filename: String, contentType: String, boundary: String = "ReliefReady-\(UUID().uuidString)") {
        self.data = data
        self.filename = filename
        self.contentType = contentType
        self.boundary = boundary
    }

    var headerValue: String { "multipart/form-data; boundary=\(boundary)" }

    var encoded: Data {
        var out = Data()
        out.append(Data("--\(boundary)\r\n".utf8))
        out.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(Self.escaped(filename))\"\r\n".utf8))
        out.append(Data("Content-Type: \(contentType)\r\n\r\n".utf8))
        out.append(data)
        out.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return out
    }

    /// a filename as browsers put it in a part header: quote, cr and lf percent-encoded (whatwg multipart rules)
    static func escaped(_ filename: String) -> String {
        filename
            .replacingOccurrences(of: "\"", with: "%22")
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
    }
}

/// the typed http client for the ReliefReady server: one method per endpoint the web app calls.
/// every post sends Origin and strict json bodies; failures throw APIError
nonisolated final class APIClient: Sendable {
    enum Timeout {
        static let standard: TimeInterval = 15
        static let session: TimeInterval = 6
        /// intake, impact, decide, ask, care text, redraft, guide and the sms draft
        static let model: TimeInterval = 90
        /// a pdf upload
        static let upload: TimeInterval = 120
        /// the server gives the provider 60 s to transcribe and 60 s to delete its copy (speech-api.ts)
        static let transcribe: TimeInterval = 130
        /// sms-api.ts gives the send 30 s
        static let smsSend: TimeInterval = 30
    }

    let baseURL: URL
    /// scheme://host:port, sent as Origin on every post
    let origin: String
    private let urlSession: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.origin = ServerConfig.origin(of: baseURL)
        self.urlSession = session
    }

    // MARK: - session and clock

    /// GET /api/session
    func session() async throws(APIError) -> Session {
        try await send(APIRequest("/api/session", timeout: Timeout.session))
    }

    /// GET /api/clock
    func clock() async throws(APIError) -> ClockView {
        try await send(APIRequest("/api/clock"))
    }

    /// POST /api/clock/jump {days}; admin only, days is a positive integer
    func jumpClock(days: Int) async throws(APIError) -> ClockJump {
        try await send(APIRequest("/api/clock/jump", body: .json(["days": .number(Double(days))])))
    }

    /// POST /api/clock/reset {}
    func resetClock() async throws(APIError) -> ClockView {
        try await send(APIRequest("/api/clock/reset", body: .json([:])))
    }

    // MARK: - urgent

    /// POST /api/intake {statement}
    func intake(statement: String) async throws(APIError) -> IntakeResponse {
        try await send(APIRequest("/api/intake", body: .json(["statement": .string(statement)]), timeout: Timeout.model))
    }

    /// POST /api/impact {episodeId}
    func impact(episodeId: String) async throws(APIError) -> ImpactResponse {
        try await send(APIRequest("/api/impact", body: .json(["episodeId": .string(episodeId)]), timeout: Timeout.model))
    }

    /// POST /api/commitments/decide {commitmentId, decision, contactId?, contactIds?, note?}
    func decide(_ input: DecideInput) async throws(APIError) -> DecideResponse {
        var body: [String: JSONValue] = [
            "commitmentId": .string(input.commitmentId),
            "decision": .string(try Self.wire(input.decision)),
        ]
        if let contactId = input.contactId { body["contactId"] = .string(contactId) }
        if let contactIds = input.contactIds { body["contactIds"] = .array(contactIds.map(JSONValue.string)) }
        if let note = input.note { body["note"] = .string(note) }
        return try await send(APIRequest("/api/commitments/decide", body: .json(.object(body)), timeout: Timeout.model))
    }

    /// POST /api/commitments/reopen {commitmentId}: "Change the plan"; no request changes
    func reopen(commitmentId: String) async throws(APIError) -> ReopenResponse {
        try await send(APIRequest("/api/commitments/reopen", body: .json(["commitmentId": .string(commitmentId)])))
    }

    /// POST /api/commitments/timeline {commitmentId}: puts an appointment on the care timeline
    func addToTimeline(commitmentId: String) async throws(APIError) -> TimelineAddResponse {
        try await send(APIRequest("/api/commitments/timeline", body: .json(["commitmentId": .string(commitmentId)])))
    }

    /// GET /api/guide?tenure=&address=; a blank address is left out
    func guide(address: String, tenure: Tenure) async throws(APIError) -> GuideResponse {
        var query = [URLQueryItem(name: "tenure", value: try Self.wire(tenure))]
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { query.append(URLQueryItem(name: "address", value: trimmed)) }
        return try await send(APIRequest("/api/guide", query: query, timeout: Timeout.model))
    }

    // MARK: - requests

    /// GET /api/requests
    func requests() async throws(APIError) -> RequestList {
        try await send(APIRequest("/api/requests"))
    }

    /// GET /api/requests/[id]
    func request(id: String) async throws(APIError) -> RequestEnvelope {
        try await send(APIRequest("/api/requests/\(Self.segment(id))"))
    }

    /// POST /api/requests/refresh {}: the owner-scoped expiry sweep
    func refreshRequests() async throws(APIError) -> RequestRefresh {
        try await send(APIRequest("/api/requests/refresh", body: .json([:])))
    }

    /// POST /api/requests/edit {requestId, subject?, body?, contactId?, respondBy?, disclosureTier?}
    func editRequest(id: String, changes: RequestChanges) async throws(APIError) -> RequestEnvelope {
        var body: [String: JSONValue] = ["requestId": .string(id)]
        if let subject = changes.subject { body["subject"] = .string(subject) }
        if let text = changes.body { body["body"] = .string(text) }
        if let contactId = changes.contactId { body["contactId"] = .string(contactId) }
        switch changes.respondBy {
        case .keep: break
        case .clear: body["respondBy"] = .null
        case .set(let iso): body["respondBy"] = .string(iso)
        }
        if let tier = changes.disclosureTier { body["disclosureTier"] = .string(try Self.wire(tier)) }
        return try await send(APIRequest("/api/requests/edit", body: .json(.object(body))))
    }

    /// POST /api/requests/redraft {requestId, disclosureTier}: a new draft for the tier, back to awaiting approval
    func redraftRequest(id: String, tier: DisclosureTier) async throws(APIError) -> RedraftResult {
        try await send(APIRequest(
            "/api/requests/redraft",
            body: .json(["requestId": .string(id), "disclosureTier": .string(try Self.wire(tier))]),
            timeout: Timeout.model
        ))
    }

    /// POST /api/requests/approve {requestId, healthOverride} with If-Match: "<revision>"
    func approveRequest(id: String, revision: String, healthOverride: Bool = false) async throws(APIError) -> RequestEnvelope {
        guard Self.isRevision(revision) else { throw APIError.invalidResponse() }
        return try await send(APIRequest(
            "/api/requests/approve",
            body: .json(["requestId": .string(id), "healthOverride": .bool(healthOverride)]),
            headers: ["If-Match": "\"\(revision)\""]
        ))
    }

    /// POST /api/requests/cancel {requestId}
    func cancelRequest(id: String) async throws(APIError) -> RequestEnvelope {
        try await send(APIRequest("/api/requests/cancel", body: .json(["requestId": .string(id)])))
    }

    /// POST /api/requests/send {requestId}
    func sendRequest(id: String) async throws(APIError) -> SendResult {
        try await send(APIRequest("/api/requests/send", body: .json(["requestId": .string(id)])))
    }

    // MARK: - outbox and reply links

    /// GET /api/outbox: the demo outbox; empty unless the server runs RR_MAIL=outbox
    func outbox() async throws(APIError) -> Outbox {
        try await send(APIRequest("/api/outbox"))
    }

    /// POST /api/responses/[token]: {} for accept or decline, {proposal:{at, note?}} for another time
    func respond(token: String, proposal: ResponseProposal? = nil) async throws(APIError) -> ResponseResult {
        var body: [String: JSONValue] = [:]
        if let proposal {
            var inner: [String: JSONValue] = ["at": .string(proposal.at)]
            if let note = proposal.note { inner["note"] = .string(note) }
            body["proposal"] = .object(inner)
        }
        return try await send(APIRequest("/api/responses/\(Self.segment(token))", body: .json(.object(body))))
    }

    // MARK: - recover

    /// GET /api/recover
    func recover() async throws(APIError) -> RecoverResponse {
        try await send(APIRequest("/api/recover"))
    }

    /// POST /api/recover {}: runs the expiry sweep first
    func recoverRefresh() async throws(APIError) -> RecoverResponse {
        try await send(APIRequest("/api/recover", body: .json([:])))
    }

    // MARK: - care

    /// GET /api/care/facts
    func careProfile() async throws(APIError) -> CareProfile {
        try await send(APIRequest("/api/care/facts"))
    }

    /// POST /api/care/sources {kind, text}; a voice note is the reviewed transcript
    func addCareText(kind: CareTextKind, text: String) async throws(APIError) -> CareSourceResult {
        try await send(APIRequest(
            "/api/care/sources",
            body: .json(["kind": .string(try Self.wire(kind)), "text": .string(text)]),
            timeout: Timeout.model
        ))
    }

    /// POST /api/care/sources, multipart with one "file" field holding a pdf
    func uploadCarePDF(_ data: Data, filename: String = "care-document.pdf") async throws(APIError) -> CareSourceResult {
        let file = MultipartFile(data: data, filename: filename, contentType: "application/pdf")
        return try await send(APIRequest("/api/care/sources", body: .multipart(file), timeout: Timeout.upload))
    }

    /// GET /api/care/sources/[id]
    func careSource(id: String) async throws(APIError) -> CareSourceDetail {
        try await send(APIRequest("/api/care/sources/\(Self.segment(id))"))
    }

    /// POST /api/care/facts/[id]/approve {}
    func approveFact(id: String) async throws(APIError) -> FactEnvelope {
        try await send(APIRequest("/api/care/facts/\(Self.segment(id))/approve", body: .json([:])))
    }

    /// POST /api/care/facts/[id]/reject {}
    func rejectFact(id: String) async throws(APIError) -> FactEnvelope {
        try await send(APIRequest("/api/care/facts/\(Self.segment(id))/reject", body: .json([:])))
    }

    /// POST /api/care/facts/[id]/edit {text}: a new approved version; the old one is kept as superseded
    func editFact(id: String, text: String) async throws(APIError) -> FactEditResult {
        try await send(APIRequest("/api/care/facts/\(Self.segment(id))/edit", body: .json(["text": .string(text)])))
    }

    /// POST /api/care/conflicts/resolve {keepFactId}
    func resolveConflict(keepFactId: String) async throws(APIError) -> ConflictResolution {
        try await send(APIRequest("/api/care/conflicts/resolve", body: .json(["keepFactId": .string(keepFactId)])))
    }

    /// GET /api/care/timeline?date=YYYY-MM-DD
    func timeline(date: String) async throws(APIError) -> CareTimeline {
        try await send(APIRequest("/api/care/timeline", query: [URLQueryItem(name: "date", value: date)]))
    }

    /// POST /api/care/events/[id]/complete {date, done}: the caregiver marked one occurrence done, or cleared it
    func completeEvent(id: String, date: String, done: Bool) async throws(APIError) -> EventCompletion {
        try await send(APIRequest(
            "/api/care/events/\(Self.segment(id))/complete",
            body: .json(["date": .string(date), "done": .bool(done)])
        ))
    }

    /// POST /api/care/ask {question}
    func ask(question: String) async throws(APIError) -> AskResponse {
        try await send(APIRequest("/api/care/ask", body: .json(["question": .string(question)]), timeout: Timeout.model))
    }

    /// GET /api/care/contacts
    func careContacts() async throws(APIError) -> CareContactList {
        try await send(APIRequest("/api/care/contacts"))
    }

    /// POST /api/care/contacts {name, relationship?, phone, kind}
    func addCareContact(_ input: NewCareContact) async throws(APIError) -> CareContactEnvelope {
        var body: [String: JSONValue] = [
            "name": .string(input.name),
            "phone": .string(input.phone),
            "kind": .string(try Self.wire(input.kind)),
        ]
        if let relationship = input.relationship { body["relationship"] = .string(relationship) }
        return try await send(APIRequest("/api/care/contacts", body: .json(.object(body))))
    }

    /// POST /api/care/contacts/[id]/remove {}
    func removeCareContact(id: String) async throws(APIError) -> RemovedResponse {
        try await send(APIRequest("/api/care/contacts/\(Self.segment(id))/remove", body: .json([:])))
    }

    // MARK: - care access

    /// GET /api/care-access/nearby?types=&radiusKm=&accessible=&perType=&address=
    func nearby(_ query: NearbyQuery) async throws(APIError) -> NearbyResponse {
        var types: [String] = []
        for type in query.types { types.append(try Self.wire(type)) }
        var items = [
            URLQueryItem(name: "types", value: types.joined(separator: ",")),
            URLQueryItem(name: "radiusKm", value: String(query.radiusKm.rawValue)),
            URLQueryItem(name: "accessible", value: query.accessible.rawValue),
        ]
        if let perType = query.perType, perType != 0 { items.append(URLQueryItem(name: "perType", value: String(perType))) }
        if let address = query.address?.trimmingCharacters(in: .whitespacesAndNewlines), !address.isEmpty {
            items.append(URLQueryItem(name: "address", value: address))
        }
        return try await send(APIRequest("/api/care-access/nearby", query: items))
    }

    /// GET /api/care-access/home?threshold=: the care recipient's own community
    func careAccessHome(threshold: Double) async throws(APIError) -> HomeAccess {
        try await send(APIRequest(
            "/api/care-access/home", query: [URLQueryItem(name: "threshold", value: Self.number(threshold))]
        ))
    }

    /// GET /api/care-access/basemap: outlines, groups and method notes
    func careAccessBasemap() async throws(APIError) -> AccessBasemap {
        try await send(APIRequest("/api/care-access/basemap"))
    }

    /// GET /api/care-access?mode=&threshold=&categories=&stepFree=&view=scores
    func careAccessScores(_ query: AccessQuery) async throws(APIError) -> AccessScores {
        try await send(APIRequest(
            "/api/care-access", query: try Self.accessParams(query, extra: URLQueryItem(name: "view", value: "scores"))
        ))
    }

    /// GET /api/care-access?mode=&threshold=&categories=&stepFree=&area=ID: one community's places, nearest first
    func careAccessPlaces(_ query: AccessQuery, areaId: String) async throws(APIError) -> AccessAreaPlaces {
        try await send(APIRequest(
            "/api/care-access", query: try Self.accessParams(query, extra: URLQueryItem(name: "area", value: areaId))
        ))
    }

    // MARK: - texts

    /// GET /api/sms?episodeId=
    func smsList(episodeId: String?) async throws(APIError) -> SmsList {
        let query = episodeId.map { [URLQueryItem(name: "episodeId", value: $0)] } ?? []
        return try await send(APIRequest("/api/sms", query: query))
    }

    /// GET /api/sms/recipients
    func smsRecipients() async throws(APIError) -> SmsRecipients {
        try await send(APIRequest("/api/sms/recipients"))
    }

    /// POST /api/sms/draft {episodeId, recipientName, senderName, note, tier}
    func smsDraft(_ input: SmsDraftInput) async throws(APIError) -> SmsDraft {
        let body: JSONValue = [
            "episodeId": .string(orNull: input.episodeId),
            "recipientName": .string(orNull: input.recipientName),
            "senderName": .string(orNull: input.senderName),
            "note": .string(orNull: input.note),
            "tier": .string(try Self.wire(input.tier)),
        ]
        return try await send(APIRequest("/api/sms/draft", body: .json(body), timeout: Timeout.model))
    }

    /// POST /api/sms {clientKey, episodeId, to, senderName, body, tier, healthOverride, approved:true}: saves and approves; sends nothing
    func smsApprove(_ input: SmsApproveInput) async throws(APIError) -> SmsEnvelope {
        let body: JSONValue = [
            "clientKey": .string(input.clientKey),
            "episodeId": .string(orNull: input.episodeId),
            "to": input.to.json,
            "senderName": .string(orNull: input.senderName),
            "body": .string(input.body),
            "tier": .string(try Self.wire(input.tier)),
            "healthOverride": .bool(input.healthOverride),
            "approved": true,
        ]
        return try await send(APIRequest("/api/sms", body: .json(body)))
    }

    /// POST /api/sms/send {requestId}
    func smsSend(requestId: String) async throws(APIError) -> SmsEnvelope {
        try await send(APIRequest("/api/sms/send", body: .json(["requestId": .string(requestId)]), timeout: Timeout.smsSend))
    }

    // MARK: - speech

    /// POST /api/stt, multipart with one "file" field (audio/m4a or audio/mp4); nothing is saved
    func transcribe(audio: Data, contentType: String = "audio/m4a") async throws(APIError) -> Transcript {
        let ext = contentType == "audio/mp4" ? "mp4" : "m4a"
        let file = MultipartFile(data: audio, filename: "recording.\(ext)", contentType: contentType)
        return try await send(APIRequest("/api/stt", body: .multipart(file), timeout: Timeout.transcribe))
    }

    /// POST /api/tts {text}: audio/mpeg bytes for 1 to 4000 characters
    func speak(text: String) async throws(APIError) -> Data {
        try await perform(APIRequest("/api/tts", body: .json(["text": .string(text)]), timeout: Timeout.model))
    }

    /// POST /api/voice-agent/session {consent:true, fictionalData:true}; 404 unless RR_VOICE_AGENT=on
    func voiceAgentSession() async throws(APIError) -> VoiceAgentSession {
        try await send(APIRequest("/api/voice-agent/session", body: .json(["consent": true, "fictionalData": true])))
    }

    // MARK: - plumbing

    /// runs a call and decodes the json reply; a reply that does not decode is invalid_response 502
    @concurrent
    func send<T: Decodable & Sendable>(_ request: APIRequest, as type: T.Type = T.self) async throws(APIError) -> T {
        let data = try await perform(request)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            #if DEBUG
                print("[api] \(request.path) did not decode as \(T.self): \(error)")
            #endif
            throw APIError.invalidResponse()
        }
    }

    /// runs a call and returns the body of a 2xx reply; anything else becomes an APIError
    @concurrent
    func perform(_ request: APIRequest) async throws(APIError) -> Data {
        let urlRequest = makeURLRequest(request)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: urlRequest)
        } catch {
            // swiftui cancels a view's .task when its tab goes away; that is not a network failure
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw APIError.cancelled
            }
            throw APIError.network
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse() }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.from(
                status: http.statusCode, body: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After")
            )
        }
        return data
    }

    /// the exact URLRequest for a call; tests read it back
    func makeURLRequest(_ request: APIRequest) -> URLRequest {
        var text = baseURL.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        text += request.path
        if !request.query.isEmpty { text += "?" + Self.formEncoded(request.query) }
        var urlRequest = URLRequest(
            url: URL(string: text)!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: request.timeout
        )
        urlRequest.httpMethod = request.method
        switch request.body {
        case .none:
            break
        case .json(let value):
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.setValue(origin, forHTTPHeaderField: "Origin")
            urlRequest.httpBody = Self.encode(value)
        case .multipart(let file):
            urlRequest.setValue(file.headerValue, forHTTPHeaderField: "Content-Type")
            urlRequest.setValue(origin, forHTTPHeaderField: "Origin")
            urlRequest.httpBody = file.encoded
        }
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        return urlRequest
    }

    static func encode(_ value: JSONValue) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // a JSONValue always encodes
        return (try? encoder.encode(value)) ?? Data("{}".utf8)
    }

    /// the raw value of an input enum; the fallback case is refused before any call, as zod would refuse it
    static func wire<E: TolerantEnum>(_ value: E) throws(APIError) -> String {
        guard value.isKnown else { throw APIError(code: "invalid_input", status: 0) }
        return value.rawValue
    }

    static func isRevision(_ value: String) -> Bool {
        value.wholeMatch(of: /[a-f0-9]{64}/) != nil
    }

    /// encodeURIComponent for one path segment
    static func segment(_ value: String) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    /// URLSearchParams serialization: space becomes +, everything but [A-Za-z0-9*-._] is percent-encoded
    static func formEncoded(_ items: [URLQueryItem]) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._ ")
        func encode(_ text: String) -> String {
            (text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text).replacingOccurrences(of: " ", with: "+")
        }
        return items.map { "\(encode($0.name))=\(encode($0.value ?? ""))" }.joined(separator: "&")
    }

    /// String(number) in js: 15 not 15.0
    static func number(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 1e15 { return String(Int(value)) }
        return String(value)
    }

    /// accessParams in access-data.ts
    static func accessParams(_ query: AccessQuery, extra: URLQueryItem) throws(APIError) -> [URLQueryItem] {
        [
            URLQueryItem(name: "mode", value: try wire(query.mode)),
            URLQueryItem(name: "threshold", value: number(query.threshold)),
            URLQueryItem(name: "categories", value: query.categories.joined(separator: ",")),
            URLQueryItem(name: "stepFree", value: query.stepFree ? "true" : "false"),
            extra,
        ]
    }
}
