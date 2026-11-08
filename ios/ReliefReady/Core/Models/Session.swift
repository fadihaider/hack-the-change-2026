import Foundation

// GET /api/session (sessionSchema in lib/frontend/live-api.ts)
nonisolated struct Session: Codable, Sendable, Hashable {
    var user: SessionUser
    var mode: SessionMode
    var admin: Bool
    var appNow: String
    var today: String
    var careRecipient: CareRecipientSummary?
    var episode: EpisodeSummary?
    /// defaults to speech off and keyword retrieval when an older server leaves it out
    var providers: Providers

    init(
        user: SessionUser, mode: SessionMode, admin: Bool, appNow: String, today: String,
        careRecipient: CareRecipientSummary?, episode: EpisodeSummary?, providers: Providers = .defaults
    ) {
        self.user = user
        self.mode = mode
        self.admin = admin
        self.appNow = appNow
        self.today = today
        self.careRecipient = careRecipient
        self.episode = episode
        self.providers = providers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(SessionUser.self, forKey: .user)
        mode = try c.decode(SessionMode.self, forKey: .mode)
        admin = try c.decode(Bool.self, forKey: .admin)
        appNow = try c.decode(String.self, forKey: .appNow)
        today = try c.decode(String.self, forKey: .today)
        careRecipient = try c.decodeIfPresent(CareRecipientSummary.self, forKey: .careRecipient)
        episode = try c.decodeIfPresent(EpisodeSummary.self, forKey: .episode)
        providers = try c.decodeIfPresent(Providers.self, forKey: .providers) ?? .defaults
    }
}

nonisolated struct SessionUser: Codable, Sendable, Hashable {
    var id: String
    var email: String
}

/// adapter mode words; plain text on purpose, an unknown word is shown as it is
nonisolated struct SessionMode: Codable, Sendable, Hashable {
    var db: String
    var ai: String
    var mail: String
    var calendar: String
    var auth: String
    /// twilio | demo; absent from older servers
    var sms: String?
}

nonisolated struct CareRecipientSummary: Codable, Sendable, Hashable {
    var id: String
    var alias: String
    var displayName: String?
    var address: String?
    var community: String?
}

nonisolated struct EpisodeSummary: Codable, Sendable, Hashable {
    var id: String
    var startsOn: String
    var endsOn: String
    var status: String
}

nonisolated struct Providers: Codable, Sendable, Hashable {
    var speech: SpeechProvider
    var retrieval: RetrievalProvider

    static let defaults = Providers(speech: .off, retrieval: .keyword)
}

nonisolated enum SpeechProvider: String, TolerantEnum {
    case elevenlabs, off, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum RetrievalProvider: String, TolerantEnum {
    case keyword, vector, unrecognized
    static var fallback: Self { .unrecognized }
}

// GET /api/clock, POST /api/clock/reset
nonisolated struct ClockView: Codable, Sendable, Hashable {
    var appNow: String
    var realNow: String
    var offsetMilliseconds: Double
}

// POST /api/clock/jump
nonisolated struct ClockJump: Codable, Sendable, Hashable {
    var appNow: String
    var realNow: String
    var offsetMilliseconds: Double
    var expiredRequestIds: [String]
}
