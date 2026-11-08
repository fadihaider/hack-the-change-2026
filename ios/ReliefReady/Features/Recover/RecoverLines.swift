import Foundation

// plain lines for the recover list (components/app/recover/lines.ts): what happened to each message, said from
// alex's side. every line is built from the recorded state and its evidence rows; nothing claims more than they show

/// the PRD 13 groups, straight from the api's groups, plus the rows that need alex for the heading
nonisolated struct RecoverSorted: Sendable, Hashable {
    var followUp: [RequestView]
    var notSent: [RequestView]
    var newTimes: [RecoverNewItem]
    var waiting: [RequestView]
    var handled: [RequestView]
    /// needs follow-up plus the not-sent rows that still need a decision; drives the heading only
    var needsYou: [RequestView]

    var total: Int { followUp.count + notSent.count + waiting.count + handled.count + newTimes.count }
}

/// the heading at the top of the list: a muted lead and the question
nonisolated struct RecoverHeading: Sendable, Hashable {
    var lead: String
    var question: String
}

nonisolated enum RecoverLines {
    /// the states in the api's not-sent group that still need alex; cancelled ones do not
    static let unsentOpen: Set<RequestState> = [.draft, .awaitingApproval, .approved]

    /// sortGroups: keeps the api's grouping; not-sent rows that need alex come before cancelled ones
    static func sort(_ groups: RecoverGroups) -> RecoverSorted {
        let open = groups.notSent.filter { unsentOpen.contains($0.state) }
        let closed = groups.notSent.filter { !unsentOpen.contains($0.state) }
        return RecoverSorted(
            followUp: groups.needsFollowUp,
            notSent: open + closed,
            newTimes: groups.new,
            waiting: groups.waiting,
            handled: groups.handled,
            needsYou: groups.needsFollowUp + open
        )
    }

    /// when a request last reached a state, from its evidence (newest first)
    private static func reachedAt(_ request: RequestView, _ state: RequestState) -> String? {
        request.evidence.first { $0.toState == state }?.at
    }

    private static func lastChange(_ request: RequestView) -> String? {
        request.evidence.first?.at
    }

    private static func at(_ iso: String?) -> String {
        AlbertaTime.format(iso)
    }

    /// "p.m." already ends a sentence; never write "p.m.."
    static func sentence(_ text: String) -> String {
        text.hasSuffix(".") || text.hasSuffix("?") ? text : "\(text)."
    }

    /// the fixed reasons the server writes when it holds a message back at send time (lib/requests/workflow.ts)
    static let heldReason: [String: String] = [
        "approval hash mismatch": "the message changed after you approved it",
        "health term at send": "a health word was found just before it went",
    ]

    /// true when the server held the message back at send time; that needs_review must never read as a reply
    static func heldBack(_ request: RequestView) -> Bool {
        request.state == .needsReview && request.proposedAt == nil && request.evidence.first?.evidenceKind == .error
    }

    /// a pill label that overrides the state's own label, or nil to use it
    static func pillLabel(_ request: RequestView) -> String? {
        heldBack(request) ? "Held back" : nil
    }

    /// statusLine: one line saying where the message stands, with its time
    static func statusLine(_ request: RequestView, mail: String = "gmail") -> String {
        let outbox = mail == "outbox"
        let changed = lastChange(request)
        switch request.state {
        case .draft:
            return "Still a draft. Nothing has been sent."
        case .awaitingApproval:
            return "Nothing has been sent. It\u{2019}s waiting for your OK."
        case .approved:
            if let when = request.approval?.at ?? reachedAt(request, .approved) {
                return "You approved it \(at(when)), but it hasn\u{2019}t gone out yet."
            }
            return "Approved, but it hasn\u{2019}t gone out yet."
        case .sending:
            let check = outbox ? "the demo outbox" : "your Gmail Sent folder"
            let started = changed.map { sentence("Sending started \(at($0))") } ?? "Sending started."
            return "\(started) No result came back, so check \(check) before sending again."
        case .requested:
            let verb = outbox ? "Placed in the demo outbox" : "Sent by email"
            let first = reachedAt(request, .requested).map { sentence("\(verb) \(at($0))") } ?? "\(verb)."
            let noEmail = outbox ? " No real email went out." : ""
            let due = request.respondBy.map { " " + sentence("Reply due by \(at($0))") } ?? ""
            return "\(first)\(noEmail)\(due)"
        case .accepted:
            return changed.map { sentence("Said yes \(at($0))") } ?? "Said yes."
        case .completed:
            return changed.map { sentence("Marked done \(at($0))") } ?? "Marked done."
        case .rejected:
            return changed.map { sentence("Said no \(at($0))") } ?? "Said no."
        case .expired:
            return request.respondBy.map { sentence("No reply by \(at($0))") } ?? "No reply in time."
        case .failed:
            if outbox {
                return changed.map { sentence("It couldn\u{2019}t be placed in the demo outbox \(at($0))") }
                    ?? "It couldn\u{2019}t be placed in the demo outbox."
            }
            if let changed {
                return "Tried to send it \(at(changed)), but the mail service didn\u{2019}t confirm it. Check your Sent folder before trying again."
            }
            return "The mail service didn\u{2019}t confirm it. Check your Sent folder before trying again."
        case .needsReview:
            if let proposed = request.proposedAt { return sentence("Asked for \(at(proposed)) instead") }
            if heldBack(request) {
                let reason = heldReason[request.evidence.first?.evidenceRef ?? ""] ?? "it needs another look"
                if let changed { return "Held back before sending \(at(changed)): \(reason)." }
                return "Held back before sending: \(reason)."
            }
            if request.evidence.first?.evidenceKind == .linkClick {
                return "Answered through their reply link. Check what they asked."
            }
            return "Needs another look before anything else happens."
        case .cancelled:
            return changed.map { sentence("Cancelled \(at($0))") } ?? "Cancelled."
        case .unrecognized:
            return ""
        }
    }

    /// the fixed error codes the server records, in plain words; anything else stays generic
    private static func errorLine(_ ref: String?, outbox: Bool) -> String {
        switch ref {
        case "approval hash mismatch": return "Held back: the message changed after you approved it."
        case "health term at send": return "Held back: a health word was found just before it went."
        case "gmail_send_failed":
            return outbox ? "It couldn\u{2019}t be placed in the demo outbox." : "The mail service didn\u{2019}t confirm it went out."
        default: return "Something stopped it."
        }
    }

    /// evidenceLine: one evidence row in plain words. raw refs (token hashes, message ids, approval hashes) are never
    /// shown; only the fixed codes above are mapped to text
    static func evidenceLine(_ event: RequestEvidence, request: RequestView, mail: String = "gmail") -> String {
        let outbox = mail == "outbox"
        let name = request.recipient.name
        switch event.evidenceKind {
        case .approval:
            if event.toState == .approved { return "You approved this exact message." }
            if event.toState == .sending {
                return outbox ? "Placing it in the demo outbox started from your approval." : "Sending started from your approval."
            }
            return "Recorded from your approval."
        case .gmailMessageId:
            return outbox ? "Placed in the demo outbox. No real email went out." : "Sent by email. Gmail accepted it."
        case .linkClick:
            switch event.toState {
            case .accepted: return "\(name) chose Accept on their reply link."
            case .rejected: return "\(name) chose Decline on their reply link."
            case .needsReview: return "\(name) asked for another time on their reply link."
            default: return "\(name) used their reply link."
            }
        case .scheduler:
            return "The reply deadline passed with no answer."
        case .userManual:
            switch event.toState {
            case .awaitingApproval:
                return event.fromState == .draft ? "You chose this message to review." : "You changed it, so it needs your OK again."
            case .cancelled: return "You chose not to send it."
            case .completed: return "You marked it done."
            default: return "You changed it."
            }
        case .error:
            return errorLine(event.evidenceRef, outbox: outbox)
        default:
            return "Recorded by ReliefReady."
        }
    }

    /// "Jordan Lee", "Jordan Lee and Morgan Chen", or "3 people"
    static func namesOf(_ requests: [RequestView]) -> String {
        var seen = Set<String>()
        let names = requests.map(\.recipient.name).filter { seen.insert($0).inserted }
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default: return "\(names.count) people"
        }
    }

    /// "2 need follow-up, 1 isn't sent, 1 is waiting for a reply and 1 is handled."
    static func summaryLine(_ sorted: RecoverSorted) -> String {
        var parts: [String] = []
        let followUp = sorted.followUp.count
        let notSent = sorted.notSent.count
        let newTimes = sorted.newTimes.count
        let waiting = sorted.waiting.count
        let handled = sorted.handled.count
        if followUp > 0 { parts.append("\(followUp) \(followUp == 1 ? "needs" : "need") follow-up") }
        if notSent > 0 { parts.append("\(notSent) \(notSent == 1 ? "isn\u{2019}t" : "aren\u{2019}t") sent") }
        if newTimes > 0 { parts.append("\(newTimes) \(newTimes == 1 ? "new time came in" : "new times came in")") }
        if waiting > 0 { parts.append("\(waiting) \(waiting == 1 ? "is" : "are") waiting for a reply") }
        if handled > 0 { parts.append("\(handled) \(handled == 1 ? "is" : "are") handled") }
        guard let last = parts.popLast() else { return "" }
        let text = parts.isEmpty ? last : "\(parts.joined(separator: ", ")) and \(last)"
        return sentence(text.prefix(1).uppercased() + text.dropFirst())
    }

    /// a stable picture of the list, to tell whether a check changed anything
    static func signature(_ groups: RecoverGroups) -> String {
        let all = groups.handled + groups.waiting + groups.needsFollowUp + groups.notSent
        let rows = all.map { "\($0.id):\($0.state.rawValue)" }.sorted()
        let times = groups.new.map { "new:\($0.id)" }.sorted()
        return (rows + times).joined(separator: "|")
    }

    /// the line under the heading about the care week, from the session's today and the episode dates
    static func weekLine(name: String, today: String, episode: EpisodeSummary) -> String {
        // YYYY-MM-DD strings compare in date order, as the web compares them
        if today < episode.startsOn {
            return "\(Labels.possessive(name)) care week starts \(AlbertaTime.dayLabel(episode.startsOn))."
        }
        if today > episode.endsOn {
            return "\(Labels.possessive(name)) care week ended \(AlbertaTime.dayLabel(episode.endsOn))."
        }
        return "\(Labels.possessive(name)) care week ends \(AlbertaTime.dayLabel(episode.endsOn))."
    }

    /// the four heading variants in RecoverScreen.tsx
    static func heading(_ sorted: RecoverSorted, name: String, today: String, episode: EpisodeSummary) -> RecoverHeading {
        let week = weekLine(name: name, today: today, episode: episode)
        if sorted.total == 0 {
            return RecoverHeading(
                lead: "Nothing has gone out for \(Labels.possessive(name)) care week yet.", question: "Start with what the week affects?"
            )
        }
        if sorted.needsYou.isEmpty && !sorted.waiting.isEmpty {
            return RecoverHeading(
                lead: "Nothing needs you right now.", question: sentence("Waiting for \(namesOf(sorted.waiting)) to reply")
            )
        }
        if sorted.needsYou.isEmpty {
            return RecoverHeading(lead: week, question: "You\u{2019}re clear to get back to normal.")
        }
        return RecoverHeading(lead: week, question: "What\u{2019}s left before things are back to normal?")
    }

    /// URGENT_STEP: states with a next step get a clear link; every other row links back to urgent quietly
    static func urgentStep(_ state: RequestState) -> String? {
        switch state {
        case .draft, .awaitingApproval: "Review and send in Urgent"
        case .needsReview, .sending: "Open it in Urgent"
        case .rejected, .expired, .failed: "Choose what to do in Urgent"
        default: nil
        }
    }

    /// the "See it in Urgent" label for a row
    static func urgentLabel(_ state: RequestState) -> String {
        urgentStep(state) ?? "See it in Urgent"
    }

    /// the group hint under "Waiting"
    static func waitingHint(mail: String) -> String {
        mail == "outbox" ? "In the demo outbox, waiting for a reply link." : "Sent by email, waiting for a reply link."
    }

    /// the note at the foot of the list
    static func recordNote(mail: String) -> String {
        let first = mail == "outbox"
            ? "Each status comes from a record: a message placed in the demo outbox, a reply link someone used, or a deadline that passed."
            : "Each status comes from a record: an email Gmail accepted, a reply link someone used, or a deadline that passed."
        return "\(first) Email replies aren\u{2019}t read, so only reply links count."
    }

    /// the title of a New row: "Proposed:" is dropped; a blank title is "A new time"
    static func newTimeTitle(_ title: String?) -> String {
        let text = (title ?? "").replacing(/^Proposed:\s*/.ignoresCase(), with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "A new time" : text
    }

    /// what "Check for new replies" reports, from the list before and after
    static func checkMessage(before: String?, after: RecoverResponse) -> String {
        let expired = after.expiredRequestIds.count
        if expired > 0 { return "\(expired) \(expired == 1 ? "message" : "messages") ran out of time for a reply." }
        if let before, before != signature(after.groups) { return "The list now shows the newest replies." }
        return "Nothing new since you last looked."
    }

    /// what a send reports, by its result
    static func sendMessage(_ result: SendResult, name: String, mail: String) -> (good: Bool, text: String) {
        let outbox = mail == "outbox"
        switch result {
        case .requested:
            return (
                true,
                outbox
                    ? "Placed in the demo outbox for \(name). No real email went out. Waiting for them to use a reply link."
                    : "Sent by email to \(name). Waiting for them to use a reply link."
            )
        case .failed:
            return (
                false,
                outbox
                    ? "The message to \(name) couldn\u{2019}t be placed in the demo outbox. Choose what to do in Urgent."
                    : "The mail service didn\u{2019}t confirm the message to \(name). Check your Sent folder, then choose what to do in Urgent."
            )
        case .needsReview:
            return (false, "The message to \(name) was held back before it went. Open it in Urgent.")
        }
    }

    /// actionMessage: plain words for a failed send or cancel; the list reloads right after
    static func actionMessage(_ error: APIError) -> String {
        switch error.status {
        case 409: return "This message changed somewhere else. The list now shows where it stands."
        case 404: return "This message isn\u{2019}t on file anymore. The list is up to date now."
        case 0:
            return "ReliefReady couldn\u{2019}t reach its server. Check your connection, then try again."
        default: return error.userMessage
        }
    }
}
