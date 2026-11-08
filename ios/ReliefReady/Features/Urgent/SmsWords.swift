import Foundation

// plain words for a text's delivery (components/app/urgent/smsWords.ts) and the phone helpers (lib/sms/phone.ts)

nonisolated enum SmsWords {
    static func deliveryLabel(_ delivery: SmsDelivery) -> String {
        switch delivery {
        case .notSent: "Not sent yet"
        case .needsReview: "Held for review"
        case .sending: "Sending"
        case .unconfirmed: "Not confirmed"
        case .submitted: "Submitted"
        case .sent: "Sent to carrier"
        case .delivered: "Delivered"
        case .failed: "Failed"
        case .simulated: "Simulated \u{00B7} not delivered"
        case .unrecognized: "Unknown"
        }
    }

    static func deliveryTone(_ delivery: SmsDelivery) -> StateTone {
        switch delivery {
        case .notSent, .unrecognized: .plain
        case .needsReview, .unconfirmed, .simulated: .warn
        case .sending, .submitted, .sent: .ask
        case .delivered: .good
        case .failed: .bad
        }
    }

    /// one line under the text: what the status means, in the owner's terms
    static func deliveryNote(_ text: SmsView) -> String {
        switch text.delivery {
        case .submitted: "Twilio accepted it and is passing it to the phone carrier."
        case .sent: "The phone carrier has it. Waiting for the carrier to confirm delivery."
        case .delivered: "The carrier confirmed it reached the phone."
        case .failed: failureNote(text.errorCode)
        case .unconfirmed:
            "Twilio didn\u{2019}t answer, so it may or may not have gone out. Check with them before sending another."
        case .simulated: "Demo text outbox only. Nothing was sent to a phone."
        case .needsReview: "It changed after you approved it, so it was held back. Nothing was sent."
        case .sending: "Handing it to Twilio now."
        default: "Approved, not sent yet."
        }
    }

    private static let knownErrors: [String: String] = [
        "twilio_21211": "Twilio says the number isn\u{2019}t a valid phone number.",
        "twilio_21608": "A Twilio trial account can only text numbers verified in the Twilio console.",
        "twilio_572002":
            "On a Twilio trial, texts must come from the trial number Twilio assigned to this verified recipient. Set TWILIO_PHONE_NUMBER to it.",
        "twilio_21610": "This number replied STOP to the app\u{2019}s number, so Twilio won\u{2019}t text it.",
        "twilio_21614": "Twilio says this number can\u{2019}t receive texts.",
        "twilio_20003": "Twilio rejected the app\u{2019}s credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
        "twilio_30003": "The phone was unreachable (off or out of coverage).",
        "twilio_30006": "The number is a landline or can\u{2019}t receive texts.",
        "twilio_30007": "The carrier filtered the message.",
    ]

    static func failureNote(_ code: String?) -> String {
        guard let code else { return "It didn\u{2019}t go out." }
        if let known = knownErrors[code] { return known }
        let shown = code.hasPrefix("twilio_") ? "Twilio error " + code.dropFirst(7) : code
        return "It didn\u{2019}t go out (\(shown))."
    }

    /// the time that matters for each status
    static func deliveryTime(_ text: SmsView) -> (word: String, at: String)? {
        if text.delivery == .delivered, let at = text.statusAt { return ("Delivered", at) }
        if text.delivery == .failed, let at = text.statusAt { return ("Updated", at) }
        if let at = text.submittedAt { return (text.delivery == .simulated ? "Saved" : "Submitted", at) }
        if let at = text.approvedAt { return ("Approved", at) }
        return nil
    }

    static let flagNotes: [String: String] = [
        "url": "It has a link. Some carriers filter texts with links.",
        "email": "It has an email address in it.",
        "phone": "It has a phone number in it. Check it\u{2019}s the one you mean.",
        "long": "It\u{2019}s longer than two texts. Shorter reads better on a phone.",
    ]

    /// the sheet's own wording for a failed text call
    static func problem(_ error: APIError) -> String {
        switch error.code {
        case "invalid_phone": return "Enter a 10-digit North American number, for example 403 555 0123."
        case "demo_number_not_configured":
            return "The test phone isn\u{2019}t set up. Add DEMO_SMS_TO to the server settings, or type a number."
        case "rate_limited": return "That\u{2019}s the most texts for this hour. Try again later."
        case "verified_owner_required": return "Real texts need a verified sign-in on this address."
        case "edit_needed": return "The text has formatting that can\u{2019}t go in a text. Edit it and approve again."
        case "not_configured": return "Texting isn\u{2019}t set up on the server. Nothing was sent."
        case "model_unavailable", "model_needs_review":
            return "The draft couldn\u{2019}t be written just now. Write it yourself, or try again."
        default: break
        }
        if error.status == 409 { return "This text already went, or changed. Its status is in the list." }
        return error.userMessage
    }

    // MARK: - phone numbers (north american +1 only)

    /// "+14035550123" from "403-555-0123", "(403) 555 0123", "1 403 555 0123" or "+1 403 555 0123"; nil when not +1
    static func normalizePhone(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.count > 32 { return nil }
        if trimmed.range(of: #"[^\d\s().+-]"#, options: .regularExpression) != nil { return nil }
        let digits = trimmed.filter(\.isASCII).filter(\.isNumber)
        let isElevenWithOne = digits.count == 11 && digits.hasPrefix("1")
        let national = isElevenWithOne ? String(digits.dropFirst()) : String(digits)
        if trimmed.hasPrefix("+") && !isElevenWithOne { return nil }
        // nanp: area code and exchange both start 2 to 9
        guard national.wholeMatch(of: /[2-9]\d{2}[2-9]\d{6}/) != nil else { return nil }
        return "+1\(national)"
    }

    /// "(403) 555-0123" for an e.164 +1 number; any other value is returned unchanged
    static func formatPhone(_ e164: String) -> String {
        guard let m = e164.wholeMatch(of: /\+1(\d{3})(\d{3})(\d{4})/) else { return e164 }
        return "(\(m.output.1)) \(m.output.2)-\(m.output.3)"
    }

    private static let gsm7: Set<Character> = {
        var set = Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~]|€")
        for scalar in UnicodeScalar("0").value...UnicodeScalar("9").value { set.insert(Character(UnicodeScalar(scalar)!)) }
        for scalar in UnicodeScalar("A").value...UnicodeScalar("Z").value { set.insert(Character(UnicodeScalar(scalar)!)) }
        for scalar in UnicodeScalar("a").value...UnicodeScalar("z").value { set.insert(Character(UnicodeScalar(scalar)!)) }
        return set
    }()

    /// gsm-7 texts split into 153-character parts after 160, anything else into 67-character parts after 70
    static func smsParts(_ text: String) -> (unicode: Bool, parts: Int, chars: Int) {
        let chars = text.unicodeScalars.count
        let isGSM = text.allSatisfy { gsm7.contains($0) }
        let (single, multi) = isGSM ? (160, 153) : (70, 67)
        let parts = chars == 0 ? 0 : chars <= single ? 1 : Int((Double(chars) / Double(multi)).rounded(.up))
        return (!isGSM, parts, chars)
    }
}
