import Foundation
import Observation

/// which ReliefReady server the app talks to. kept in UserDefaults; a -ServerURL launch argument wins for ui tests
@Observable
final class ServerConfig {
    nonisolated static let defaultsKey = "ServerURL"
    nonisolated static let launchArgument = "-ServerURL"
    static let simulatorDefault = URL(string: "http://127.0.0.1:3200")!
    static let deviceDefault = URL(string: "http://192.168.1.157:3200")!

    /// the platform default: the mac's loopback on the simulator, the mac's lan address on a phone
    static var platformDefault: URL {
        #if targetEnvironment(simulator)
            simulatorDefault
        #else
            deviceDefault
        #endif
    }

    /// scheme://host:port with no path
    private(set) var baseURL: URL
    /// true while a -ServerURL launch argument overrides the saved value
    private(set) var isOverridden: Bool

    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard, arguments: [String] = ProcessInfo.processInfo.arguments) {
        self.defaults = defaults
        if let argument = Self.launchValue(in: arguments).flatMap(Self.normalized) {
            baseURL = argument
            isOverridden = true
        } else {
            baseURL = defaults.string(forKey: Self.defaultsKey).flatMap(Self.normalized) ?? Self.platformDefault
            isOverridden = false
        }
    }

    /// the exact Origin header every post sends
    var origin: String { Self.origin(of: baseURL) }

    /// saves a new server address; returns false when the text is not an http(s) address
    @discardableResult
    func update(_ text: String) -> Bool {
        guard let url = Self.normalized(text) else { return false }
        baseURL = url
        isOverridden = false
        defaults.set(url.absoluteString, forKey: Self.defaultsKey)
        return true
    }

    /// back to the platform default
    func reset() {
        defaults.removeObject(forKey: Self.defaultsKey)
        baseURL = Self.platformDefault
        isOverridden = false
    }

    nonisolated static func launchValue(in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: launchArgument), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }

    /// keeps only scheme, host and port; nil for anything but an http(s) address with a host
    nonisolated static func normalized(_ text: String) -> URL? {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.contains("://") { trimmed = "http://" + trimmed }
        guard var parts = URLComponents(string: trimmed),
            let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let host = parts.host, !host.isEmpty
        else { return nil }
        parts.scheme = scheme
        parts.host = host.lowercased()
        // the server compares against WHATWG URL.origin, which drops a default port
        if parts.port == Self.defaultPort(of: scheme) { parts.port = nil }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        parts.user = nil
        parts.password = nil
        return parts.url
    }

    nonisolated static func origin(of url: URL) -> String {
        let scheme = url.scheme ?? "http"
        let host = url.host(percentEncoded: false) ?? ""
        let shownHost = host.contains(":") ? "[\(host)]" : host
        if let port = url.port, port != defaultPort(of: scheme) { return "\(scheme)://\(shownHost):\(port)" }
        return "\(scheme)://\(shownHost)"
    }

    nonisolated static func defaultPort(of scheme: String) -> Int? {
        switch scheme.lowercased() {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
}
