import Foundation
import Synchronization
@testable import ReliefReady

/// a URLProtocol that answers by path, so one client can serve the several calls a care flow makes
nonisolated final class CareRouteStub: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        var status = 200
        var body: String
    }

    private static let routes = Mutex<[String: [String: Reply]]>([:])
    private static let hits = Mutex<[String: [String]]>([:])

    static func client(_ routes: [String: Reply]) -> (client: APIClient, host: String) {
        let host = "care\(UUID().uuidString.prefix(8).lowercased()).test"
        self.routes.withLock { $0[host] = routes }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CareRouteStub.self]
        return (APIClient(baseURL: URL(string: "http://\(host):3203")!, session: URLSession(configuration: configuration)), host)
    }

    static func set(host: String, path: String, reply: Reply) {
        routes.withLock { $0[host, default: [:]][path] = reply }
    }

    /// "POST /api/care/facts/f1/approve", in order
    static func calls(host: String) -> [String] {
        hits.withLock { $0[host] ?? [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host() ?? ""
        let path = request.url?.path() ?? ""
        Self.hits.withLock { $0[host, default: []].append("\(request.httpMethod ?? "GET") \(path)") }
        let reply = Self.routes.withLock { $0[host]?[path] } ?? Reply(status: 404, body: #"{"error":{"code":"not_found"}}"#)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// small builders for care facts and timeline items
enum CareFixtures {
    static let note =
        "Her spare glasses are in the top drawer of the hallway dresser. She has breakfast at 8:00 every morning. Speak slowly and face her, she reads lips a bit. She likes the radio on in the afternoon."

    static func event(_ startsAt: String?, rrule: String? = nil, remind: Double? = nil) -> CareEvent {
        CareEvent(id: "e-\(UUID().uuidString.prefix(4))", title: "t", startsAt: startsAt, rrule: rrule, remindMinutes: remind, locationText: nil, status: "suggested")
    }

    static func fact(
        _ id: String, _ text: String, category: String = "practical", status: FactStatus = .suggested,
        source: String? = "s1", createdAt: String = "2026-11-08T08:54:41.551Z", span: (Double, Double)? = nil,
        conflicts: [String] = [], events: [CareEvent] = [], version: Int = 1, supersedes: String? = nil
    ) -> CareFact {
        CareFact(
            id: id, category: category, textExact: text, status: status, sourceId: source, sourceKind: "note",
            spanStart: span?.0, spanEnd: span?.1, conflictsWith: conflicts, events: events, createdAt: createdAt,
            version: version, supersedes: supersedes, sourceAuthor: "caregiver", sourceCreatedAt: createdAt
        )
    }

    static func item(
        _ id: String, _ startsAt: String, title: String = "Item", factId: String? = "f", remind: Double = 0,
        highlight: Bool = false, completedAt: String? = nil, category: String? = "routine", fullText: String? = nil
    ) -> TimelineItem {
        TimelineItem(
            eventId: id, factId: factId, title: title, startsAt: startsAt, localTime: "", rrule: nil, remindMinutes: remind,
            locationText: nil, fullText: fullText, category: category, highlight: highlight, completedAt: completedAt
        )
    }

    /// the four facts the demo rules pull from the demo note
    static var demoFacts: [CareFact] {
        [
            fact("glasses", "Her spare glasses are in the top drawer of the hallway dresser.", span: (0, 63)),
            fact(
                "breakfast", "She has breakfast at 8:00 every morning.", category: "routine", span: (64, 104),
                events: [event("2026-11-08T14:00:00.000Z", rrule: "FREQ=DAILY", remind: 15)]
            ),
            fact("lips", "Speak slowly and face her, she reads lips a bit.", category: "communication", span: (105, 153)),
            fact("radio", "She likes the radio on in the afternoon.", category: "preference", span: (154, 194)),
        ]
    }

    static func json<T: Encodable>(_ value: T) -> String {
        String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
    }

    static func profileJSON(_ facts: [CareFact]) -> String {
        json(CareProfile(careRecipient: CareProfileRecipient(id: "r", alias: "Mom", displayName: "Rosa"), facts: facts, openQuestions: []))
    }
}
