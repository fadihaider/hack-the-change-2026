import Foundation

// the approval queue (requestViewSchema and friends in lib/frontend/request-api.ts)

nonisolated enum RequestState: String, TolerantEnum {
    case draft
    case awaitingApproval = "awaiting_approval"
    case approved
    case sending
    case requested
    case accepted
    case completed
    case cancelled
    case failed
    case rejected
    case expired
    case needsReview = "needs_review"
    case unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum RequestAction: String, TolerantEnum {
    case notify, reschedule, `extension`, coverage, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum DisclosureTier: String, TolerantEnum {
    case minimal, general, detailed, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum EvidenceKind: String, TolerantEnum {
    case approval
    case gmailMessageId = "gmail_message_id"
    case linkClick = "link_click"
    case userManual = "user_manual"
    case scheduler
    case error
    case smsMessageSid = "sms_message_sid"
    case smsStatus = "sms_status"
    case unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated struct RequestView: Codable, Sendable, Hashable, Identifiable {
    var id: String
    /// 64 lowercase hex; sent back as If-Match on approve
    var revision: String
    var state: RequestState
    var action: RequestAction
    var recipient: RequestRecipient
    var subject: String
    var body: String
    var disclosureTier: DisclosureTier
    /// the contact group's usual tier; the owner may choose another one for this request
    var defaultDisclosureTier: DisclosureTier?
    var healthTermsFound: [String]
    var healthOverride: Bool
    var respondBy: String?
    var proposedAt: String?
    var proposedNote: String?
    var approval: RequestApproval?
    var evidence: [RequestEvidence]
}

nonisolated struct RequestRecipient: Codable, Sendable, Hashable {
    var contactId: String
    var name: String
    var email: String
}

nonisolated struct RequestApproval: Codable, Sendable, Hashable {
    var id: String
    var hash: String
    var at: String
}

nonisolated struct RequestEvidence: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var fromState: RequestState?
    var toState: RequestState
    var evidenceKind: EvidenceKind
    var evidenceRef: String?
    var actor: String
    var at: String
}

// GET /api/requests
nonisolated struct RequestList: Codable, Sendable, Hashable {
    var requests: [RequestView]
    var appNow: String
}

// POST /api/requests/refresh
nonisolated struct RequestRefresh: Codable, Sendable, Hashable {
    var requests: [RequestView]
    var appNow: String
    var expiredRequestIds: [String]
}

/// {request} from edit, approve and cancel; GET /api/requests/[id] also carries appNow
nonisolated struct RequestEnvelope: Codable, Sendable, Hashable {
    var request: RequestView
    var appNow: String?
}

// POST /api/requests/redraft
nonisolated struct RedraftResult: Codable, Sendable, Hashable {
    var request: RequestView
    var editFlags: [String]
    var approvalBlocked: Bool
}

/// POST /api/requests/send, a union on state
nonisolated enum SendResult: Codable, Sendable, Hashable {
    case requested(messageId: String)
    case failed(errorCode: String)
    case needsReview

    private enum CodingKeys: String, CodingKey { case state, messageId, errorCode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let state = try c.decode(String.self, forKey: .state)
        switch state {
        case "requested": self = .requested(messageId: try c.decode(String.self, forKey: .messageId))
        case "failed": self = .failed(errorCode: try c.decode(String.self, forKey: .errorCode))
        case "needs_review": self = .needsReview
        default:
            throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "unknown send state \(state)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .requested(let messageId):
            try c.encode("requested", forKey: .state)
            try c.encode(messageId, forKey: .messageId)
        case .failed(let errorCode):
            try c.encode("failed", forKey: .state)
            try c.encode(errorCode, forKey: .errorCode)
        case .needsReview:
            try c.encode("needs_review", forKey: .state)
        }
    }
}

/// the fields an edit may change; nil leaves a field out of the body
nonisolated struct RequestChanges: Sendable, Hashable {
    var subject: String?
    var body: String?
    var contactId: String?
    /// .some(nil) clears the date (sent as null); nil leaves it unchanged
    var respondBy: String??
    /// this request only; it needs a fresh approval
    var disclosureTier: DisclosureTier?

    init(
        subject: String? = nil, body: String? = nil, contactId: String? = nil,
        respondBy: String?? = nil, disclosureTier: DisclosureTier? = nil
    ) {
        self.subject = subject
        self.body = body
        self.contactId = contactId
        self.respondBy = respondBy
        self.disclosureTier = disclosureTier
    }
}
