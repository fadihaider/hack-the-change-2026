import Foundation

extension Notification.Name {
    /// posted by Recover's "See it in Urgent" links (urgentHref in lines.ts). the shell should switch to the Urgent tab
    /// and, when userInfo carries "requestId", open that request. MainTabs keeps its selection private, so the
    /// coordinator wires this up: .onReceive(NotificationCenter.default.publisher(for: .reliefReadyShowUrgent))
    nonisolated static let reliefReadyShowUrgent = Notification.Name("ReliefReadyShowUrgent")
}

nonisolated enum RecoverNavigation {
    /// the userInfo key holding the request id
    static let requestIdKey = "requestId"

    /// asks the shell to show Urgent, opened at a request
    static func showUrgent(requestId: String?, center: NotificationCenter = .default) {
        var info: [String: String] = [:]
        if let requestId { info[requestIdKey] = requestId }
        center.post(name: .reliefReadyShowUrgent, object: nil, userInfo: info)
    }
}
