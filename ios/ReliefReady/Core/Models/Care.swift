import Foundation

// the care passport, timeline, ask and contacts (live-api.ts)

nonisolated enum FactStatus: String, TolerantEnum {
    case suggested, approved, superseded, conflicting, rejected, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated struct CareEvent: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var title: String
    var startsAt: String?
    var rrule: String?
    var remindMinutes: Double?
    var locationText: String?
    var status: String
}

nonisolated struct CareFact: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var category: String
    var textExact: String
    var status: FactStatus
    var sourceId: String?
    var sourceKind: String?
    var spanStart: Double?
    var spanEnd: Double?
    var conflictsWith: [String]
    var events: [CareEvent]
    var createdAt: String
    /// 1 for an original fact; an edit creates a new approved version
    var version: Int
    /// the previous version for an edited fact, or the conflict partner while conflicting
    var supersedes: String?
    /// who provided the source, e.g. "caregiver"
    var sourceAuthor: String?
    var sourceCreatedAt: String?
    /// optional short label; the ui falls back to textExact
    var displayText: String?

    init(
        id: String, category: String, textExact: String, status: FactStatus, sourceId: String?, sourceKind: String?,
        spanStart: Double?, spanEnd: Double?, conflictsWith: [String], events: [CareEvent], createdAt: String,
        version: Int = 1, supersedes: String? = nil, sourceAuthor: String? = nil, sourceCreatedAt: String? = nil,
        displayText: String? = nil
    ) {
        self.id = id
        self.category = category
        self.textExact = textExact
        self.status = status
        self.sourceId = sourceId
        self.sourceKind = sourceKind
        self.spanStart = spanStart
        self.spanEnd = spanEnd
        self.conflictsWith = conflictsWith
        self.events = events
        self.createdAt = createdAt
        self.version = version
        self.supersedes = supersedes
        self.sourceAuthor = sourceAuthor
        self.sourceCreatedAt = sourceCreatedAt
        self.displayText = displayText
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        category = try c.decode(String.self, forKey: .category)
        textExact = try c.decode(String.self, forKey: .textExact)
        status = try c.decode(FactStatus.self, forKey: .status)
        sourceId = try c.decodeIfPresent(String.self, forKey: .sourceId)
        sourceKind = try c.decodeIfPresent(String.self, forKey: .sourceKind)
        spanStart = try c.decodeIfPresent(Double.self, forKey: .spanStart)
        spanEnd = try c.decodeIfPresent(Double.self, forKey: .spanEnd)
        conflictsWith = try c.decode([String].self, forKey: .conflictsWith)
        events = try c.decode([CareEvent].self, forKey: .events)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        supersedes = try c.decodeIfPresent(String.self, forKey: .supersedes)
        sourceAuthor = try c.decodeIfPresent(String.self, forKey: .sourceAuthor)
        sourceCreatedAt = try c.decodeIfPresent(String.self, forKey: .sourceCreatedAt)
        displayText = try c.decodeIfPresent(String.self, forKey: .displayText)
    }
}

// GET /api/care/facts
nonisolated struct CareProfile: Codable, Sendable, Hashable {
    var careRecipient: CareProfileRecipient
    var facts: [CareFact]
    var openQuestions: [OpenQuestion]
}

nonisolated struct CareProfileRecipient: Codable, Sendable, Hashable {
    var id: String
    var alias: String
    var displayName: String?
}

nonisolated struct OpenQuestion: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var question: String
    var askedBy: String?
}

/// the kind of a typed care source
nonisolated enum CareTextKind: String, TolerantEnum {
    case note, voice, unrecognized
    static var fallback: Self { .unrecognized }
    /// only what the server accepts, so a picker never offers the fallback
    static let allCases: [CareTextKind] = [.note, .voice]
}

// POST /api/care/sources
nonisolated struct CareSourceResult: Codable, Sendable, Hashable {
    var source: CareSourceRef
    var facts: [CareFact]
    var conflicts: [FactConflict]
    var droppedCount: Double
}

nonisolated struct CareSourceRef: Codable, Sendable, Hashable {
    var id: String
    var kind: String
}

nonisolated struct FactConflict: Codable, Sendable, Hashable {
    var factId: String
    var existingFactId: String
    var modelNote: String?
}

// GET /api/care/sources/[id]
nonisolated struct CareSourceDetail: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var kind: String
    var author: String
    var createdAt: String
    /// the retained source text; plain text only
    var fullText: String
}

/// {fact} from approve and reject
nonisolated struct FactEnvelope: Codable, Sendable, Hashable {
    var fact: CareFact
}

// POST /api/care/facts/[id]/edit
nonisolated struct FactEditResult: Codable, Sendable, Hashable {
    var fact: CareFact
    var previous: CareFact?
}

// POST /api/care/conflicts/resolve
nonisolated struct ConflictResolution: Codable, Sendable, Hashable {
    var kept: CareFact?
    var superseded: [CareFact]
}

nonisolated struct TimelineItem: Codable, Sendable, Hashable {
    var eventId: String
    var factId: String?
    var title: String
    var startsAt: String
    var localTime: String
    var rrule: String?
    var remindMinutes: Double
    var locationText: String?
    var fullText: String?
    var category: String?
    var highlight: Bool
    /// set only when the caregiver tapped "Done" for this occurrence
    var completedAt: String?
}

// GET /api/care/timeline?date=
nonisolated struct CareTimeline: Codable, Sendable, Hashable {
    var date: String
    var appNow: String
    var reminders: [TimelineItem]
    var items: [TimelineItem]
}

// POST /api/care/events/[id]/complete
nonisolated struct EventCompletion: Codable, Sendable, Hashable {
    var eventId: String
    var date: String
    var completedAt: String?
}

nonisolated struct CitedFact: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var category: String
    var textExact: String
    var sourceId: String?
    var sourceKind: String?
    var sourceCreatedAt: String?
    var version: Int

    init(
        id: String, category: String, textExact: String, sourceId: String? = nil, sourceKind: String? = nil,
        sourceCreatedAt: String? = nil, version: Int = 1
    ) {
        self.id = id
        self.category = category
        self.textExact = textExact
        self.sourceId = sourceId
        self.sourceKind = sourceKind
        self.sourceCreatedAt = sourceCreatedAt
        self.version = version
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        category = try c.decode(String.self, forKey: .category)
        textExact = try c.decode(String.self, forKey: .textExact)
        sourceId = try c.decodeIfPresent(String.self, forKey: .sourceId)
        sourceKind = try c.decodeIfPresent(String.self, forKey: .sourceKind)
        sourceCreatedAt = try c.decodeIfPresent(String.self, forKey: .sourceCreatedAt)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
    }
}

nonisolated enum AnsweredBy: String, TolerantEnum {
    case demoRules = "demo_rules"
    case anthropic, bedrock, gemini, none, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum AskRetrievalMethod: String, TolerantEnum {
    case keyword
    case keywordVector = "keyword+vector"
    case none
    case unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated struct AskRetrieval: Codable, Sendable, Hashable {
    var method: AskRetrievalMethod
    /// approved current facts sent as context
    var considered: Int

    static let none = AskRetrieval(method: .none, considered: 0)
}

// POST /api/care/ask
nonisolated struct AskResponse: Codable, Sendable, Hashable {
    var notFound: Bool
    var answer: String?
    var citedFacts: [CitedFact]
    var createOpenQuestion: Bool
    var healthNotice: String?
    var openQuestionId: String?
    /// "demo_rules" is the offline keyword provider and must be labelled as such
    var answeredBy: AnsweredBy
    /// a non-diagnostic 811/911 pointer instead of an answer
    var medicalRedirect: Bool
    /// the only matching notes disagree: settle the conflict first
    var conflictPending: Bool
    var retrieval: AskRetrieval

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notFound = try c.decode(Bool.self, forKey: .notFound)
        answer = try c.decodeIfPresent(String.self, forKey: .answer)
        citedFacts = try c.decode([CitedFact].self, forKey: .citedFacts)
        createOpenQuestion = try c.decode(Bool.self, forKey: .createOpenQuestion)
        healthNotice = try c.decodeIfPresent(String.self, forKey: .healthNotice)
        openQuestionId = try c.decodeIfPresent(String.self, forKey: .openQuestionId)
        answeredBy = try c.decodeIfPresent(AnsweredBy.self, forKey: .answeredBy) ?? .none
        medicalRedirect = try c.decodeIfPresent(Bool.self, forKey: .medicalRedirect) ?? false
        conflictPending = try c.decodeIfPresent(Bool.self, forKey: .conflictPending) ?? false
        retrieval = try c.decodeIfPresent(AskRetrieval.self, forKey: .retrieval) ?? .none
    }

    init(
        notFound: Bool, answer: String?, citedFacts: [CitedFact], createOpenQuestion: Bool, healthNotice: String?,
        openQuestionId: String?, answeredBy: AnsweredBy = .none, medicalRedirect: Bool = false,
        conflictPending: Bool = false, retrieval: AskRetrieval = .none
    ) {
        self.notFound = notFound
        self.answer = answer
        self.citedFacts = citedFacts
        self.createOpenQuestion = createOpenQuestion
        self.healthNotice = healthNotice
        self.openQuestionId = openQuestionId
        self.answeredBy = answeredBy
        self.medicalRedirect = medicalRedirect
        self.conflictPending = conflictPending
        self.retrieval = retrieval
    }
}

nonisolated enum CareContactKind: String, TolerantEnum {
    /// call first in an emergency after 911
    case emergency
    /// can help or take a shift
    case trusted
    case unrecognized
    static var fallback: Self { .unrecognized }
    /// only what the server accepts, so a picker never offers the fallback
    static let allCases: [CareContactKind] = [.emergency, .trusted]
}

nonisolated struct CareContact: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var relationship: String?
    var phone: String
    var kind: CareContactKind
    var createdAt: String
}

// GET /api/care/contacts
nonisolated struct CareContactList: Codable, Sendable, Hashable {
    var contacts: [CareContact]
}

// POST /api/care/contacts
nonisolated struct CareContactEnvelope: Codable, Sendable, Hashable {
    var contact: CareContact
}

/// the body of POST /api/care/contacts
nonisolated struct NewCareContact: Sendable, Hashable {
    var name: String
    /// nil leaves it out; a new contact has no stored value to clear, so null is never needed
    var relationship: String?
    var phone: String
    var kind: CareContactKind

    init(name: String, relationship: String? = nil, phone: String, kind: CareContactKind) {
        self.name = name
        self.relationship = relationship
        self.phone = phone
        self.kind = kind
    }
}

// POST /api/care/contacts/[id]/remove
nonisolated struct RemovedResponse: Codable, Sendable, Hashable {
    var removed: Bool
}
