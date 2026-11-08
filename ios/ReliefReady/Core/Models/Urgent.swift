import Foundation

// intake, impact and decisions (live-api.ts)

// POST /api/intake
nonisolated struct IntakeResponse: Codable, Sendable, Hashable {
    var result: IntakeResult
    var episodeId: String?
}

/// a union on status
nonisolated enum IntakeResult: Codable, Sendable, Hashable {
    case ready(IntakeReady)
    case needsClarification(IntakeClarification)

    private enum CodingKeys: String, CodingKey { case status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let status = try c.decode(String.self, forKey: .status)
        switch status {
        case "ready": self = .ready(try IntakeReady(from: decoder))
        case "needs_clarification": self = .needsClarification(try IntakeClarification(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .status, in: c, debugDescription: "unknown status \(status)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ready(let value):
            try c.encode("ready", forKey: .status)
            try value.encode(to: encoder)
        case .needsClarification(let value):
            try c.encode("needs_clarification", forKey: .status)
            try value.encode(to: encoder)
        }
    }

    var clarifyingQuestions: [String] {
        switch self {
        case .ready(let value): value.clarifyingQuestions ?? []
        case .needsClarification(let value): value.clarifyingQuestions
        }
    }
}

nonisolated struct IntakeReady: Codable, Sendable, Hashable {
    var startDate: String
    var endDate: String
    var clarifyingQuestions: [String]?
    var recipientAlias: String?
    var reasonText: String?
    var helpRequested: [String]
}

nonisolated struct IntakeClarification: Codable, Sendable, Hashable {
    var clarifyingQuestions: [String]
    var partial: IntakePartial
}

nonisolated struct IntakePartial: Codable, Sendable, Hashable {
    var startDate: String?
    var endDate: String?
    var recipientAlias: String?
    var reasonText: String?
    var helpRequested: [String]
}

nonisolated enum Decision: String, TolerantEnum {
    case notify, reschedule, `extension`, coverage, `defer`, keep, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum ModelStatus: String, TolerantEnum {
    case ok, unavailable, unrecognized
    static var fallback: Self { .unrecognized }
}

// POST /api/impact
nonisolated struct ImpactResponse: Codable, Sendable, Hashable {
    var episode: ImpactEpisode
    var commitments: [Commitment]
    var modelStatus: ModelStatus
}

nonisolated struct ImpactEpisode: Codable, Sendable, Hashable {
    var id: String
    var startsOn: String
    var endsOn: String
}

nonisolated struct Commitment: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var sourceId: String?
    var title: String
    var startsAt: String?
    var endsAt: String?
    var location: String?
    var organizerEmail: String?
    var attendees: [Attendee]
    var conflictReason: String?
    var ruleConflicts: [String]
    var decision: Decision?
    /// "Change the plan" opened the step again on the server; the next decision clears it
    var reopened: Bool
    var suggestedAction: Decision?
    var forCareRecipient: Bool
    var dependencies: [Dependency]
    var suggestedContactId: String?
    /// every matched contact in order; a group commitment can have several
    var suggestedContactIds: [String]
    var contacts: [CommitmentContact]
    var requests: [CommitmentRequestRef]

    init(
        id: String, sourceId: String?, title: String, startsAt: String?, endsAt: String?, location: String?,
        organizerEmail: String?, attendees: [Attendee], conflictReason: String?, ruleConflicts: [String],
        decision: Decision?, reopened: Bool = false, suggestedAction: Decision?, forCareRecipient: Bool,
        dependencies: [Dependency], suggestedContactId: String?, suggestedContactIds: [String] = [],
        contacts: [CommitmentContact] = [], requests: [CommitmentRequestRef]
    ) {
        self.id = id
        self.sourceId = sourceId
        self.title = title
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.location = location
        self.organizerEmail = organizerEmail
        self.attendees = attendees
        self.conflictReason = conflictReason
        self.ruleConflicts = ruleConflicts
        self.decision = decision
        self.reopened = reopened
        self.suggestedAction = suggestedAction
        self.forCareRecipient = forCareRecipient
        self.dependencies = dependencies
        self.suggestedContactId = suggestedContactId
        self.suggestedContactIds = suggestedContactIds
        self.contacts = contacts
        self.requests = requests
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sourceId = try c.decodeIfPresent(String.self, forKey: .sourceId)
        title = try c.decode(String.self, forKey: .title)
        startsAt = try c.decodeIfPresent(String.self, forKey: .startsAt)
        endsAt = try c.decodeIfPresent(String.self, forKey: .endsAt)
        location = try c.decodeIfPresent(String.self, forKey: .location)
        organizerEmail = try c.decodeIfPresent(String.self, forKey: .organizerEmail)
        attendees = try c.decode([Attendee].self, forKey: .attendees)
        conflictReason = try c.decodeIfPresent(String.self, forKey: .conflictReason)
        ruleConflicts = try c.decode([String].self, forKey: .ruleConflicts)
        decision = try c.decodeIfPresent(Decision.self, forKey: .decision)
        reopened = try c.decodeIfPresent(Bool.self, forKey: .reopened) ?? false
        suggestedAction = try c.decodeIfPresent(Decision.self, forKey: .suggestedAction)
        forCareRecipient = try c.decode(Bool.self, forKey: .forCareRecipient)
        dependencies = try c.decode([Dependency].self, forKey: .dependencies)
        suggestedContactId = try c.decodeIfPresent(String.self, forKey: .suggestedContactId)
        suggestedContactIds = try c.decodeIfPresent([String].self, forKey: .suggestedContactIds) ?? []
        contacts = try c.decodeIfPresent([CommitmentContact].self, forKey: .contacts) ?? []
        requests = try c.decode([CommitmentRequestRef].self, forKey: .requests)
    }
}

nonisolated struct Attendee: Codable, Sendable, Hashable {
    var email: String
    var responseStatus: String?
}

nonisolated struct Dependency: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var toKind: String?
    var toRef: String?
    var evidence: String
    var origin: String
    var confirmed: Bool
    var contactId: String?
    /// the saved contact name; nil means no contact matches, so show the address as it is
    var contactName: String?
}

nonisolated struct CommitmentContact: Codable, Sendable, Hashable {
    var contactId: String
    var name: String
    var email: String
    var group: String
    var tier: DisclosureTier
}

nonisolated struct CommitmentRequestRef: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var state: String
    var contactId: String?
}

/// the body of POST /api/commitments/decide; contactId and contactIds are never sent together
nonisolated struct DecideInput: Sendable, Hashable {
    var commitmentId: String
    var decision: Decision
    var contactId: String?
    /// several people for a group commitment
    var contactIds: [String]?
    var note: String?

    init(commitmentId: String, decision: Decision, contactId: String? = nil, contactIds: [String]? = nil, note: String? = nil) {
        self.commitmentId = commitmentId
        self.decision = decision
        self.contactId = contactId
        self.contactIds = contactIds
        self.note = note
    }
}

// POST /api/commitments/decide
nonisolated struct DecideResponse: Codable, Sendable, Hashable {
    var commitment: DecidedCommitment
    /// the first of requests, for single-recipient callers
    var request: RequestView?
    var existing: Bool
    var editFlags: [String]
    var approvalBlocked: Bool
    /// one request per chosen contact, each approved and sent on its own
    var requests: [RequestView]
    var drafts: [DraftInfo]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        commitment = try c.decode(DecidedCommitment.self, forKey: .commitment)
        request = try c.decodeIfPresent(RequestView.self, forKey: .request)
        existing = try c.decode(Bool.self, forKey: .existing)
        editFlags = try c.decode([String].self, forKey: .editFlags)
        approvalBlocked = try c.decode(Bool.self, forKey: .approvalBlocked)
        requests = try c.decodeIfPresent([RequestView].self, forKey: .requests) ?? []
        drafts = try c.decodeIfPresent([DraftInfo].self, forKey: .drafts) ?? []
    }

    init(
        commitment: DecidedCommitment, request: RequestView?, existing: Bool, editFlags: [String],
        approvalBlocked: Bool, requests: [RequestView] = [], drafts: [DraftInfo] = []
    ) {
        self.commitment = commitment
        self.request = request
        self.existing = existing
        self.editFlags = editFlags
        self.approvalBlocked = approvalBlocked
        self.requests = requests
        self.drafts = drafts
    }
}

nonisolated struct DecidedCommitment: Codable, Sendable, Hashable {
    var id: String
    var decision: Decision
}

nonisolated struct DraftInfo: Codable, Sendable, Hashable {
    var requestId: String
    var existing: Bool
    var editFlags: [String]
    var approvalBlocked: Bool
}

// POST /api/commitments/reopen
nonisolated struct ReopenResponse: Codable, Sendable, Hashable {
    var commitment: ReopenedCommitment
}

nonisolated struct ReopenedCommitment: Codable, Sendable, Hashable {
    var id: String
    var decision: Decision?
    /// always true from the server
    var reopened: Bool
}

// POST /api/commitments/timeline
nonisolated struct TimelineAddResponse: Codable, Sendable, Hashable {
    var eventId: String
    var created: Bool
}

// GET /api/guide
nonisolated enum Tenure: String, TolerantEnum {
    case yes, no
    case notSure = "not_sure"
    case unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated struct GuideResponse: Codable, Sendable, Hashable {
    /// always true
    var ok: Bool
    var location: GuideLocation
    var tenure: String
    var cards: [GuideCard]
    var attribution: GuideAttribution
}

nonisolated struct GuideLocation: Codable, Sendable, Hashable {
    var address: String?
    var point: GuidePoint
    var community: String
}

nonisolated struct GuidePoint: Codable, Sendable, Hashable {
    var lat: Double
    var lng: Double
}

nonisolated struct GuideCard: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var details: [GuideDetail]
    var links: [GuideLink]
    var draftNotice: String?
    var source: String
    var sourceUrl: String
    var license: String?
    var fetchedAt: String
}

nonisolated struct GuideDetail: Codable, Sendable, Hashable {
    var label: String
    var value: String
}

nonisolated struct GuideLink: Codable, Sendable, Hashable {
    var label: String
    var url: String
}

nonisolated struct GuideAttribution: Codable, Sendable, Hashable {
    var text: String
    var url: String
}

// GET and POST /api/recover
nonisolated struct RecoverResponse: Codable, Sendable, Hashable {
    var groups: RecoverGroups
    var appNow: String
    var expiredRequestIds: [String]
}

nonisolated struct RecoverGroups: Codable, Sendable, Hashable {
    var handled: [RequestView]
    var waiting: [RequestView]
    var needsFollowUp: [RequestView]
    var notSent: [RequestView]
    var new: [RecoverNewItem]
}

nonisolated struct RecoverNewItem: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var title: String?
    var startsAt: String?
    var requestId: String?
}
