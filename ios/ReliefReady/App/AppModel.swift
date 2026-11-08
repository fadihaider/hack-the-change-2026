import Foundation
import Observation

/// app-wide state, injected with .environment: the server, its client and the latest session
@Observable
final class AppModel {
    let config: ServerConfig
    /// rebuilt whenever the server address changes
    private(set) var api: APIClient
    private(set) var session: Session?
    /// the last failed session load; cleared by the next success
    private(set) var sessionError: APIError?
    private(set) var isLoadingSession = false

    @ObservationIgnored private let urlSession: URLSession

    init(config: ServerConfig = ServerConfig(), urlSession: URLSession = .shared) {
        self.config = config
        self.urlSession = urlSession
        self.api = APIClient(baseURL: config.baseURL, session: urlSession)
    }

    /// GET /api/session; keeps the previous session on failure so screens do not flash empty
    func refreshSession() async {
        isLoadingSession = true
        defer { isLoadingSession = false }
        do {
            session = try await api.session()
            sessionError = nil
        } catch {
            sessionError = error
        }
    }

    /// points the app at another server and loads its session; false when the address is not usable
    @discardableResult
    func changeServer(to text: String) async -> Bool {
        guard config.update(text) else { return false }
        await reconnect()
        return true
    }

    /// back to the platform default server
    func resetServer() async {
        config.reset()
        await reconnect()
    }

    private func reconnect() async {
        api = APIClient(baseURL: config.baseURL, session: urlSession)
        session = nil
        sessionError = nil
        await refreshSession()
    }

    /// the care recipient's shown name: displayName, then alias, then "them"
    var careRecipientName: String {
        guard let recipient = session?.careRecipient else { return "them" }
        if let name = recipient.displayName, !name.isEmpty { return name }
        return recipient.alias
    }
}
