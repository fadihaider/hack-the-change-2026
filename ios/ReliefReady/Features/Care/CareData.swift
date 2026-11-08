import Foundation

// ports of components/app/care/care-data.ts and lib/care/lockedWording.ts: which facts still need the caregiver,
// how they group into the passport, and the plain lines shown next to them. pure, so tests can run them

/// one thing to check in the one-at-a-time review: a suggested fact, or a set of notes that disagree
nonisolated struct ReviewStep: Sendable, Hashable, Identifiable {
    enum Kind: Sendable, Hashable { case fact, conflict }

    var kind: Kind
    var key: String
    /// one id for a fact step; every fact in the set for a conflict step
    var factIds: [String]

    var id: String { key }
    var factId: String { factIds.first ?? "" }

    static func fact(_ id: String) -> ReviewStep {
        ReviewStep(kind: .fact, key: "fact:\(id)", factIds: [id])
    }

    static func conflict(_ ids: [String]) -> ReviewStep {
        ReviewStep(kind: .conflict, key: "conflict:\(ids.sorted().joined(separator: ","))", factIds: ids)
    }
}

nonisolated enum LockedWording {
    private static let treatmentWords = try! NSRegularExpression(
        pattern:
            #"\b(?:medications?|medicines?|meds|pills?|tablets?|capsules?|doses?|dosage|mg|mcg|milligrams?|ml|insulin|inhalers?|prescriptions?|prescribed|antibiotics?|painkillers?|pain relievers?|tylenol|acetaminophen|ibuprofen|advil|aspirin|warfarin|blood thinners?|injections?|inject|incisions?|wounds?|dressings?|bandages?|stitches|sutures|eye drops|ear drops)\b"#,
        options: [.caseInsensitive]
    )

    /// isLockedWording: a medical_instruction, or wording about medication, doses or wound care
    static func isLocked(category: String?, text: String) -> Bool {
        if category == "medical_instruction" { return true }
        let range = NSRange(text.startIndex..., in: text)
        return treatmentWords.firstMatch(in: text, range: range) != nil
    }
}

nonisolated enum CareData {
    /// the order helpers most need things in
    static let categoryOrder = ["medical_instruction", "routine", "mobility", "communication", "contacts", "logistics", "preference"]

    /// "Medical instruction as written", "Routine"
    static func categoryTitle(_ category: String?) -> String {
        let label = Labels.category(category)
        return label.prefix(1).uppercased() + label.dropFirst()
    }

    static func plural(_ count: Int, _ one: String, _ many: String) -> String {
        "\(count) \(count == 1 ? one : many)"
    }

    /// cuts at a word near max and adds an ellipsis
    static func shorten(_ text: String, _ max: Int) -> String {
        guard text.count > max else { return text }
        let cut = String(text.prefix(max))
        var kept = cut
        if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > Int(Double(max) * 0.6) {
            kept = String(cut[..<space])
        }
        while let last = kept.last, last.isWhitespace || ",.;:".contains(last) { kept.removeLast() }
        return kept + "\u{2026}"
    }

    /// keeps a YYYY-MM-DD date inside the care week
    static func clampDate(_ date: String, start: String, end: String) -> String {
        if date < start { return start }
        if date > end { return end }
        return date
    }

    /// "Every day at 10:00 a.m.", or "Sat, Nov 14 at 10:00 a.m." for a one-off; nil when the fact has no time
    static func timeLine(_ fact: CareFact) -> String? {
        guard let event = fact.events.first(where: { $0.startsAt != nil }), let startsAt = event.startsAt else { return nil }
        let time = AlbertaTime.format(startsAt, style: .time)
        let when = event.rrule.map { Labels.rrule($0) } ?? AlbertaTime.format(startsAt, style: .day)
        return "\(when) at \(time)"
    }

    /// newestFirst: newer createdAt first, then by position in the source
    static func newestFirst(_ a: CareFact, _ b: CareFact) -> Int {
        if a.createdAt != b.createdAt { return a.createdAt > b.createdAt ? -1 : 1 }
        let diff = (a.spanStart ?? 0) - (b.spanStart ?? 0)
        return diff < 0 ? -1 : diff > 0 ? 1 : 0
    }

    /// what still needs the caregiver: each set of disagreeing facts is one step, then each suggested fact.
    /// facts from firstSourceId (the note just added) come first
    static func pendingSteps(_ facts: [CareFact], firstSourceId: String? = nil) -> [ReviewStep] {
        func fresh(_ fact: CareFact) -> Int { firstSourceId != nil && fact.sourceId == firstSourceId ? 0 : 1 }
        func order(_ a: CareFact, _ b: CareFact) -> Int {
            let byFresh = fresh(a) - fresh(b)
            return byFresh != 0 ? byFresh : newestFirst(a, b)
        }

        let conflicting = facts.filter { $0.status == .conflicting }
        let ids = Set(conflicting.map(\.id))
        var parent = Dictionary(uniqueKeysWithValues: conflicting.map { ($0.id, $0.id) })
        func root(_ id: String) -> String {
            var at = id
            while let up = parent[at], up != at { at = up }
            return at
        }
        for fact in conflicting {
            for other in fact.conflictsWith where ids.contains(other) {
                parent[root(other)] = root(fact.id)
            }
        }
        var groups: [String: [CareFact]] = [:]
        var groupOrder: [String] = []
        for fact in conflicting {
            let key = root(fact.id)
            if groups[key] == nil { groupOrder.append(key) }
            groups[key, default: []].append(fact)
        }
        let conflictSteps = groupOrder
            .map { key in
                (groups[key] ?? []).sorted { a, b in
                    if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
                    return (a.spanStart ?? 0) < (b.spanStart ?? 0)
                }
            }
            .careStableSorted { order(newestOf($0), newestOf($1)) }
            .map { ReviewStep.conflict($0.map(\.id)) }

        let factSteps = facts
            .filter { $0.status == .suggested }
            .careStableSorted(order)
            .map { ReviewStep.fact($0.id) }

        return conflictSteps + factSteps
    }

    private static func newestOf(_ group: [CareFact]) -> CareFact {
        group.dropFirst().reduce(group[0]) { best, fact in newestFirst(fact, best) < 0 ? fact : best }
    }

    /// HH:mm in alberta time, for time-of-day order inside a group
    static func firstStart(_ fact: CareFact) -> String? {
        guard let startsAt = fact.events.first(where: { $0.startsAt != nil })?.startsAt,
            let date = AlbertaTime.parse(startsAt)
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = AlbertaTime.timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    private static func byTimeOfDay(_ a: CareFact, _ b: CareFact) -> Int {
        let x = firstStart(a) ?? "~"
        let y = firstStart(b) ?? "~"
        if x != y { return x < y ? -1 : 1 }
        return newestFirst(a, b)
    }

    struct PassportGroup: Sendable, Hashable, Identifiable {
        var section: PassportSection
        var facts: [CareFact]
        var id: PassportSectionID { section.id }
    }

    /// approved facts in the six settled passport sections, time-of-day order inside each
    static func passportGroups(_ facts: [CareFact]) -> [PassportGroup] {
        var bySection: [PassportSectionID: [CareFact]] = [:]
        for fact in facts where fact.status == .approved {
            bySection[PassportSection.section(of: fact.category), default: []].append(fact)
        }
        return PassportSection.all.filter { $0.id != .open }.map { section in
            PassportGroup(section: section, facts: (bySection[section.id] ?? []).careStableSorted(byTimeOfDay))
        }
    }

    /// the short line for a fact row: the caregiver's label, else a trimmed quote; written instructions are never trimmed
    static func factSummary(_ fact: CareFact) -> String {
        if fact.category == "medical_instruction" { return fact.textExact }
        if let label = fact.displayText?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { return label }
        return shorten(fact.textExact, 100)
    }

    private static let sourcePhraseByKind = ["voice": "a voice note", "note": "a typed note", "document": "a PDF"]

    /// "Nov 8" for an iso instant in alberta time
    static func addedDay(_ iso: String?) -> String? {
        guard let iso, let date = AlbertaTime.parse(iso) else { return nil }
        return AlbertaTime.shortDate(AlbertaTime.dateString(of: date))
    }

    /// "From a voice note, added Nov 8 by you"; an unknown author is left out
    static func provenanceLine(_ fact: CareFact) -> String {
        let from = fact.sourceKind.flatMap { sourcePhraseByKind[$0] }
        let added = addedDay(fact.sourceCreatedAt ?? fact.createdAt).map { ", added \($0)" } ?? ""
        let author = authorName(fact.sourceAuthor).map { " by \($0)" } ?? ""
        return "\(from.map { "From \($0)" } ?? "Source unknown")\(added)\(author)"
    }

    /// "caregiver" is the signed-in person, so it reads as "you"
    static func authorName(_ author: String?) -> String? {
        guard let value = author?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value.lowercased() == "caregiver" ? "you" : value
    }

    /// "Edited — version 2" once a fact has been edited
    static func versionLabel(_ fact: CareFact) -> String? {
        fact.version > 1 ? "Edited \u{2014} version \(fact.version)" : nil
    }

    /// uniqueOpenQuestions: each open question once
    static func uniqueOpenQuestions(_ questions: [OpenQuestion]) -> [OpenQuestion] {
        var seen = Set<String>()
        return questions.filter { item in
            let key = item.question.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                .replacing(/[\s?.]+$/, with: "")
            guard !key.isEmpty, !seen.contains(key) else { return false }
            seen.insert(key)
            return true
        }
    }

    /// the earlier versions an edited fact replaced, newest first
    static func earlierVersions(_ fact: CareFact, in facts: [CareFact]) -> [CareFact] {
        guard fact.version > 1, let first = fact.supersedes else { return [] }
        let byId = Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var chain: [CareFact] = []
        var seen: Set<String> = [fact.id]
        var previous = byId[first]
        while let item = previous, item.status == .superseded, !seen.contains(item.id) {
            chain.append(item)
            seen.insert(item.id)
            previous = item.supersedes.flatMap { byId[$0] }
        }
        return chain
    }

    struct SourceParts: Sendable, Hashable {
        var before: String
        var match: String
        var after: String
    }

    /// splits the retained source around the fact's span (utf-16 offsets, as the server counts them); the span is
    /// trusted only when it points at the fact's own wording, else the first exact match is used
    static func sourceParts(_ fullText: String, fact: CareFact) -> SourceParts? {
        let text = fullText as NSString
        if let s = fact.spanStart, let e = fact.spanEnd, s.rounded() == s, e.rounded() == e, s >= 0, e > s,
            Int(e) <= text.length
        {
            let range = NSRange(location: Int(s), length: Int(e - s))
            if text.substring(with: range) == fact.textExact {
                return parts(text, range)
            }
        }
        guard !fact.textExact.isEmpty else { return nil }
        let found = text.range(of: fact.textExact)
        guard found.location != NSNotFound else { return nil }
        return parts(text, found)
    }

    private static func parts(_ text: NSString, _ range: NSRange) -> SourceParts {
        SourceParts(
            before: text.substring(to: range.location),
            match: text.substring(with: range),
            after: text.substring(from: range.location + range.length)
        )
    }

    struct OpenItems: Sendable, Hashable {
        /// each set of notes that disagree, oldest note first
        var conflicts: [[CareFact]]
        var suggested: Int
        var steps: [ReviewStep]
    }

    static func openItems(_ facts: [CareFact]) -> OpenItems {
        let steps = pendingSteps(facts)
        let byId = Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var conflicts: [[CareFact]] = []
        var suggested = 0
        for step in steps {
            if step.kind == .fact {
                suggested += 1
                continue
            }
            let group = step.factIds.compactMap { byId[$0] }
            if !group.isEmpty { conflicts.append(group) }
        }
        return OpenItems(conflicts: conflicts, suggested: suggested, steps: steps)
    }
}

nonisolated extension Array {
    /// a stable sort from a three-way comparator, like Array.prototype.sort
    func careStableSorted(_ compare: (Element, Element) -> Int) -> [Element] {
        enumerated()
            .sorted { a, b in
                let c = compare(a.element, b.element)
                return c != 0 ? c < 0 : a.offset < b.offset
            }
            .map(\.element)
    }
}
