import Foundation

// the urgent flow's plain wording and alberta times (utc-6 all year), ported from components/app/urgent/words.ts

/// the decisions that write a message (RequestView.action)
nonisolated enum MessageDecision: String, Sendable, Hashable, CaseIterable {
    case notify, reschedule, `extension`, coverage

    init?(_ decision: Decision?) {
        guard let decision, let value = MessageDecision(rawValue: decision.rawValue) else { return nil }
        self = value
    }

    init?(_ action: RequestAction) {
        guard let value = MessageDecision(rawValue: action.rawValue) else { return nil }
        self = value
    }

    var decision: Decision { Decision(rawValue: rawValue) ?? .notify }
}

/// a saved contact as the screens name them
nonisolated struct UrgentPerson: Sendable, Hashable {
    var contactId: String
    var name: String
    var email: String
}

/// who is being cared for, as the screens name them
nonisolated struct CareName: Sendable, Hashable {
    var name: String
    var alias: String?
}

nonisolated enum UrgentWords {
    static func isMessageDecision(_ decision: Decision?) -> Bool {
        MessageDecision(decision) != nil
    }

    /// the other choices offered beside the suggested one
    static func alternatives(_ decision: MessageDecision) -> [Decision] {
        switch decision {
        case .reschedule, .extension, .coverage: [.notify, .defer]
        case .notify: [.reschedule, .defer]
        }
    }

    // MARK: - tiers

    static let tiers: [DisclosureTier] = [.minimal, .general, .detailed]

    private static let familyWords: Set<String> = [
        "mom", "mum", "mother", "mama", "dad", "father", "papa", "grandma", "grandmother", "nana", "grandpa",
        "grandfather", "wife", "husband", "partner", "son", "daughter", "sister", "brother", "aunt", "uncle",
    ]

    /// the tier's name as the picker shows it; "Say I’m caring for my mom" only when the alias is a family word
    static func tierLabel(_ tier: DisclosureTier, alias: String?) -> String {
        switch tier {
        case .minimal: return "Family matter only"
        case .detailed: return "Share more detail"
        case .general, .unrecognized:
            var word = alias?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            if word.hasPrefix("my ") { word = String(word.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
            return familyWords.contains(word) ? "Say I\u{2019}m caring for my \(word)" : "Say I\u{2019}m caring for family"
        }
    }

    static func tierHint(_ tier: DisclosureTier) -> String {
        switch tier {
        case .minimal: "Says only that you have a family caregiving situation, and the dates."
        case .general, .unrecognized: "Adds who you\u{2019}re caring for and that it\u{2019}s a medical procedure, with no details."
        case .detailed: "Adds what you wrote about why, word for word."
        }
    }

    // MARK: - times

    private static let longWeekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private static let shortWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = AlbertaTime.timeZone
        return calendar
    }

    private static func components(_ iso: String) -> DateComponents? {
        guard let date = AlbertaTime.parse(iso) else { return nil }
        return calendar.dateComponents([.weekday, .month, .day, .hour, .minute], from: date)
    }

    /// the epoch milliseconds of an iso string, or nil (Date.parse NaN)
    static func time(_ iso: String?) -> Double? {
        guard let iso, let date = AlbertaTime.parse(iso) else { return nil }
        return date.timeIntervalSince1970
    }

    private static func clockParts(_ iso: String) -> (hm: String, period: String) {
        guard let p = components(iso) else { return ("", "") }
        let hour24 = p.hour ?? 0
        let hour = hour24 % 12 == 0 ? 12 : hour24 % 12
        let minute = p.minute ?? 0
        let hm = minute == 0 ? "\(hour)" : "\(hour):\(String(format: "%02d", minute))"
        return (hm, hour24 < 12 ? "a.m." : "p.m.")
    }

    /// "10 a.m.", "2:30 p.m."; a non-breaking space keeps it on one line
    static func clock(_ iso: String) -> String {
        let c = clockParts(iso)
        return "\(c.hm)\u{00A0}\(c.period)"
    }

    /// "Monday"
    static func weekday(_ iso: String) -> String {
        guard let p = components(iso), let day = p.weekday else { return "" }
        return longWeekdays[day - 1]
    }

    /// "Monday, Nov 9"
    private static func dayShort(_ iso: String) -> String {
        guard let p = components(iso) else { return "" }
        return "\(longWeekdays[(p.weekday ?? 1) - 1]), \(months[(p.month ?? 1) - 1]) \(p.day ?? 1)"
    }

    /// "Sun, Nov 8, 10 a.m."
    static func stamp(_ iso: String) -> String {
        guard let p = components(iso) else { return "" }
        return "\(shortWeekdays[(p.weekday ?? 1) - 1]), \(months[(p.month ?? 1) - 1]) \(p.day ?? 1), \(clock(iso))"
    }

    private static func isDeadline(_ c: Commitment) -> Bool {
        c.title.range(of: #"deadline|due\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// "Sunday, Nov 8, 10 to 11:30 a.m." or "Due Monday, Nov 9, 11 p.m."
    static func whenLine(_ c: Commitment) -> String {
        guard let start = c.startsAt else { return "No time set" }
        if isDeadline(c) { return "Due \(dayShort(start)), \(clock(start))" }
        let a = clockParts(start)
        guard let end = c.endsAt else { return "\(dayShort(start)), \(a.hm)\u{00A0}\(a.period)" }
        let b = clockParts(end)
        if weekday(start) != weekday(end) {
            return "\(dayShort(start)), \(a.hm)\u{00A0}\(a.period) to \(dayShort(end)), \(b.hm)\u{00A0}\(b.period)"
        }
        let range = a.period == b.period
            ? "\(a.hm) to \(b.hm)\u{00A0}\(b.period)"
            : "\(a.hm)\u{00A0}\(a.period) to \(b.hm)\u{00A0}\(b.period)"
        return "\(dayShort(start)), \(range)"
    }

    // MARK: - people

    /// contact names by id, only as the server saved them: request recipients, then the contacts the scan matched
    static func buildDirectory(_ commitments: [Commitment], _ requests: [RequestView]) -> [String: UrgentPerson] {
        var dir: [String: UrgentPerson] = [:]
        for r in requests {
            dir[r.recipient.contactId] = UrgentPerson(contactId: r.recipient.contactId, name: r.recipient.name, email: r.recipient.email)
        }
        for c in commitments {
            for contact in c.contacts where dir[contact.contactId] == nil {
                dir[contact.contactId] = UrgentPerson(contactId: contact.contactId, name: contact.name, email: contact.email)
            }
            for d in c.dependencies {
                if let id = d.contactId, let name = d.contactName, let ref = d.toRef, dir[id] == nil {
                    dir[id] = UrgentPerson(contactId: id, name: name, email: ref)
                }
            }
        }
        return dir
    }

    private static let titles: Set<String> = ["dr", "mr", "mrs", "ms", "mx", "prof"]

    /// "Jordan" from "Jordan Lee"; a titled name keeps its title and surname ("Dr. Brooks"); an address stays whole
    static func shortName(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace).map(String.init)
        if words.isEmpty { return "them" }
        if name.contains("@") { return name.trimmingCharacters(in: .whitespacesAndNewlines) }
        if words.count > 1 {
            var bare = words[0].lowercased()
            if bare.hasSuffix(".") { bare.removeLast() }
            if titles.contains(bare) { return "\(words[0]) \(words[words.count - 1])" }
        }
        return words[0]
    }

    static func joinNames(_ names: [String]) -> String {
        if names.count <= 1 { return names.first ?? "" }
        return "\(names.dropLast().joined(separator: ", ")) and \(names[names.count - 1])"
    }

    /// the people on the event besides Alex: saved names, or the address itself when unknown
    static func withNames(_ c: Commitment, _ dir: [String: UrgentPerson]) -> [String] {
        var names: [String] = []
        for d in c.dependencies {
            let person = d.contactId.flatMap { dir[$0] }
            let name = person?.name ?? d.contactName ?? d.toRef?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let name, !name.isEmpty, !names.contains(name) { names.append(name) }
        }
        return names
    }

    // MARK: - commitments in sentences

    private static func lowerFirst(_ title: String) -> String {
        let first = title.split(separator: " ", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        // keep codes and names that are all caps, like "ENGG 513"
        if first.count > 1 && first == first.uppercased() { return title }
        guard let head = title.first else { return title }
        return head.lowercased() + title.dropFirst()
    }

    private static func curly(_ text: String) -> String {
        text.replacingOccurrences(of: "'", with: "\u{2019}")
    }

    /// "Rosa’s", "James’"
    static func possessive(_ name: String) -> String {
        name.hasSuffix("s") ? "\(name)\u{2019}" : "\(name)\u{2019}s"
    }

    /// how a sentence names a commitment: "the food bank volunteer shift", "Rosa’s follow-up appointment"
    static func refTitle(_ c: Commitment, _ care: CareName) -> String {
        if c.forCareRecipient {
            let names = [care.alias, care.name].compactMap { $0 }.filter { !$0.isEmpty }
                .map { NSRegularExpression.escapedPattern(for: $0) }
            var rest = c.title
            if !names.isEmpty {
                let pattern = "^(?:\(names.joined(separator: "|")))(?:['\u{2019}]s)?\\s+"
                if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                    rest = regex.stringByReplacingMatches(
                        in: rest, range: NSRange(rest.startIndex..., in: rest), withTemplate: ""
                    )
                }
            }
            return curly("\(possessive(care.name)) \(lowerFirst(rest))")
        }
        return curly("the \(lowerFirst(c.title))")
    }

    /// how a button names it: "Food bank volunteer shift"
    static func buttonTitle(_ c: Commitment, _ care: CareName) -> String {
        let ref = refTitle(c, care)
        if c.forCareRecipient { return ref }
        let plain = ref.hasPrefix("the ") ? String(ref.dropFirst(4)) : ref
        guard let head = plain.first else { return plain }
        return head.uppercased() + plain.dropFirst()
    }

    /// "10 a.m." already ends with a full stop
    static func endSentence(_ text: String) -> String {
        text.hasSuffix(".") ? text : "\(text)."
    }

    /// the muted fact before the ask: "Your group project meeting is Monday at 10 a.m."
    static func factLine(_ c: Commitment, _ care: CareName, appNow: String) -> String {
        let ref = refTitle(c, care)
        let subject = c.forCareRecipient ? ref : "Your \(ref.hasPrefix("the ") ? String(ref.dropFirst(4)) : ref)"
        guard let start = c.startsAt else { return endSentence("\(subject) is during the care week") }
        let over = (time(c.endsAt ?? start) ?? 0) < (time(appNow) ?? 0)
        return endSentence("\(subject) \(over ? "was" : "is") \(weekday(start)) at \(clock(start))")
    }

    static func askLine(_ decision: MessageDecision, _ name: String) -> String {
        switch decision {
        case .reschedule: "Ask \(name) to move it?"
        case .extension: "Ask \(name) for more time?"
        case .coverage: "Ask \(name) to find someone to cover it?"
        case .notify: "Let \(name) know you might miss it?"
        }
    }

    static func sheetTitle(_ decision: MessageDecision, _ name: String) -> String {
        switch decision {
        case .reschedule: "Ask \(name) to move it"
        case .extension: "Ask \(name) for more time"
        case .coverage: "Ask \(name) to find cover"
        case .notify: "Let \(name) know"
        }
    }

    private static func sentLine(_ decision: MessageDecision?, _ name: String) -> String {
        switch decision {
        case .reschedule: "You asked \(name) to move it."
        case .extension: "You asked \(name) for more time."
        case .coverage: "You asked \(name) to find someone to cover it."
        case .notify, nil: "You let \(name) know."
        }
    }

    private static func answeredLine(_ r: RequestView, _ name: String) -> String {
        switch MessageDecision(r.action) {
        case .coverage: "\(name) said yes to covering it."
        case .reschedule: "\(name) said yes to moving it."
        case .extension: "\(name) gave you more time."
        case .notify, nil: "\(name) got your message."
        }
    }

    /// a recipient answered with another time; the other needs_review cause is a send the server stopped
    static func isProposal(_ r: RequestView) -> Bool {
        r.state == .needsReview && (r.proposedAt != nil || r.evidence.first?.evidenceKind == .linkClick)
    }

    /// what has happened with this request, as the ask of the step
    static func outcomeLine(_ r: RequestView) -> String {
        let who = shortName(r.recipient.name)
        switch r.state {
        case .draft, .awaitingApproval: return "Your message to \(who) is ready for your OK."
        case .approved: return "You approved the message to \(who). It hasn\u{2019}t gone out yet."
        case .sending: return "Your message to \(who) is on its way."
        case .requested: return sentLine(MessageDecision(r.action), who)
        case .accepted, .completed: return answeredLine(r, who)
        case .rejected: return "\(who) said no."
        case .expired: return "\(who) didn\u{2019}t reply in time."
        case .failed: return "Your message to \(who) didn\u{2019}t send."
        case .needsReview:
            return isProposal(r) ? "\(who) suggested another time." : "Your message to \(who) needs another look."
        case .cancelled: return "You withdrew the message to \(who)."
        case .unrecognized: return "Your message to \(who) changed."
        }
    }

    /// the step's heading when it wrote to several people, each message approved and sent on its own
    static func outcomeLineMany(_ requests: [RequestView]) -> String {
        if requests.count == 1 { return outcomeLine(requests[0]) }
        let ready = requests.filter {
            $0.state == .draft || $0.state == .awaitingApproval || $0.state == .approved
                || ($0.state == .needsReview && !isProposal($0))
        }
        var unique: [String] = []
        for name in requests.map({ shortName($0.recipient.name) }) where !unique.contains(name) { unique.append(name) }
        let names = joinNames(unique)
        if ready.count == requests.count { return "Your messages to \(names) are ready for your OK." }
        if ready.isEmpty { return "You wrote to \(names)." }
        let count = ready.count == 1 ? "One message is" : "\(ready.count) messages are"
        return "You wrote to \(names). \(count) ready for your OK."
    }

    /// when the request last changed state, from its evidence (newest first)
    static func changedAt(_ r: RequestView) -> String? {
        (r.evidence.first { $0.toState == r.state } ?? r.evidence.first)?.at
    }

    /// newest first by the time each request last changed
    static func newestFirst(_ a: RequestView, _ b: RequestView) -> Bool {
        (time(changedAt(a)) ?? 0) > (time(changedAt(b)) ?? 0)
    }

    /// each person's newest message that wasn't withdrawn, and everything older, both newest first
    static func newestPerPerson(_ requests: [RequestView]) -> (latest: [RequestView], older: [RequestView]) {
        let sorted = requests.filter { $0.state != .cancelled }.sorted(by: newestFirst)
        var seen = Set<String>()
        var latest: [RequestView] = []
        var older: [RequestView] = []
        for r in sorted {
            if seen.contains(r.recipient.contactId) {
                older.append(r)
                continue
            }
            seen.insert(r.recipient.contactId)
            latest.append(r)
        }
        return (latest, older)
    }

    /// a yes, or a message already on its way: a new plan doesn't write to that person again unless Alex ticks them
    private static let settled: Set<RequestState> = [.accepted, .completed, .requested, .sending]

    /// who a new plan writes to when Alex hasn't ticked anyone: the server's match, minus anyone in a group whose
    /// newest message on this commitment already said yes or is waiting for a reply
    static func defaultRecipients(_ c: Commitment, _ requests: [RequestView]) -> [String] {
        let suggested = !c.suggestedContactIds.isEmpty
            ? c.suggestedContactIds
            : c.suggestedContactId.map { [$0] } ?? []
        if c.contacts.count < 2 { return suggested }
        let done = Set(newestPerPerson(requests).latest.filter { settled.contains($0.state) }.map(\.recipient.contactId))
        return suggested.filter { !done.contains($0) }
    }

    /// "“hip” and “surgery”"
    static func quoted(_ terms: [String]) -> String {
        joinNames(terms.map { "\u{201C}\($0)\u{201D}" })
    }

    /// the same shape lib/healthTerms.ts matches: simple plurals, "post op" for "post-op", either apostrophe
    private static func termPattern(_ term: String) -> NSRegularExpression? {
        let lower = term.lowercased()
        let consonantY = lower.range(of: "[^aeiou]y$", options: .regularExpression) != nil
        let stem = consonantY ? String(lower.dropLast()) : lower
        let suffix = consonantY ? "(?:y|ies)" : "(?:s|es)?"
        var body = NSRegularExpression.escapedPattern(for: stem)
        body = body.replacingOccurrences(of: #"\\-|-|\s+"#, with: #"[\\s-]?"#, options: .regularExpression)
        body = body.replacingOccurrences(of: "'", with: "['\u{2019}]?")
        return try? NSRegularExpression(
            pattern: "(?<![\\p{L}\\p{N}])\(body)\(suffix)(?![\\p{L}\\p{N}])", options: [.caseInsensitive]
        )
    }

    private static func replace(_ text: String, _ pattern: String, _ template: String, options: NSRegularExpression.Options = []) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    /// drops the flagged words and tidies the spaces they leave behind
    static func removeTerms(_ text: String, _ terms: [String]) -> String {
        var out = text
        for term in terms {
            guard let regex = termPattern(term) else { continue }
            out = regex.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "")
        }
        out = replace(out, "[ \\t]{2,}", " ")
        out = replace(out, " ([,.?!;:])", "$1")
        out = replace(out, "^[ \\t]+|[ \\t]+$", "", options: [.anchorsMatchLines])
        return out
    }

    static func editFlagNote(_ flag: String, _ name: String) -> String? {
        switch flag {
        case "other_email": "It has an email address that isn\u{2019}t \(name)\u{2019}s. Check it before sending."
        case "url": "It has a web link. Check it before sending."
        case "html": "It has formatting code in it. Check how it reads before sending."
        default: nil
        }
    }

    /// a subject is one line: newlines and the spaces around them become one space
    static func oneLine(_ subject: String) -> String {
        replace(subject, "\\s*\\n\\s*", " ")
    }
}
