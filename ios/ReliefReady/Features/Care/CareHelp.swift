import Foundation

// port of lib/frontend/care-help.ts: the ask bar and the emergency / help control

nonisolated enum CareHelp {
    static let emergencyURL = URL(string: "tel:911")!
    static let healthLinkURL = URL(string: "tel:811")!

    /// a tel: link for a typed phone number, or nil when it is not a plain number
    static func telURL(_ value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // 0-9, not \d: swift's \d takes any unicode digit, so "403５５５0142" would pass and dial a different number
        guard trimmed.wholeMatch(of: /\+?[0-9\s().\-]+/) != nil else { return nil }
        let digits = trimmed.filter { $0.isASCII && $0.isNumber }
        guard digits.count >= 3, digits.count <= 15 else { return nil }
        return URL(string: "tel:\(trimmed.hasPrefix("+") ? "+" : "")\(digits)")
    }

    /// emergency contacts first, then trusted helpers, each in the order they were added
    static func orderContacts(_ contacts: [CareContact]) -> [CareContact] {
        contacts.careStableSorted { a, b in
            let rank = { (kind: CareContactKind) in kind == .emergency ? 0 : 1 }
            let byKind = rank(a.kind) - rank(b.kind)
            if byKind != 0 { return byKind }
            if a.createdAt != b.createdAt { return a.createdAt < b.createdAt ? -1 : 1 }
            return 0
        }
    }

    static let nameLimit = 80
    static let relationshipLimit = 60
    static let phoneLimit = 30

    enum DraftField: String, Sendable, Hashable { case name, relationship, phone }

    struct ContactDraft: Sendable, Hashable {
        var name = ""
        var relationship = ""
        var phone = ""
        var kind: CareContactKind = .emergency
    }

    enum DraftCheck: Sendable, Hashable {
        case ok(NewCareContact)
        case invalid(DraftField, String)
    }

    /// checks a typed contact before it is sent; the server checks again
    static func check(_ draft: ContactDraft) -> DraftCheck {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines).replacing(/\s+/, with: " ")
        let relationship = draft.relationship.trimmingCharacters(in: .whitespacesAndNewlines).replacing(/\s+/, with: " ")
        let phone = draft.phone.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return .invalid(.name, "Add their name.") }
        if name.count > nameLimit { return .invalid(.name, "Shorten the name to \(nameLimit) characters or fewer.") }
        if relationship.count > relationshipLimit {
            return .invalid(.relationship, "Shorten the relationship to \(relationshipLimit) characters or fewer.")
        }
        if phone.isEmpty { return .invalid(.phone, "Add a phone number.") }
        if phone.count > phoneLimit || telURL(phone) == nil {
            return .invalid(.phone, "Use digits only, for example 403-555-0142.")
        }
        return .ok(NewCareContact(name: name, relationship: relationship.isEmpty ? nil : relationship, phone: phone, kind: draft.kind))
    }

    /// who answered, said honestly; demo keyword rules are never called ai. nil when no model ran
    static func answeredByLabel(_ answeredBy: AnsweredBy) -> String? {
        switch answeredBy {
        case .none, .unrecognized: nil
        case .demoRules: "Answered by demo rules (offline), exact facts only"
        case .anthropic: "Answered by Claude from approved facts only"
        case .bedrock: "Answered by Claude on Bedrock from approved facts only"
        case .gemini: "Answered by Gemini from approved facts only"
        }
    }

    /// "Looked through 6 approved facts, matched by words"; nil when nothing was searched
    static func retrievalLine(_ retrieval: AskRetrieval) -> String? {
        if retrieval.method == .none || retrieval.method == .unrecognized { return nil }
        if retrieval.considered == 0 { return "No approved facts to look through yet" }
        let count = "\(retrieval.considered) approved \(retrieval.considered == 1 ? "fact" : "facts")"
        return retrieval.method == .keywordVector
            ? "Looked through \(count), matched by words and meaning"
            : "Looked through \(count), matched by words"
    }

    static func sourcePhrase(_ kind: String?) -> String? {
        switch kind {
        case "voice": "a voice note"
        case "document": "a PDF document"
        case "note": "a typed note"
        default: nil
        }
    }

    /// the redirect sentence for a medical question
    static func redirectText(_ result: AskResponse) -> String {
        if let notice = result.healthNotice?.trimmingCharacters(in: .whitespacesAndNewlines), !notice.isEmpty { return notice }
        if let answer = result.answer?.trimmingCharacters(in: .whitespacesAndNewlines), !answer.isEmpty, answer != "Not in profile" {
            return answer
        }
        return "ReliefReady can\u{2019}t answer health questions. For health advice, call Health Link at 811. In an emergency, call 911."
    }

    /// the open questions, each listed once however many times it was asked
    static func uniqueQuestions(_ items: [OpenQuestion]) -> [OpenQuestion] {
        var seen = Set<String>()
        return items.filter { item in
            let key = item.question.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacing(/[\s?.!]+$/, with: "")
            guard !seen.contains(key) else { return false }
            seen.insert(key)
            return true
        }
    }

    /// "From a voice note, Nov 8", from the citation first and the loaded fact second
    static func citationFromLine(_ cited: CitedFact, fact: CareFact?) -> String {
        let kind = sourcePhrase(cited.sourceKind ?? fact?.sourceKind)
        let day = CareData.addedDay(cited.sourceCreatedAt ?? fact?.sourceCreatedAt ?? fact?.createdAt)
        switch (kind, day) {
        case let (kind?, day?): return "From \(kind), \(day)"
        case let (kind?, nil): return "From \(kind)"
        case let (nil, day?): return "Added \(day)"
        default: return "Source not recorded"
        }
    }
}
