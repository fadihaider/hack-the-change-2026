import Foundation

/// one piece of a stored message body: plain text, or a line holding one of the app's own reply links
nonisolated enum OutboxSegment: Sendable, Hashable {
    case text(String)
    /// the words before the link on its line ("Accept:"), trimmed; empty when the link stands alone
    case link(label: String, link: ResponseLink)
}

nonisolated enum OutboxContent {
    /// linkify in app/outbox/page.tsx, by line: only the app's own /r/<token> links become tappable; any other
    /// text stays plain. consecutive plain lines stay together as one paragraph; a blank line starts the next one
    static func segments(_ body: String) -> [OutboxSegment] {
        var out: [OutboxSegment] = []
        var pending: [Substring] = []
        func flush() {
            guard !pending.isEmpty else { return }
            let text = pending.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !text.isEmpty { out.append(.text(text)) }
            pending = []
        }
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            // a blank line ends a paragraph
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
                continue
            }
            let links = ResponseLink.find(in: String(line))
            guard !links.isEmpty else {
                pending.append(line)
                continue
            }
            flush()
            var rest = Substring(line)
            for link in links {
                guard let range = rest.range(of: link.url) else { continue }
                let label = rest[..<range.lowerBound].trimmingCharacters(in: .whitespaces)
                out.append(.link(label: label, link: link))
                rest = rest[range.upperBound...]
            }
            let tail = rest.trimmingCharacters(in: .whitespaces)
            if !tail.isEmpty { pending.append(Substring(tail)) }
        }
        flush()
        return out
    }

    /// the request text inside a stored message: everything before the reply-link block that
    /// lib/requests/workflow.ts appends ("\n\nRespond (each link asks you to confirm):")
    static func letterBody(_ body: String) -> String {
        let marker = "\n\nRespond (each link asks you to confirm):"
        if let range = body.range(of: marker) { return String(body[..<range.lowerBound]) }
        // no marker: drop the link lines themselves, keep the rest
        let kept = body.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { ResponseLink.find(in: String($0)).isEmpty }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// the outbox heading for a message count
    static func question(count: Int) -> String {
        count == 1
            ? "Here\u{2019}s the message that would have gone out."
            : "Here are the \(count) messages that would have gone out."
    }

    /// the texts heading for a count
    static func textsTitle(count: Int) -> String {
        count == 1 ? "1 text that would have gone out" : "\(count) texts that would have gone out"
    }

    /// the simulated texts, newest first: what the demo sms adapter stored instead of sending (listSmsOutbox)
    static func simulatedTexts(_ list: SmsList) -> [SmsView] {
        list.texts
            .filter { $0.delivery == .simulated }
            .sorted { savedAt($0) > savedAt($1) }
    }

    /// when the demo stored a text
    static func savedAt(_ text: SmsView) -> String {
        text.submittedAt ?? text.statusAt ?? text.updatedAt
    }
}
