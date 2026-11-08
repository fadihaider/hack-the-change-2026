import Foundation

/// what the web's /r/[token] page reads from the server-side preview (subject, body, state, choice, respondBy).
/// there is no json route for it, so the app builds it from the outbox message the link came from and the owner's
/// request list: the message id is the request's gmail_message_id evidence ref
nonisolated struct ResponsePreview: Sendable, Hashable {
    var subject: String
    var body: String
    /// the request's recorded state word; only "requested" can still be answered
    var state: String
    var choice: ResponseChoice
    var respondBy: String?

    var isOpen: Bool { state == RequestState.requested.rawValue }

    /// notFound when no outbox message carries the link, as the server answers 404 for an unknown token.
    /// unavailable when the request it belongs to is not in the list: its recorded state is unknown, so the page
    /// never offers an answer that may already be closed (the web reads the state on the server)
    static func build(
        link: ResponseLink, outbox: Outbox, requests: [RequestView]
    ) -> Result<ResponsePreview, ResponseCopy.Failure> {
        guard let message = outbox.messages.first(where: { message in
            message.responseLinks.contains { $0.token == link.token }
        }) else { return .failure(.notFound) }
        guard let choice = link.choice ?? message.responseLinks.first(where: { $0.token == link.token })?.choice else {
            return .failure(.notFound)
        }
        guard let request = matchRequest(for: message, in: requests) else { return .failure(.unavailable) }
        return .success(ResponsePreview(
            subject: request.subject,
            body: request.body,
            state: request.state.rawValue,
            choice: choice,
            respondBy: request.respondBy
        ))
    }

    /// the request a stored message was sent for: by its gmail_message_id evidence, else by subject and address
    static func matchRequest(for message: OutboxMessage, in requests: [RequestView]) -> RequestView? {
        if let byEvidence = requests.first(where: { request in
            request.evidence.contains { $0.evidenceKind == .gmailMessageId && $0.evidenceRef == message.id }
        }) {
            return byEvidence
        }
        return requests.first { $0.subject == message.subject && $0.recipient.email == message.to }
    }
}

/// the copy of the reply page (app/r/[token]/ResponseForm.tsx and page.tsx)
nonisolated enum ResponseCopy {
    static let noteMax = 300

    struct Ask: Sendable, Hashable {
        var lead: String
        var ask: String
        var button: String
    }

    /// ASK
    static func ask(_ choice: ResponseChoice) -> Ask {
        switch choice {
        case .accept:
            Ask(lead: "Nothing is recorded until you confirm.", ask: "Accept this request?", button: "Accept the request")
        case .decline:
            Ask(lead: "Nothing is recorded until you confirm.", ask: "Decline this request?", button: "Decline the request")
        case .propose:
            Ask(lead: "Nothing is recorded until you send it.", ask: "Which time would work better?", button: "Send this time")
        }
    }

    /// the page's failure screens (FAILURES in page.tsx)
    enum Failure: Error, Sendable, Hashable {
        case notFound, unavailable

        var title: String {
            switch self {
            case .notFound: "This link is invalid or has expired."
            case .unavailable: "This page isn\u{2019}t available right now."
            }
        }

        var next: String {
            switch self {
            case .notFound: "If you still need to answer, ask the person who sent it for a new message."
            case .unavailable: "Nothing was recorded. Open the link again a little later."
            }
        }
    }

    static let about =
        "ReliefReady helps someone who suddenly has to care for family let people know and rearrange their week. Your answer is recorded for the person who sent this request."

    /// the heading after a confirm: the recorded answer, or why nothing new was recorded
    static func doneHeading(_ result: ResponseResult) -> (lead: String?, question: String) {
        if result.recorded {
            return ("Thank you.", "Your answer was recorded: \(ResponseLabels.state(result.state)).")
        }
        return (nil, ResponseLabels.closedMessage(result.state))
    }

    /// the note's length as the web counts it ([...note].length: code points)
    static func length(_ note: String) -> Int {
        note.unicodeScalars.count
    }

    /// a note cut to the limit, as maxLength does
    static func clipped(_ note: String) -> String {
        guard length(note) > noteMax else { return note }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: note.unicodeScalars.prefix(noteMax))
        return String(scalars)
    }

    /// a starting time for the picker: 10:00 a.m. alberta time on the day after the app's now
    static func defaultProposal(after now: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = AlbertaTime.timeZone
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        return calendar.date(bySettingHour: 10, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }
}
