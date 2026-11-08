import Foundation

// ports of the web's plain-language helpers (live-api.ts, passport.ts, components/app/ui.tsx)

nonisolated enum StateTone: String, Sendable, Hashable, CaseIterable {
    case good, warn, bad, ask, plain
}

nonisolated enum ModeLabelKey: String, Sendable, Hashable {
    case ai, mail, calendar, speech, retrieval, db, auth, sms
}

nonisolated struct ModeLabel: Sendable, Hashable, Identifiable {
    var key: ModeLabelKey
    var name: String
    var value: String
    var id: ModeLabelKey { key }
}

nonisolated enum Labels {
    /// categoryLabel
    static func category(_ category: String?) -> String {
        guard let category, !category.isEmpty else { return "appointment" }
        if category == "medical_instruction" { return "medical instruction as written" }
        if category == "practical" { return "practical needs and belongings" }
        return category.replacingOccurrences(of: "_", with: " ")
    }

    /// sourceLabel
    static func source(_ kind: String?) -> String {
        switch kind {
        case "voice": "Voice note"
        case "document": "PDF document"
        case "note": "Typed note"
        default: "Unknown source"
        }
    }

    private static let dayNames: [String: String] = [
        "MO": "Monday", "TU": "Tuesday", "WE": "Wednesday", "TH": "Thursday", "FR": "Friday", "SA": "Saturday",
        "SU": "Sunday",
    ]

    /// rruleLabel: a short plain description of the rrule subset the care extractor produces
    static func rrule(_ rrule: String?) -> String {
        guard let rrule, !rrule.isEmpty else { return "Once" }
        var text = rrule
        if text.uppercased().hasPrefix("RRULE:") { text = String(text.dropFirst(6)) }
        var parts: [String: String] = [:]
        for part in text.split(separator: ";", omittingEmptySubsequences: false) {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            parts[String(pair[0])] = pair.count > 1 ? String(pair[1]) : ""
        }
        let interval = parts["INTERVAL"].flatMap { Double($0) } ?? 1
        let days = (parts["BYDAY"] ?? "")
            .split(separator: ",", omittingEmptySubsequences: false)
            .compactMap { dayNames[$0.trimmingCharacters(in: .whitespaces).uppercased()] }
        let count = interval.rounded() == interval ? String(Int(interval)) : String(interval)
        switch parts["FREQ"]?.uppercased() {
        case "DAILY":
            return interval > 1 ? "Every \(count) days" : "Every day"
        case "WEEKLY":
            let list = days.count > 1
                ? "\(days.dropLast().joined(separator: ", ")) and \(days[days.count - 1])"
                : (days.first ?? "")
            let on = list.isEmpty ? "" : " on \(list)"
            return interval > 1 ? "Every \(count) weeks\(on)" : "Every week\(on)"
        default:
            return "Repeats"
        }
    }

    /// modeLabels: what actually runs behind each feature, built only from the session's mode words
    static func modes(_ mode: SessionMode, providers: Providers = .defaults) -> [ModeLabel] {
        let ai = ["demo": "Demo rules (offline)", "anthropic": "Claude", "bedrock": "Claude on Bedrock", "gemini": "Gemini"]
        let mail = ["outbox": "Demo outbox", "gmail": "Gmail"]
        let calendar = ["seed": "Seeded demo calendar", "google": "Google"]
        let speech = ["elevenlabs": "ElevenLabs Scribe", "off": "Off"]
        let retrieval = ["keyword": "Keyword", "vector": "Keyword + vectors"]
        let db = ["pglite": "Local PGlite", "supabase": "Supabase"]
        let sms = ["twilio": "Twilio", "demo": "Demo text outbox (simulated)"]
        let auth = ["demo": "Demo (fictional Alex)", "google": "Google"]
        // an unrecognised mode word is shown as it is
        var labels = [
            ModeLabel(key: .ai, name: "AI", value: ai[mode.ai] ?? mode.ai),
            ModeLabel(key: .mail, name: "Mail", value: mail[mode.mail] ?? mode.mail),
            ModeLabel(key: .calendar, name: "Calendar", value: calendar[mode.calendar] ?? mode.calendar),
            ModeLabel(key: .speech, name: "Speech", value: speech[providers.speech.rawValue] ?? providers.speech.rawValue),
            ModeLabel(
                key: .retrieval, name: "Ask retrieval",
                value: retrieval[providers.retrieval.rawValue] ?? providers.retrieval.rawValue
            ),
            ModeLabel(key: .db, name: "DB", value: db[mode.db] ?? mode.db),
            ModeLabel(key: .auth, name: "Sign-in", value: auth[mode.auth] ?? mode.auth),
        ]
        if let word = mode.sms, !word.isEmpty {
            labels.append(ModeLabel(key: .sms, name: "Texts", value: sms[word] ?? word))
        }
        return labels
    }

    /// decisionLabels in live-api.ts
    static func decision(_ decision: Decision) -> String {
        switch decision {
        case .notify: "Notify"
        case .reschedule: "Request reschedule"
        case .extension: "Request extension"
        case .coverage: "Ask for coverage"
        case .defer: "Defer"
        case .keep: "Keep"
        case .unrecognized: "Other"
        }
    }

    /// DECISION_LABEL in ui.tsx: the friendlier choice wording
    static func decisionChoice(_ decision: Decision) -> String {
        switch decision {
        case .notify: "Let them know"
        case .reschedule: "Ask to move it"
        case .extension: "Ask for more time"
        case .coverage: "Find someone to cover"
        case .defer: "Decide later"
        case .keep: "Keep it"
        case .unrecognized: "Something else"
        }
    }

    /// STATE_LABEL in ui.tsx
    static func state(_ state: RequestState) -> String {
        switch state {
        case .draft: "Draft"
        case .awaitingApproval: "Needs your OK"
        case .approved: "Approved"
        case .sending: "Sending"
        case .requested: "Waiting for a reply"
        case .accepted: "Said yes"
        case .completed: "Done"
        case .cancelled: "Cancelled"
        case .failed: "Didn\u{2019}t send"
        case .rejected: "Said no"
        case .expired: "No reply in time"
        case .needsReview: "Check the reply"
        case .unrecognized: "Unknown"
        }
    }

    /// stateTone in ui.tsx
    static func tone(_ state: RequestState) -> StateTone {
        switch state {
        case .accepted, .completed: .good
        case .failed: .bad
        case .needsReview, .rejected, .expired: .warn
        case .awaitingApproval: .ask
        default: .plain
        }
    }

    /// safeHref: only http and https links become tappable
    static func safeURL(_ text: String?) -> URL? {
        guard let text, !text.isEmpty,
            let url = URL(string: text) ?? URL(string: text.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? ""),
            let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host() != nil
        else { return nil }
        return url
    }

    private static let honorifics: Set<String> = ["dr", "mr", "mrs", "ms", "prof"]

    /// initials in ui.tsx: first and last word, honorifics skipped
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace).map(String.init).filter { word in
            var bare = word.lowercased()
            if bare.hasSuffix(".") { bare.removeLast() }
            return !honorifics.contains(bare)
        }
        guard let first = words.first?.first else { return "?" }
        if words.count == 1 { return String(first).uppercased() }
        return (String(first) + String(words[words.count - 1].first!)).uppercased()
    }

    /// toneFor in ui.tsx: a stable index into the six avatar colours
    static func avatarToneIndex(_ name: String, count: Int = 6) -> Int {
        var hash: UInt32 = 0
        for scalar in name.unicodeScalars {
            let unit = UInt32(String(scalar).utf16.first ?? 0)
            hash = hash &* 31 &+ unit
        }
        return Int(hash % UInt32(count))
    }
}

// ---- alberta time: utc-6 all year in this app, matching the server (PRD section 14)

nonisolated enum AlbertaTime {
    static let timeZone = TimeZone(secondsFromGMT: -21600)!

    enum Style: Sendable {
        /// "Sun, Nov 8, 2:13 a.m."
        case full
        /// "Sun, Nov 8"
        case day
        /// "2:13 a.m."
        case time
    }

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let longWeekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    /// an iso timestamp with Z or an offset, with or without fractional seconds
    static func parse(_ iso: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso))
            ?? (try? Date.ISO8601FormatStyle().parse(iso))
    }

    /// formatAlberta for an iso string; nil or unparseable is "No time set"
    static func format(_ iso: String?, style: Style = .full) -> String {
        guard let iso, let date = parse(iso) else { return "No time set" }
        return format(date, style: style)
    }

    /// formatAlberta for a date
    static func format(_ date: Date, style: Style = .full) -> String {
        let parts = calendar.dateComponents([.weekday, .month, .day, .hour, .minute], from: date)
        let day = "\(weekdays[(parts.weekday ?? 1) - 1]), \(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1)"
        let hour24 = parts.hour ?? 0
        let hour = hour24 % 12 == 0 ? 12 : hour24 % 12
        let minute = String(format: "%02d", parts.minute ?? 0)
        let time = "\(hour):\(minute) \(hour24 < 12 ? "a.m." : "p.m.")"
        switch style {
        case .full: return "\(day), \(time)"
        case .day: return day
        case .time: return time
        }
    }

    /// albertaDateOf: the YYYY-MM-DD alberta calendar day of an instant
    static func dateString(of date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// noon utc on a YYYY-MM-DD day, which keeps it on its own calendar day
    private static func noon(_ ymd: String) -> Date? {
        guard ymd.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil else { return nil }
        let pieces = ymd.split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3 else { return nil }
        let components = DateComponents(year: pieces[0], month: pieces[1], day: pieces[2], hour: 12)
        guard let date = utcCalendar.date(from: components) else { return nil }
        // reject rollovers such as 2026-02-31
        let back = utcCalendar.dateComponents([.year, .month, .day], from: date)
        guard back.year == pieces[0], back.month == pieces[1], back.day == pieces[2] else { return nil }
        return date
    }

    /// addDaysTo for YYYY-MM-DD
    static func addDays(_ ymd: String, _ days: Int) -> String? {
        guard let date = noon(ymd) else { return nil }
        let moved = date.addingTimeInterval(TimeInterval(days) * 86400)
        let parts = utcCalendar.dateComponents([.year, .month, .day], from: moved)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private static func utcParts(_ ymd: String) -> DateComponents? {
        noon(ymd).map { utcCalendar.dateComponents([.weekday, .month, .day], from: $0) }
    }

    /// formatDate: "Nov 10" for a YYYY-MM-DD date
    static func shortDate(_ ymd: String) -> String {
        guard let parts = utcParts(ymd) else { return "Confirm dates" }
        return "\(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1)"
    }

    /// weekRange in ui.tsx: "Nov 8 to 14", or "Nov 28 to Dec 3" across months
    static func weekRange(_ startsOn: String, _ endsOn: String) -> String {
        guard let a = utcParts(startsOn), let b = utcParts(endsOn) else { return "dates to confirm" }
        let am = months[(a.month ?? 1) - 1]
        let bm = months[(b.month ?? 1) - 1]
        return am == bm ? "\(am) \(a.day ?? 1) to \(b.day ?? 1)" : "\(am) \(a.day ?? 1) to \(bm) \(b.day ?? 1)"
    }

    /// dayLabel in ui.tsx: "Sunday, Nov 8", or "Sun, Nov 8" when short
    static func dayLabel(_ ymd: String, short: Bool = false) -> String {
        guard let parts = utcParts(ymd) else { return "a date to confirm" }
        let index = (parts.weekday ?? 1) - 1
        let weekday = short ? weekdays[index] : longWeekdays[index]
        return "\(weekday), \(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1)"
    }
}

// ---- care passport sections (passport.ts)

nonisolated enum PassportSectionID: String, Sendable, Hashable, CaseIterable {
    case routine, communication, preferences, practical, contacts, instructions, open
}

nonisolated struct PassportSection: Sendable, Hashable, Identifiable {
    var id: PassportSectionID
    var title: String
    /// one line under the title when expanded
    var hint: String
    /// stored categories shown here when approved; "open" collects open questions, conflicts and pending items
    var categories: [String]

    static let all: [PassportSection] = [
        PassportSection(
            id: .routine, title: "Daily routine", hint: "Wake, meals, activities and bedtime, as you described them.",
            categories: ["routine"]
        ),
        PassportSection(
            id: .communication, title: "Communication & accessibility",
            hint: "Hearing, language, how to explain things, and mobility needs you provided.",
            categories: ["communication", "mobility"]
        ),
        PassportSection(
            id: .preferences, title: "Preferences & interests", hint: "Likes, dislikes, comfort and company.",
            categories: ["preference"]
        ),
        PassportSection(
            id: .practical, title: "Practical needs & belongings", hint: "Where things are and how the household works.",
            categories: ["practical"]
        ),
        PassportSection(
            id: .contacts, title: "Contacts & logistics",
            hint: "People to call, appointments, pickups and who is allowed to help.",
            categories: ["contacts", "logistics"]
        ),
        PassportSection(
            id: .instructions, title: "Written care instructions",
            hint: "Exact wording from documents you added. ReliefReady never rewrites or interprets these.",
            categories: ["medical_instruction"]
        ),
        PassportSection(
            id: .open, title: "Open questions & conflicts",
            hint: "Questions nobody has answered yet, notes that disagree, and things still waiting for your check.",
            categories: []
        ),
    ]

    /// sectionOf: unknown categories fall back to practical
    static func section(of category: String) -> PassportSectionID {
        all.first { $0.categories.contains(category) }?.id ?? .practical
    }
}
