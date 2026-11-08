import Foundation

// texts (lib/frontend/sms-api.ts), speech (speech-api.ts), the demo outbox and reply links

nonisolated enum SmsDelivery: String, TolerantEnum {
    case notSent = "not_sent"
    case needsReview = "needs_review"
    case sending, unconfirmed, submitted, sent, delivered, failed, simulated, unrecognized
    static var fallback: Self { .unrecognized }

    /// texts that can still change at the provider, so a summary keeps checking (SMS_MOVING)
    static let moving: Set<SmsDelivery> = [.sending, .submitted, .sent]
}

nonisolated enum SmsProvider: String, TolerantEnum {
    case twilio, demo, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated struct SmsView: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var episodeId: String?
    var state: RequestState
    var delivery: SmsDelivery
    var recipient: SmsRecipient
    var senderName: String?
    var body: String
    var disclosureTier: DisclosureTier
    var healthTermsFound: [String]
    var healthOverride: Bool
    var provider: SmsProvider?
    var providerMessageId: String?
    var providerStatus: String?
    var errorCode: String?
    var submittedAt: String?
    var statusAt: String?
    var approvedAt: String?
    var updatedAt: String
}

nonisolated struct SmsRecipient: Codable, Sendable, Hashable {
    var label: String
    var phoneMasked: String
}

// GET /api/sms
nonisolated struct SmsList: Codable, Sendable, Hashable {
    var provider: SmsProvider
    var texts: [SmsView]
}

/// {text} from POST /api/sms; {text, handoffPhone} from /api/sms/send
nonisolated struct SmsEnvelope: Codable, Sendable, Hashable {
    var text: SmsView
    /// the full number after a demo send, so this phone's Messages can send it; nil for real (Twilio) sends
    var handoffPhone: String? = nil
}

nonisolated enum SmsRecipientKind: String, TolerantEnum {
    case demo
    case careContact = "care_contact"
    case unrecognized
    static var fallback: Self { .unrecognized }
}

// GET /api/sms/recipients
nonisolated struct SmsRecipients: Codable, Sendable, Hashable {
    var provider: SmsProvider
    var options: [SmsRecipientOption]
    var senderName: String?
}

nonisolated struct SmsRecipientOption: Codable, Sendable, Hashable {
    var kind: SmsRecipientKind
    var id: String?
    var label: String
    var detail: String?
    var phoneMasked: String
}

nonisolated enum SmsEncoding: String, TolerantEnum {
    case gsm, unicode, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated struct SmsParts: Codable, Sendable, Hashable {
    var encoding: SmsEncoding
    var parts: Double
    var chars: Double
}

// POST /api/sms/draft
nonisolated struct SmsDraft: Codable, Sendable, Hashable {
    var text: String
    var healthTermsFound: [String]
    var approvalBlocked: Bool
    var editFlags: [String]
    var parts: SmsParts
    var drafter: String
}

/// the body of POST /api/sms/draft; every key is always sent, null when empty
nonisolated struct SmsDraftInput: Sendable, Hashable {
    var episodeId: String?
    var recipientName: String?
    var senderName: String?
    var note: String?
    var tier: DisclosureTier
}

/// who a text goes to
nonisolated enum SmsRecipientChoice: Sendable, Hashable {
    case demo
    case careContact(id: String)
    case phone(String, label: String? = nil)

    var json: JSONValue {
        switch self {
        case .demo:
            return ["kind": "demo"]
        case .careContact(let id):
            return ["kind": "care_contact", "id": .string(id)]
        case .phone(let phone, let label):
            var object: [String: JSONValue] = ["kind": "phone", "phone": .string(phone)]
            if let label { object["label"] = .string(label) }
            return .object(object)
        }
    }
}

/// the body of POST /api/sms; approved:true is added by the client
nonisolated struct SmsApproveInput: Sendable, Hashable {
    /// one compose session, 16 to 64 of [A-Za-z0-9_-]; a repeated click returns the same row
    var clientKey: String
    var episodeId: String?
    var to: SmsRecipientChoice
    var senderName: String?
    var body: String
    var tier: DisclosureTier
    var healthOverride: Bool

    /// a fresh key for one compose session
    static func newClientKey() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

// POST /api/stt
nonisolated struct Transcript: Codable, Sendable, Hashable {
    var transcript: String
}

// POST /api/voice-agent/session
nonisolated struct VoiceAgentSession: Codable, Sendable, Hashable {
    var signedUrl: String
}

// GET /api/outbox
nonisolated struct Outbox: Codable, Sendable, Hashable {
    /// "outbox" when demo mail is on; messages is empty otherwise
    var mail: String
    var messages: [OutboxMessage]
}

nonisolated struct OutboxMessage: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var to: String
    var subject: String
    var body: String
    var sentAt: String

    /// the app's own reply links in the body, in order
    var responseLinks: [ResponseLink] { ResponseLink.find(in: body) }
}

/// what a reply link asks; the token fixes it on the server
nonisolated enum ResponseChoice: String, Sendable, Hashable, CaseIterable {
    case accept, decline, propose
}

/// one /r/<token> link from a demo outbox message
nonisolated struct ResponseLink: Sendable, Hashable, Identifiable {
    var url: String
    var token: String
    /// read from the line label ("Accept:", "Decline:", "Propose another time:"); nil when unlabelled
    var choice: ResponseChoice?

    var id: String { token }

    /// RESPONSE_LINK in app/outbox/page.tsx: a 43-character token after /r/
    static func find(in body: String) -> [ResponseLink] {
        let pattern = /(https?:\/\/[^\s\/]+\/r\/([A-Za-z0-9_-]{43}))(?![A-Za-z0-9_-])/
        var links: [ResponseLink] = []
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            for match in line.matches(of: pattern) {
                let label = line[..<match.range.lowerBound].lowercased()
                let choice: ResponseChoice? =
                    label.contains("accept") ? .accept
                    : label.contains("decline") ? .decline
                    : label.contains("propose") ? .propose
                    : nil
                links.append(ResponseLink(url: String(match.output.1), token: String(match.output.2), choice: choice))
            }
        }
        return links
    }
}

/// {proposal:{at, note?}} for a "propose another time" link
nonisolated struct ResponseProposal: Sendable, Hashable {
    /// iso time with seconds and an explicit offset, e.g. 2026-11-10T09:00:00-06:00
    var at: String
    var note: String?

    init(at: String, note: String? = nil) {
        self.at = at
        self.note = note
    }

    /// the proposal for a picked date, in alberta time; a blank note is left out, as the web form does
    init(at date: Date, note: String? = nil) {
        let trimmed = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.init(at: AlbertaTime.isoString(date), note: trimmed.isEmpty ? nil : trimmed)
    }
}

// POST /api/responses/[token]
nonisolated struct ResponseResult: Codable, Sendable, Hashable {
    var state: String
    /// false when the link already had an answer; state is then the first recorded one
    var recorded: Bool
}
