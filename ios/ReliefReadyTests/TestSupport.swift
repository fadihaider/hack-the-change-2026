import Foundation
import Synchronization
@testable import ReliefReady

/// marks the test bundle so fixtures can be found
final class TestBundleToken {}

enum Fixtures {
    static var bundle: Bundle { Bundle(for: TestBundleToken.self) }

    /// every fixture name, without .json
    static var names: [String] {
        let urls = bundle.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures") ?? []
        return urls.map { $0.deletingPathExtension().lastPathComponent }.sorted()
    }

    static func data(_ name: String) throws -> Data {
        guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: name])
        }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: data(name))
    }
}

/// a URLProtocol that answers from a canned reply and records each request, keyed by host so tests can run in parallel
nonisolated final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        var status: Int = 200
        var headers: [String: String] = ["Content-Type": "application/json"]
        var body = Data("{}".utf8)
    }

    struct Captured: Sendable {
        var request: URLRequest
        var body: Data
    }

    private static let replies = Mutex<[String: Reply]>([:])
    private static let captured = Mutex<[String: [Captured]]>([:])

    static func register(host: String, reply: Reply) {
        replies.withLock { $0[host] = reply }
    }

    static func requests(host: String) -> [Captured] {
        captured.withLock { $0[host] ?? [] }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host() ?? ""
        let body = request.httpBody ?? Self.read(request.httpBodyStream)
        Self.captured.withLock { $0[host, default: []].append(Captured(request: request, body: body)) }
        let reply = Self.replies.withLock { $0[host] } ?? Reply()
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream?) -> Data {
        guard let stream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    /// a client on a fresh host that answers with the reply
    static func client(reply: Reply = Reply()) -> (client: APIClient, host: String) {
        let host = "t\(UUID().uuidString.prefix(8).lowercased()).test"
        register(host: host, reply: reply)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: configuration)
        return (APIClient(baseURL: URL(string: "http://\(host):3107")!, session: session), host)
    }
}
