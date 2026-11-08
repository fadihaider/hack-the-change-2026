import Foundation

/// a failed call; mirrors RequestApiError in lib/frontend/request-api.ts
nonisolated struct APIError: Error, Sendable, Hashable {
    /// the server's {error:{code}}, or network_error, invalid_response, request_failed
    var code: String
    /// http status; 0 when the server was not reached
    var status: Int
    /// health terms for a 422 health_terms
    var terms: [String]
    /// a fixed server message (for example the guide's address hints); plain text, at most 400 characters
    var detail: String?
    /// seconds from Retry-After on a 429
    var retryAfter: TimeInterval?

    init(code: String, status: Int, terms: [String] = [], detail: String? = nil, retryAfter: TimeInterval? = nil) {
        self.code = code
        self.status = status
        self.terms = terms
        self.detail = detail
        self.retryAfter = retryAfter
    }

    static let network = APIError(code: "network_error", status: 0)

    static func invalidResponse(status: Int = 502) -> APIError {
        APIError(code: "invalid_response", status: status)
    }

    /// the {error:{code, terms?, message?}} body of a failed response
    static func from(status: Int, body: Data, retryAfter: String?) -> APIError {
        let seconds = retryAfter.flatMap(parseRetryAfter)
        guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: body) else {
            // not json at all reads as invalid_response, like the web client; json of another shape is request_failed
            let isJSON = (try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])) != nil
            return APIError(code: isJSON ? "request_failed" : "invalid_response", status: status, retryAfter: seconds)
        }
        let terms = (envelope.error.terms ?? []).filter { $0.count <= 80 }
        let detail = envelope.error.message.map { String($0.prefix(400)) }
        return APIError(code: envelope.error.code, status: status, terms: terms, detail: detail, retryAfter: seconds)
    }

    /// delta seconds, or an http date
    static func parseRetryAfter(_ value: String) -> TimeInterval? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if let seconds = TimeInterval(trimmed), seconds >= 0 { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: trimmed) else { return nil }
        return max(0, date.timeIntervalSinceNow)
    }

    private struct ErrorEnvelope: Decodable {
        struct Body: Decodable {
            var code: String
            var terms: [String]?
            var message: String?
        }
        var error: Body
    }
}

// ---- plain-language messages

nonisolated extension APIError {
    /// ERROR_TEXT in live-api.ts
    static let errorText: [String: String] = [
        "rate_limited": "Too many AI requests in a short time. Wait a few minutes, then try again.",
        "contact_required": "No contact matches this commitment yet. Choose who should receive the request.",
        "draft_empty": "The draft came back empty, so nothing was queued. Try again or choose another action.",
        "model_needs_review": "The AI result did not pass its checks, so nothing was saved. Try again or reword it.",
        "model_unavailable": "The AI provider is unavailable right now. Nothing was saved; try again shortly.",
        "no_text_layer":
            "This PDF has no text layer, so no fact can be checked word for word. Type the key lines as a note instead.",
        "unreadable_pdf": "This PDF could not be read. Try another file or type the key lines as a note.",
        "source_too_long": "This source is too long to check word for word. Split it into shorter notes.",
        "payload_too_large": "That file is too large. Upload a PDF under 10 MB.",
        "unsupported_media_type": "Only PDF files can be uploaded here.",
        "conflict_unresolved": "This fact conflicts with another one. Choose which version to keep first.",
        "state_conflict": "This item changed elsewhere. Refresh to see its recorded state.",
        "exact_wording_locked":
            "Written care instructions stay word for word. Add the corrected document or note instead.",
        "not_scheduled": "That item isn\u{2019}t on this day, so it can\u{2019}t be marked done here.",
        "forbidden": "Only an admin account can move the demo clock.",
        "care_recipient_not_found": "No care recipient is set up for this account yet.",
        "start_time_required": "This commitment has no start time, so it cannot join the care timeline.",
        "invalid_input": "Some details were not accepted. Check them and try again.",
    ]

    /// liveErrorMessage: the text for any failed live call; never shows provider or database wording
    var userMessage: String {
        if let detail, status == 422 { return detail }
        if let known = Self.errorText[code] { return known }
        return requestMessage
    }

    /// apiErrorMessage in request-api.ts: the approval queue's own wording
    var requestMessage: String {
        if code == "network_error" && status == 0 {
            return "The live service could not be reached. Refresh before taking another action."
        }
        switch status {
        case 401:
            return "A signed-in session is required. Live sign-in must be connected before you can continue."
        case 403:
            return "Your session does not have permission for this action."
        case 404, 503:
            return "The live workspace is not available yet. The demo remains available."
        case 409:
            return "This request changed elsewhere. Refresh and review its recorded state."
        case 412, 428:
            return "This approval preview is out of date. Review the refreshed message and approve it again."
        default:
            break
        }
        if code == "health_terms" {
            return "Health terms need your review. Edit the message or explicitly allow the disclosure before approving."
        }
        if code == "invalid_response" {
            return "The live service returned an unexpected response. No success is assumed; refresh to reconcile."
        }
        return "The action could not be confirmed. Refresh the recorded state before trying again."
    }

    /// homeErrorMessage in access-data.ts, for a failed home access lookup
    func homeMessage(name: String) -> String {
        switch code {
        case "no_home_area":
            return "\(name)\u{2019}s community isn\u{2019}t in the Calgary community list, so nothing can be counted from it. Check her address on the start screen."
        case "access_snapshot_unavailable":
            return "The Calgary care places list didn\u{2019}t load on the server. Try again in a moment."
        case "network_error":
            return "ReliefReady couldn\u{2019}t reach its server. Check your connection, then try again."
        default:
            return userMessage
        }
    }
}

// ---- speech (speech-api.ts)

nonisolated extension APIError {
    /// SPEECH_OFF_MESSAGE
    static let speechOffMessage =
        "Live transcription isn\u{2019}t set up on this server, so voice notes can\u{2019}t be turned into text here. Type the note instead."

    private static let speechUnreadable =
        "The recording couldn\u{2019}t be read. Record it again, or type the note instead."
    private static let speechTooLong =
        "That recording is too long to send. Record a shorter note, or type it instead."
    private static let speechNoTranscript =
        "The speech service didn\u{2019}t send back a transcript. Nothing was saved. Try again, or type the note instead."

    static let speechErrorText: [String: String] = [
        "speech_not_configured": speechOffMessage,
        "not_configured": speechOffMessage,
        "speech_off": speechOffMessage,
        "speech_access_denied":
            "The speech service didn\u{2019}t accept this server\u{2019}s key, so nothing was transcribed. Type the note instead.",
        "rate_limited": "Too many recordings in a short time. Wait a few minutes and try again, or type the note instead.",
        "speech_rate_limited": "The speech service is busy. Wait a few minutes and try again, or type the note instead.",
        "invalid_audio": speechUnreadable,
        "unsupported_media_type": speechUnreadable,
        "invalid_input": speechUnreadable,
        "payload_too_large": speechTooLong,
        "audio_too_large": speechTooLong,
        "speech_cleanup_failed":
            "The speech service couldn\u{2019}t confirm it deleted its copy, so the transcript was held back. Nothing was saved. Try again, or type the note instead.",
        "speech_provider_failed": speechNoTranscript,
        "invalid_speech_response": speechNoTranscript,
        "invalid_response": speechNoTranscript,
        "unauthenticated": "Voice notes need a signed-in account on this server. Type the note instead.",
        "invalid_origin": "Open ReliefReady from its usual address to record a voice note, or type the note instead.",
        "network_error": "ReliefReady couldn\u{2019}t be reached. Your recording is still here, so you can try again.",
        "temporarily_unavailable":
            "Voice transcription isn\u{2019}t available right now. Nothing was saved. Try again later, or type the note instead.",
    ]

    /// speechErrorMessage: the text for a failed /api/stt call
    var speechMessage: String {
        if status == 404 { return Self.speechOffMessage }
        if let known = Self.speechErrorText[code] { return known }
        switch status {
        case 401: return Self.speechErrorText["unauthenticated"]!
        case 403: return Self.speechErrorText["invalid_origin"]!
        case 413: return Self.speechErrorText["payload_too_large"]!
        case 429: return Self.speechErrorText["rate_limited"]!
        case 503: return Self.speechErrorText["temporarily_unavailable"]!
        default:
            return "The recording couldn\u{2019}t be turned into text. Nothing was saved. Try again, or type the note instead."
        }
    }

    /// isSpeechUnavailable: trying again here cannot work, so only typing is offered
    var isSpeechUnavailable: Bool {
        let off: Set<String> = ["speech_not_configured", "not_configured", "speech_off", "speech_access_denied", "unauthenticated"]
        return off.contains(code) || status == 404 || status == 401
    }

    /// canRetrySameRecording: the same audio can be sent again
    var canRetrySameRecording: Bool {
        if isSpeechUnavailable { return false }
        let unreadable: Set<String> = ["invalid_audio", "unsupported_media_type", "invalid_input", "payload_too_large", "audio_too_large"]
        return !unreadable.contains(code) && status != 413 && status != 403
    }
}
