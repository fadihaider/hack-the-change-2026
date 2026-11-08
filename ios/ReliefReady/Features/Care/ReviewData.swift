import Foundation

// port of components/app/care/review-data.ts: labels, source context and the end summary for checking one at a time

/// what the caregiver decided on one step
nonisolated enum ReviewOutcome: Sendable, Hashable {
    case approved
    case edited(factId: String, text: String, original: String)
    case rejected(text: String)
    case skipped
    case kept(factId: String)
}

/// counts for the end of a check; approved includes edited, skipped is everything still waiting
nonisolated struct ReviewSummary: Sendable, Hashable {
    var approved = 0
    var kept = 0
    var skipped = 0
    var edited = 0
    var rejected = 0
}

nonisolated struct ReviewSummaryRow: Sendable, Hashable, Identifiable {
    var key: String
    var label: String
    var count: Int
    var id: String { key }
}

nonisolated struct SourceContext: Sendable, Hashable {
    var before: String
    var quote: String
    var after: String
    var cutStart: Bool
    var cutEnd: Bool
}

nonisolated enum ReviewData {
    /// the passport section a suggestion would go under
    static func sectionTitle(_ category: String?) -> String {
        guard let category else { return "Contacts & logistics" }
        let id = PassportSection.section(of: category)
        return PassportSection.all.first { $0.id == id }?.title ?? "Practical needs & belongings"
    }

    /// "Typed note from you, Nov 8"
    static func reviewSourceLine(_ fact: CareFact) -> String {
        let by = fact.sourceAuthor == "caregiver" ? " from you" : ""
        let source = "\(Labels.source(fact.sourceKind))\(by)"
        guard let day = CareData.addedDay(fact.sourceCreatedAt ?? fact.createdAt) else { return source }
        return "\(source), \(day)"
    }

    static func contextLabel(_ kind: String?) -> String {
        switch kind {
        case "voice": "In your voice note"
        case "note": "In your typed note"
        case "document": "In the PDF"
        default: "In the source"
        }
    }

    static func wholeSourceLabel(_ kind: String?) -> String {
        switch kind {
        case "voice": "Show the whole transcript"
        case "document": "Show the whole PDF text"
        default: "Show the whole note"
        }
    }

    /// what approving a timed suggestion does; nil when it has no time
    static func consequenceLine(name: String, fact: CareFact) -> String? {
        guard let event = fact.events.first(where: { $0.startsAt != nil }), let startsAt = event.startsAt else { return nil }
        let time = AlbertaTime.format(startsAt, style: .time)
        let day = "\(Labels.possessive(name)) day"
        var line: String
        if let rrule = event.rrule {
            let repeatText = Labels.rrule(rrule)
            line = repeatText == "Repeats"
                ? "Approving adds it to \(day) at \(time), repeating"
                : "Approving adds it to \(day) at \(time) \(repeatText.prefix(1).lowercased())\(repeatText.dropFirst())"
        } else {
            line = "Approving adds it to \(day) on \(AlbertaTime.format(startsAt, style: .day)) at \(time)"
        }
        if let minutes = event.remindMinutes, minutes > 0, let start = AlbertaTime.parse(startsAt) {
            let remind = AlbertaTime.format(start.addingTimeInterval(-minutes * 60), style: .time)
            line += ", with a reminder at \(remind)"
        }
        return line.hasSuffix(".") ? line : line + "."
    }

    /// the step label in the progress list; locked wording is named, never cut short
    static func stepLabel(_ fact: CareFact, max: Int = 60) -> String {
        if LockedWording.isLocked(category: fact.category, text: fact.textExact) { return "Written care instruction" }
        return CareData.shorten(fact.displayText ?? fact.textExact, max)
    }

    /// a fact quoted in a receipt: shortened unless its wording is locked
    static func quoteOf(_ fact: CareFact, max: Int) -> String {
        LockedWording.isLocked(category: fact.category, text: fact.textExact) ? fact.textExact : CareData.shorten(fact.textExact, max)
    }

    /// the honest label for a conflict note; nil when the provider is unknown so the note is not shown
    static func noteLabel(_ aiMode: String?) -> String? {
        switch aiMode {
        case "demo": "Demo rules note"
        case "anthropic": "Claude\u{2019}s note"
        case "bedrock": "Claude\u{2019}s note, via Amazon Bedrock"
        default: nil
        }
    }

    static let contextMax = 240

    /// the sentence a suggestion came from with a neighbour each side when they fit. works in utf-16 units, as the
    /// server's spans do
    static func sourceContext(_ fullText: String, fact: CareFact, max: Int = contextMax) -> SourceContext? {
        let quote = fact.textExact
        guard !quote.isEmpty, !fullText.isEmpty else { return nil }
        let text = fullText as NSString
        let units = Array(fullText.utf16)
        let n = units.count
        let quoteLength = (quote as NSString).length

        var start = fact.spanStart.map { Int($0) } ?? -1
        var end = fact.spanEnd.map { Int($0) } ?? -1
        if start < 0 || end > n || start >= end || text.substring(with: NSRange(location: start, length: end - start)) != quote {
            let found = text.range(of: quote)
            guard found.location != NSNotFound else { return nil }
            start = found.location
            end = start + quoteLength
        }

        func isSpace(_ at: Int) -> Bool {
            guard at >= 0, at < n, let scalar = Unicode.Scalar(units[at]) else { return false }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        func isBreak(_ at: Int) -> Bool {
            let unit = units[at]
            if unit == 10 { return true }
            guard unit == 46 || unit == 33 || unit == 63 else { return false }
            return at + 1 >= n || isSpace(at + 1)
        }
        func sentenceStart(_ at: Int) -> Int {
            var s = at
            while s > 0 && !isBreak(s - 1) { s -= 1 }
            while s < at && isSpace(s) { s += 1 }
            return s
        }
        func scanEnd(_ at: Int) -> Int {
            var e = at
            while e < n && !isBreak(e) { e += 1 }
            return min(n, e + 1)
        }
        func sentenceEnd(_ at: Int) -> Int {
            if at > 0 && isBreak(at - 1) { return at }
            return scanEnd(at)
        }

        var from = sentenceStart(start)
        var to = sentenceEnd(end)
        if from > 0 {
            var back = from
            while back > 0 && isSpace(back - 1) { back -= 1 }
            let earlier = back > 0 ? sentenceStart(back - 1) : from
            if to - earlier <= max { from = earlier }
        }
        if to < n {
            var ahead = to
            while ahead < n && isSpace(ahead) { ahead += 1 }
            let later = ahead < n ? scanEnd(ahead) : to
            if later - from <= max { to = later }
        }
        if to - from > max {
            let room = Swift.max(0, max - quoteLength)
            from = Swift.max(from, start - room / 2)
            to = Swift.min(to, end + (room + 1) / 2)
            while from > 0 && from < start && !isSpace(from - 1) { from += 1 }
            while to < n && to > end && !isSpace(to) { to -= 1 }
        }

        let before = text.substring(with: NSRange(location: from, length: start - from)).replacing(/^\s+/, with: "")
        let after = text.substring(with: NSRange(location: end, length: to - end)).replacing(/\s+$/, with: "")
        if before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && after.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        return SourceContext(before: before, quote: quote, after: after, cutStart: from > 0, cutEnd: to < n)
    }

    private static func stillOpen(_ step: ReviewStep, _ byId: [String: CareFact]) -> Bool {
        if step.kind == .fact { return byId[step.factId]?.status == .suggested }
        return step.factIds.contains { byId[$0]?.status == .conflicting }
    }

    static func summarize(_ steps: [ReviewStep], outcomes: [String: ReviewOutcome], facts: [CareFact]) -> ReviewSummary {
        let byId = Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var summary = ReviewSummary()
        for step in steps {
            switch outcomes[step.key] {
            case .approved:
                summary.approved += 1
            case .edited:
                summary.approved += 1
                summary.edited += 1
            case .rejected:
                summary.rejected += 1
            case .kept:
                summary.kept += 1
            case .skipped:
                summary.skipped += 1
            case nil:
                if stillOpen(step, byId) { summary.skipped += 1 }
            }
        }
        return summary
    }

    /// the rows on the last screen; "kept" only when there were notes that disagreed
    static func summaryRows(_ summary: ReviewSummary) -> [ReviewSummaryRow] {
        var rows = [
            ReviewSummaryRow(key: "approved", label: "Approved as written", count: summary.approved - summary.edited),
            ReviewSummaryRow(key: "edited", label: "Edited and approved", count: summary.edited),
        ]
        if summary.kept > 0 {
            rows.append(ReviewSummaryRow(key: "kept", label: "Picked from notes that disagreed", count: summary.kept))
        }
        rows.append(ReviewSummaryRow(key: "rejected", label: "Rejected", count: summary.rejected))
        rows.append(ReviewSummaryRow(key: "skipped", label: "Left for later", count: summary.skipped))
        return rows
    }

    static func summarySentence(_ summary: ReviewSummary) -> String {
        summaryRows(summary)
            .map { "\($0.count) \($0.label.prefix(1).lowercased())\($0.label.dropFirst())" }
            .joined(separator: ", ") + "."
    }
}
