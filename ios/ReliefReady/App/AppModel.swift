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
    /// the tab on screen; features switch tabs through showUrgent rather than setting it directly
    var selectedTab: AppTab
    /// a pending "open Urgent here" from another feature; UrgentView consumes and clears it
    var urgentLink: UrgentLink?

    @ObservationIgnored private let urlSession: URLSession
    /// the newest session load; an older one that answers late (another server, or a slow retry) is dropped
    @ObservationIgnored private var sessionSequence = 0

    init(config: ServerConfig = ServerConfig(), urlSession: URLSession = .shared) {
        self.config = config
        self.urlSession = urlSession
        self.selectedTab = AppTab.launchTab()
        self.api = APIClient(baseURL: config.baseURL, session: urlSession)
    }

    /// GET /api/session; keeps the previous session on failure so screens do not flash empty
    func refreshSession() async {
        sessionSequence += 1
        let mine = sessionSequence
        let client = api
        do {
            let next = try await client.session()
            guard mine == sessionSequence, client === api else { return }
            session = next
            sessionError = nil
        } catch {
            guard mine == sessionSequence, client === api, !error.isCancelled else { return }
            sessionError = error
        }
    }

    /// the first load. on a phone the first call brings up the Local Network prompt and can time out while it is
    /// open, so a network failure is tried again every few seconds for a while before only Try again is left
    func connect(retryFor: Duration = .seconds(30), every: Duration = .seconds(3)) async {
        let clock = ContinuousClock()
        let started = clock.now
        await refreshSession()
        while session == nil, sessionError?.code == APIError.network.code, clock.now - started < retryFor {
            try? await Task.sleep(for: every)
            guard !Task.isCancelled, session == nil else { return }
            await refreshSession()
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

    /// the care recipient's shown name (recipientName in session.tsx)
    var careRecipientName: String { Self.recipientName(session) }

    /// displayName, then alias, then "your family member"; a blank name counts as missing
    nonisolated static func recipientName(_ session: Session?) -> String {
        let recipient = session?.careRecipient
        if let name = recipient?.displayName, !name.isEmpty { return name }
        if let alias = recipient?.alias, !alias.isEmpty { return alias }
        return "your family member"
    }

    // MARK: - moving between tabs

    /// switches to Urgent (the web's links to /urgent). requestId opens that message, as /urgent?request=<id> does;
    /// fromStart moves the voiceover focus to the first heading, as /urgent?from=intake does
    func showUrgent(requestId: String? = nil, fromStart: Bool = false) {
        selectedTab = .urgent
        if requestId != nil || fromStart {
            urgentLink = UrgentLink(requestId: requestId, fromStart: fromStart)
        }
    }
}

/// the four tabs of MainTabs
enum AppTab: String, Hashable, CaseIterable {
    case urgent, care, recover, more

    /// debug builds honour -StartTab urgent|care|recover|more, for screenshots and ui tests
    static func launchTab(_ defaults: UserDefaults = .standard) -> AppTab {
        #if DEBUG
            defaults.string(forKey: "StartTab").flatMap(AppTab.init(rawValue:)) ?? .urgent
        #else
            .urgent
        #endif
    }
}

/// what Urgent should open once its week has loaded
struct UrgentLink: Equatable, Identifiable {
    let id = UUID()
    var requestId: String?
    var fromStart: Bool
}
