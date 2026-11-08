import Foundation
import Testing
@testable import ReliefReady

/// one endpoint call and the exact request it must produce
struct RequestCase: Sendable, CustomTestStringConvertible {
    var name: String
    /// the reply the stub answers with, so the call also decodes
    var fixture: String?
    var method: String
    var path: String
    var query: [String: String] = [:]
    /// the exact json body; nil for a GET or multipart
    var body: JSONValue?
    var timeout: TimeInterval = APIClient.Timeout.standard
    var call: @Sendable (APIClient) async throws -> Void

    var testDescription: String { name }
}

struct APIClientRequestTests {
    static let revision = String(repeating: "a1", count: 32)

    static let cases: [RequestCase] = [
        RequestCase(name: "session", fixture: "session", method: "GET", path: "/api/session", timeout: 6) { _ = try await $0.session() },
        RequestCase(name: "clock", fixture: "clock", method: "GET", path: "/api/clock") { _ = try await $0.clock() },
        RequestCase(name: "jump", method: "POST", path: "/api/clock/jump", body: ["days": 2]) { _ = try await $0.jumpClock(days: 2) },
        RequestCase(name: "reset", fixture: "clock", method: "POST", path: "/api/clock/reset", body: [:]) { _ = try await $0.resetClock() },
        RequestCase(name: "intake", fixture: "intake-ready", method: "POST", path: "/api/intake", body: ["statement": "Mom has surgery"], timeout: 90) {
            _ = try await $0.intake(statement: "Mom has surgery")
        },
        RequestCase(name: "impact", fixture: "impact", method: "POST", path: "/api/impact", body: ["episodeId": "e1"], timeout: 90) {
            _ = try await $0.impact(episodeId: "e1")
        },
        RequestCase(name: "decide single", fixture: "decide", method: "POST", path: "/api/commitments/decide",
                    body: ["commitmentId": "c1", "decision": "reschedule", "contactId": "k1"], timeout: 90) {
            _ = try await $0.decide(DecideInput(commitmentId: "c1", decision: .reschedule, contactId: "k1"))
        },
        RequestCase(name: "decide group", fixture: "decide", method: "POST", path: "/api/commitments/decide",
                    body: ["commitmentId": "c1", "decision": "extension", "contactIds": ["k1", "k2"], "note": "Thanks"], timeout: 90) {
            _ = try await $0.decide(DecideInput(commitmentId: "c1", decision: .extension, contactIds: ["k1", "k2"], note: "Thanks"))
        },
        RequestCase(name: "reopen", method: "POST", path: "/api/commitments/reopen", body: ["commitmentId": "c1"]) {
            _ = try await $0.reopen(commitmentId: "c1")
        },
        RequestCase(name: "timeline add", fixture: "add-to-timeline", method: "POST", path: "/api/commitments/timeline", body: ["commitmentId": "c1"]) {
            _ = try await $0.addToTimeline(commitmentId: "c1")
        },
        RequestCase(name: "guide with address", fixture: "guide", method: "GET", path: "/api/guide",
                    query: ["tenure": "not_sure", "address": "800 3 St SE"], timeout: 90) {
            _ = try await $0.guide(address: "  800 3 St SE ", tenure: .notSure)
        },
        RequestCase(name: "guide blank address", fixture: "guide", method: "GET", path: "/api/guide", query: ["tenure": "yes"], timeout: 90) {
            _ = try await $0.guide(address: "  ", tenure: .yes)
        },
        RequestCase(name: "requests", fixture: "requests", method: "GET", path: "/api/requests") { _ = try await $0.requests() },
        RequestCase(name: "request one", fixture: "request-one", method: "GET", path: "/api/requests/r%2F1") { _ = try await $0.request(id: "r/1") },
        RequestCase(name: "refresh", fixture: "requests-refresh", method: "POST", path: "/api/requests/refresh", body: [:]) {
            _ = try await $0.refreshRequests()
        },
        RequestCase(name: "edit", fixture: "request-edit", method: "POST", path: "/api/requests/edit",
                    body: ["requestId": "r1", "body": "Hi", "respondBy": nil, "disclosureTier": "minimal"]) {
            _ = try await $0.editRequest(id: "r1", changes: RequestChanges(body: "Hi", respondBy: .clear, disclosureTier: .minimal))
        },
        RequestCase(name: "edit new reply-by", fixture: "request-edit", method: "POST", path: "/api/requests/edit",
                    body: ["requestId": "r1", "respondBy": "2026-11-10T09:00:00-06:00"]) {
            // 15:00 utc is 09:00 in alberta
            let date = Date(timeIntervalSince1970: 1_794_322_800)
            _ = try await $0.editRequest(id: "r1", changes: RequestChanges(respondBy: .to(date)))
        },
        RequestCase(name: "edit subject only", fixture: "request-edit", method: "POST", path: "/api/requests/edit",
                    body: ["requestId": "r1", "subject": "New"]) {
            _ = try await $0.editRequest(id: "r1", changes: RequestChanges(subject: "New"))
        },
        RequestCase(name: "redraft", method: "POST", path: "/api/requests/redraft",
                    body: ["requestId": "r1", "disclosureTier": "general"], timeout: 90) {
            _ = try await $0.redraftRequest(id: "r1", tier: .general)
        },
        RequestCase(name: "approve", fixture: "request-approve", method: "POST", path: "/api/requests/approve",
                    body: ["requestId": "r1", "healthOverride": false]) {
            _ = try await $0.approveRequest(id: "r1", revision: revision)
        },
        RequestCase(name: "cancel", fixture: "request-one", method: "POST", path: "/api/requests/cancel", body: ["requestId": "r1"]) {
            _ = try await $0.cancelRequest(id: "r1")
        },
        RequestCase(name: "send", fixture: "request-send", method: "POST", path: "/api/requests/send", body: ["requestId": "r1"]) {
            _ = try await $0.sendRequest(id: "r1")
        },
        RequestCase(name: "outbox", fixture: "outbox", method: "GET", path: "/api/outbox") { _ = try await $0.outbox() },
        RequestCase(name: "respond accept", fixture: "response-accept", method: "POST", path: "/api/responses/tok_-1", body: [:]) {
            _ = try await $0.respond(token: "tok_-1")
        },
        RequestCase(name: "respond propose", fixture: "response-accept", method: "POST", path: "/api/responses/tok",
                    body: ["proposal": ["at": "2026-11-10T09:00:00-06:00", "note": "After lunch"]]) {
            _ = try await $0.respond(token: "tok", proposal: ResponseProposal(at: "2026-11-10T09:00:00-06:00", note: "After lunch"))
        },
        RequestCase(name: "recover", fixture: "recover", method: "GET", path: "/api/recover") { _ = try await $0.recover() },
        RequestCase(name: "recover refresh", fixture: "recover-refresh", method: "POST", path: "/api/recover", body: [:]) {
            _ = try await $0.recoverRefresh()
        },
        RequestCase(name: "care profile", fixture: "care-facts", method: "GET", path: "/api/care/facts") { _ = try await $0.careProfile() },
        RequestCase(name: "care text", fixture: "care-add-note", method: "POST", path: "/api/care/sources",
                    body: ["kind": "voice", "text": "She naps at 2"], timeout: 90) {
            _ = try await $0.addCareText(kind: .voice, text: "She naps at 2")
        },
        RequestCase(name: "care source", fixture: "care-source", method: "GET", path: "/api/care/sources/s1") { _ = try await $0.careSource(id: "s1") },
        RequestCase(name: "approve fact", fixture: "fact-approve", method: "POST", path: "/api/care/facts/f1/approve", body: [:]) {
            _ = try await $0.approveFact(id: "f1")
        },
        RequestCase(name: "reject fact", fixture: "fact-approve", method: "POST", path: "/api/care/facts/f1/reject", body: [:]) {
            _ = try await $0.rejectFact(id: "f1")
        },
        RequestCase(name: "edit fact", method: "POST", path: "/api/care/facts/f1/edit", body: ["text": "Glasses in the drawer"]) {
            _ = try await $0.editFact(id: "f1", text: "Glasses in the drawer")
        },
        RequestCase(name: "resolve conflict", method: "POST", path: "/api/care/conflicts/resolve", body: ["keepFactId": "f2"]) {
            _ = try await $0.resolveConflict(keepFactId: "f2")
        },
        RequestCase(name: "timeline", fixture: "care-timeline", method: "GET", path: "/api/care/timeline", query: ["date": "2026-11-08"]) {
            _ = try await $0.timeline(date: "2026-11-08")
        },
        RequestCase(name: "complete event", method: "POST", path: "/api/care/events/e1/complete", body: ["date": "2026-11-08", "done": true]) {
            _ = try await $0.completeEvent(id: "e1", date: "2026-11-08", done: true)
        },
        RequestCase(name: "ask", fixture: "ask-found", method: "POST", path: "/api/care/ask", body: ["question": "Where are her glasses?"], timeout: 90) {
            _ = try await $0.ask(question: "Where are her glasses?")
        },
        RequestCase(name: "contacts", fixture: "care-contacts", method: "GET", path: "/api/care/contacts") { _ = try await $0.careContacts() },
        RequestCase(name: "add contact", fixture: "contact-add", method: "POST", path: "/api/care/contacts",
                    body: ["name": "Aunt Lucia", "relationship": "Sister", "phone": "403-555-0142", "kind": "trusted"]) {
            _ = try await $0.addCareContact(NewCareContact(name: "Aunt Lucia", relationship: "Sister", phone: "403-555-0142", kind: .trusted))
        },
        RequestCase(name: "add contact no relationship", fixture: "contact-add", method: "POST", path: "/api/care/contacts",
                    body: ["name": "Lucia", "phone": "403-555-0142", "kind": "emergency"]) {
            _ = try await $0.addCareContact(NewCareContact(name: "Lucia", phone: "403-555-0142", kind: .emergency))
        },
        RequestCase(name: "remove contact", method: "POST", path: "/api/care/contacts/k1/remove", body: [:]) {
            _ = try await $0.removeCareContact(id: "k1")
        },
        RequestCase(name: "nearby", fixture: "nearby", method: "GET", path: "/api/care-access/nearby",
                    query: ["types": "pharmacy,public_health", "radiusKm": "3", "accessible": "yes", "perType": "4", "address": "1+2 St"]) {
            _ = try await $0.nearby(NearbyQuery(types: [.pharmacy, .publicHealth], radiusKm: .three, accessible: .yes, perType: 4, address: "1+2 St"))
        },
        RequestCase(name: "access home", fixture: "care-access-home", method: "GET", path: "/api/care-access/home", query: ["threshold": "15"]) {
            _ = try await $0.careAccessHome(threshold: 15)
        },
        RequestCase(name: "access basemap", fixture: "care-access-basemap", method: "GET", path: "/api/care-access/basemap") {
            _ = try await $0.careAccessBasemap()
        },
        RequestCase(name: "access scores", fixture: "care-access-scores", method: "GET", path: "/api/care-access",
                    query: ["mode": "driving", "threshold": "15", "categories": "Pharmacy,Health Centre", "stepFree": "false", "view": "scores"]) {
            _ = try await $0.careAccessScores(AccessQuery())
        },
        RequestCase(name: "access places", fixture: "care-access-area", method: "GET", path: "/api/care-access",
                    query: ["mode": "proximity", "threshold": "2.5", "categories": "Library", "stepFree": "true", "area": "DNE"]) {
            _ = try await $0.careAccessPlaces(AccessQuery(mode: .proximity, threshold: 2.5, categories: ["Library"], stepFree: true), areaId: "DNE")
        },
        RequestCase(name: "sms list", fixture: "sms-list", method: "GET", path: "/api/sms", query: ["episodeId": "e1"]) {
            _ = try await $0.smsList(episodeId: "e1")
        },
        RequestCase(name: "sms list all", fixture: "sms-list", method: "GET", path: "/api/sms") { _ = try await $0.smsList(episodeId: nil) },
        RequestCase(name: "sms recipients", fixture: "sms-recipients", method: "GET", path: "/api/sms/recipients") { _ = try await $0.smsRecipients() },
        RequestCase(name: "sms draft", fixture: "sms-draft", method: "POST", path: "/api/sms/draft",
                    body: ["episodeId": "e1", "recipientName": "Lucia", "senderName": nil, "note": nil, "tier": "minimal"], timeout: 90) {
            _ = try await $0.smsDraft(SmsDraftInput(episodeId: "e1", recipientName: "Lucia", senderName: nil, note: nil, tier: .minimal))
        },
        RequestCase(name: "sms approve", method: "POST", path: "/api/sms",
                    body: ["clientKey": "abcdefabcdef12345678", "episodeId": nil, "to": ["kind": "care_contact", "id": "k1"],
                           "senderName": "Alex", "body": "Hi", "tier": "general", "healthOverride": false, "approved": true]) {
            _ = try await $0.smsApprove(SmsApproveInput(clientKey: "abcdefabcdef12345678", episodeId: nil, to: .careContact(id: "k1"),
                                                        senderName: "Alex", body: "Hi", tier: .general, healthOverride: false))
        },
        RequestCase(name: "sms approve phone", method: "POST", path: "/api/sms",
                    body: ["clientKey": "abcdefabcdef12345678", "episodeId": "e1", "to": ["kind": "phone", "phone": "4035550142"],
                           "senderName": nil, "body": "Hi", "tier": "minimal", "healthOverride": true, "approved": true]) {
            _ = try await $0.smsApprove(SmsApproveInput(clientKey: "abcdefabcdef12345678", episodeId: "e1", to: .phone("4035550142"),
                                                        senderName: nil, body: "Hi", tier: .minimal, healthOverride: true))
        },
        RequestCase(name: "sms send", method: "POST", path: "/api/sms/send", body: ["requestId": "t1"], timeout: 30) {
            _ = try await $0.smsSend(requestId: "t1")
        },
        RequestCase(name: "tts", method: "POST", path: "/api/tts", body: ["text": "Hello"], timeout: 90) { _ = try await $0.speak(text: "Hello") },
        RequestCase(name: "voice agent", method: "POST", path: "/api/voice-agent/session", body: ["consent": true, "fictionalData": true]) {
            _ = try await $0.voiceAgentSession()
        },
    ]

    @Test(arguments: cases)
    func buildsTheExactRequest(_ testCase: RequestCase) async throws {
        var reply = StubProtocol.Reply()
        if let fixture = testCase.fixture { reply.body = try Fixtures.data(fixture) }
        let (client, host) = StubProtocol.client(reply: reply)

        var thrown: APIError?
        do {
            try await testCase.call(client)
        } catch {
            thrown = error as? APIError ?? APIError(code: "unexpected", status: -1)
        }
        // with a real fixture the reply must also decode
        if testCase.fixture != nil { #expect(thrown == nil, "\(testCase.name) failed: \(String(describing: thrown))") }

        let sent = try #require(StubProtocol.requests(host: host).first)
        let request = sent.request
        let url = try #require(request.url)
        #expect(request.httpMethod == testCase.method)
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == testCase.path)
        #expect(Self.formQuery(url) == testCase.query)
        #expect(request.timeoutInterval == testCase.timeout)
        #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)

        if testCase.method == "POST" {
            #expect(request.value(forHTTPHeaderField: "Origin") == "http://\(host):3107")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            let body = try JSONDecoder().decode(JSONValue.self, from: sent.body)
            #expect(body == testCase.body)
        } else {
            #expect(request.value(forHTTPHeaderField: "Origin") == nil)
            #expect(request.value(forHTTPHeaderField: "Content-Type") == nil)
            #expect(sent.body.isEmpty)
        }
        if testCase.name == "approve" {
            #expect(request.value(forHTTPHeaderField: "If-Match") == "\"\(Self.revision)\"")
        } else {
            #expect(request.value(forHTTPHeaderField: "If-Match") == nil)
        }
    }

    /// decodes a query the way URLSearchParams does: + is a space
    static func formQuery(_ url: URL) -> [String: String] {
        guard let query = url.query(percentEncoded: true), !query.isEmpty else { return [:] }
        var out: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map {
                String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? ""
            }
            out[parts[0]] = parts.count > 1 ? parts[1] : ""
        }
        return out
    }

    @Test func queryEncodingMatchesURLSearchParams() {
        let encoded = APIClient.formEncoded([
            URLQueryItem(name: "categories", value: "Pharmacy,Health Centre"),
            URLQueryItem(name: "address", value: "1+2 St/É"),
        ])
        #expect(encoded == "categories=Pharmacy%2CHealth+Centre&address=1%2B2+St%2F%C3%89")
    }

    @Test func approveRejectsABadRevisionWithoutCalling() async {
        let (client, host) = StubProtocol.client()
        await #expect(throws: APIError.invalidResponse()) {
            _ = try await client.approveRequest(id: "r1", revision: "not-a-revision")
        }
        #expect(StubProtocol.requests(host: host).isEmpty)
    }

    @Test func inputEnumsNeverOfferTheFallback() {
        #expect(!Decision.allCases.contains(.unrecognized))
        #expect(!Tenure.allCases.contains(.unrecognized))
        #expect(!DisclosureTier.allCases.contains(.unrecognized))
        #expect(!CareTextKind.allCases.contains(.unrecognized))
        #expect(!CareContactKind.allCases.contains(.unrecognized))
        #expect(!TravelMode.allCases.contains(.unrecognized))
        #expect(!NearbyType.allCases.contains(.unrecognized))
        // every listed case still round-trips through its raw value
        #expect(Decision.allCases.map(\.rawValue) == ["notify", "reschedule", "extension", "coverage", "defer", "keep"])
        #expect(Tenure.allCases.map(\.rawValue) == ["yes", "no", "not_sure"])
        #expect(NearbyType.allCases.count == 8)
    }

    static let fallbackCalls: [@Sendable (APIClient) async throws -> Void] = [
        { _ = try await $0.decide(DecideInput(commitmentId: "c1", decision: .unrecognized)) },
        { _ = try await $0.guide(address: "", tenure: .unrecognized) },
        { _ = try await $0.editRequest(id: "r1", changes: RequestChanges(disclosureTier: .unrecognized)) },
        { _ = try await $0.redraftRequest(id: "r1", tier: .unrecognized) },
        { _ = try await $0.addCareText(kind: .unrecognized, text: "x") },
        { _ = try await $0.addCareContact(NewCareContact(name: "x", phone: "403", kind: .unrecognized)) },
        { _ = try await $0.nearby(NearbyQuery(types: [.pharmacy, .unrecognized], radiusKm: .three)) },
        { _ = try await $0.careAccessScores(AccessQuery(mode: .unrecognized)) },
        { _ = try await $0.careAccessPlaces(AccessQuery(mode: .unrecognized), areaId: "DNE") },
        { _ = try await $0.smsDraft(SmsDraftInput(episodeId: nil, recipientName: nil, senderName: nil, note: nil, tier: .unrecognized)) },
        { _ = try await $0.smsApprove(SmsApproveInput(clientKey: "abcdefabcdef12345678", episodeId: nil, to: .phone("4035550142"),
                                                      senderName: nil, body: "Hi", tier: .unrecognized, healthOverride: false)) },
    ]

    @Test(arguments: 0..<fallbackCalls.count)
    func fallbackInputIsRefusedWithoutCalling(_ index: Int) async {
        let (client, host) = StubProtocol.client()
        await #expect(throws: APIError(code: "invalid_input", status: 0)) { try await Self.fallbackCalls[index](client) }
        #expect(StubProtocol.requests(host: host).isEmpty)
    }

    @Test func pdfFilenameIsEscapedInThePartHeader() async throws {
        let (client, host) = StubProtocol.client(reply: StubProtocol.Reply(body: try Fixtures.data("care-add-note")))
        let pdf = Data("%PDF-1.4 test".utf8)
        _ = try await client.uploadCarePDF(pdf, filename: "Rosa \"discharge\"\r\nX-Evil: 1.pdf")
        let sent = try #require(StubProtocol.requests(host: host).first)
        try Self.expectMultipart(sent, host: host, path: "/api/care/sources", filename: "Rosa %22discharge%22%0D%0AX-Evil: 1.pdf",
                                 contentType: "application/pdf", payload: pdf, timeout: 120)
        #expect(MultipartFile.escaped("Café notes.pdf") == "Café notes.pdf")
    }

    @Test func pdfUploadIsMultipartWithOneFileField() async throws {
        let (client, host) = StubProtocol.client(reply: StubProtocol.Reply(body: try Fixtures.data("care-add-note")))
        let pdf = Data("%PDF-1.4 test".utf8)
        _ = try await client.uploadCarePDF(pdf)
        let sent = try #require(StubProtocol.requests(host: host).first)
        try Self.expectMultipart(sent, host: host, path: "/api/care/sources", filename: "care-document.pdf",
                                 contentType: "application/pdf", payload: pdf, timeout: 120)
    }

    @Test func transcribeIsMultipartWithOneFileField() async throws {
        let (client, host) = StubProtocol.client(reply: StubProtocol.Reply(body: Data(#"{"transcript":"hello"}"#.utf8)))
        let audio = Data([0, 1, 2, 3, 255])
        let result = try await client.transcribe(audio: audio)
        #expect(result.transcript == "hello")
        let sent = try #require(StubProtocol.requests(host: host).first)
        try Self.expectMultipart(sent, host: host, path: "/api/stt", filename: "recording.m4a",
                                 contentType: "audio/m4a", payload: audio, timeout: 130)
    }

    static func expectMultipart(
        _ sent: StubProtocol.Captured, host: String, path: String, filename: String, contentType: String, payload: Data,
        timeout: TimeInterval
    ) throws {
        let request = sent.request
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path() == path)
        #expect(request.timeoutInterval == timeout)
        #expect(request.value(forHTTPHeaderField: "Origin") == "http://\(host):3107")
        let header = try #require(request.value(forHTTPHeaderField: "Content-Type"))
        #expect(header.hasPrefix("multipart/form-data; boundary="))
        let boundary = String(header.dropFirst("multipart/form-data; boundary=".count))
        var expected = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(contentType)\r\n\r\n".utf8)
        expected.append(payload)
        expected.append(Data("\r\n--\(boundary)--\r\n".utf8))
        #expect(sent.body == expected)
        // exactly one part
        #expect(String(decoding: sent.body, as: UTF8.self).components(separatedBy: "Content-Disposition").count == 2)
    }

    @Test func errorsCarryCodeTermsAndRetryAfter() async {
        let body = Data(#"{"error":{"code":"health_terms","terms":["surgery"],"message":"x"}}"#.utf8)
        let (client, _) = StubProtocol.client(reply: StubProtocol.Reply(status: 422, body: body))
        do {
            _ = try await client.approveRequest(id: "r1", revision: Self.revision)
            Issue.record("expected an error")
        } catch {
            #expect(error.code == "health_terms")
            #expect(error.status == 422)
            #expect(error.terms == ["surgery"])
            #expect(error.detail == "x")
        }

        let limited = StubProtocol.Reply(
            status: 429, headers: ["Content-Type": "application/json", "Retry-After": "120"],
            body: Data(#"{"error":{"code":"rate_limited"}}"#.utf8)
        )
        let (slow, _) = StubProtocol.client(reply: limited)
        do {
            _ = try await slow.ask(question: "q")
            Issue.record("expected an error")
        } catch {
            #expect(error.code == "rate_limited")
            #expect(error.retryAfter == 120)
            #expect(error.userMessage == APIError.errorText["rate_limited"])
        }
    }

    @Test func nonJSONSuccessIsInvalidResponse() async {
        let (client, _) = StubProtocol.client(reply: StubProtocol.Reply(body: Data("<html>".utf8)))
        await #expect(throws: APIError(code: "invalid_response", status: 502)) { _ = try await client.clock() }
    }

    @Test func htmlErrorPageIsInvalidResponseWithItsStatus() async {
        let (client, _) = StubProtocol.client(reply: StubProtocol.Reply(status: 404, headers: [:], body: Data("<html>".utf8)))
        await #expect(throws: APIError(code: "invalid_response", status: 404)) { _ = try await client.transcribe(audio: Data([1])) }
    }

    @Test func aCancelledCallIsNotANetworkFailure() async {
        let (client, _) = StubProtocol.client(reply: StubProtocol.Reply(body: Data("{}".utf8)))
        // a tab going away cancels its .task; the call must say so rather than report network_error
        let task = Task { () async -> APIError? in
            do throws(APIError) {
                _ = try await client.clock()
                return nil
            } catch {
                return error
            }
        }
        task.cancel()
        let error = await task.value
        #expect(error?.isCancelled == true)
        #expect(error != APIError.network)
    }

    @Test func ttsReturnsTheBytes() async throws {
        let audio = Data([0x49, 0x44, 0x33])
        let (client, _) = StubProtocol.client(reply: StubProtocol.Reply(headers: ["Content-Type": "audio/mpeg"], body: audio))
        #expect(try await client.speak(text: "Hello") == audio)
    }
}
