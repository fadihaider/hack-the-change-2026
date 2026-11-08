import Foundation
import Observation
import SwiftUI

/// the help list's state: the tenure answer, the address and the last GET /api/guide (HelpNearby.tsx)
@MainActor
@Observable
final class HelpNearbyModel {
    static let supportsShown = 3
    static let addressMax = 200

    let api: any UrgentAPI
    var address: String?
    var tenure: Tenure = .notSure
    /// an address typed here after a lookup problem; it belongs to the address it replaced
    var typed: (for: String?, value: String)?
    var draft: String
    var attempt = 0
    var guide: GuideResponse?
    var error: String?
    var locationProblem = false
    var loading = true
    var allSupports = false
    /// after a typed address works, the heading takes the voiceover focus
    var refocus = false
    private var spoken: String?

    init(api: any UrgentAPI, address: String?) {
        self.api = api
        self.address = address
        self.draft = address ?? ""
    }

    var query: String {
        if let typed, typed.for == address { return typed.value }
        return address ?? ""
    }

    var typedAddress: Bool {
        guard let typed, typed.for == address else { return false }
        return !typed.value.isEmpty && typed.value != (address ?? "")
    }

    var leadLine: String {
        let community = guide.map { Self.placeName($0.location.community) } ?? ""
        return community.isEmpty
            ? "Hospitals, pharmacies, transit, time off work and support, from public sources."
            : "Around \(community) in Calgary, from public sources. Each card says where it came from and when it was checked."
    }

    var tenureHint: String {
        tenure == .no
            ? "Alberta\u{2019}s job-protected family leave needs 90 days with the same employer, so it isn\u{2019}t shown. Your employer may still agree to time off."
            : "This only changes whether the job-protected leave shows. It doesn\u{2019}t decide whether you qualify."
    }

    static func tenureLabel(_ tenure: Tenure) -> String {
        switch tenure {
        case .yes: "Yes"
        case .no: "No"
        default: "Not sure"
        }
    }

    func load() async {
        loading = true
        defer { loading = false }
        do throws(APIError) {
            let next = try await api.guide(address: query, tenure: tenure)
            guard !Task.isCancelled else { return }
            guide = next
            error = nil
            locationProblem = false
            if let spoken { AccessibilityNotification.Announcement(spoken).post() }
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error.userMessage
            locationProblem = error.status == 422
            if spoken != nil { AccessibilityNotification.Announcement(error.userMessage).post() }
            refocus = false
        }
        spoken = nil
    }

    func chooseTenure(_ next: Tenure) {
        guard next != tenure else { return }
        spoken = next == .no
            ? "Updated. The family leave rule is hidden, because it needs 90 days with the same employer."
            : "Updated the help list."
        tenure = next
    }

    func lookUp() {
        spoken = "Updated the help list."
        refocus = true
        typed = (address, draft.trimmingCharacters(in: .whitespacesAndNewlines))
        attempt += 1
    }

    func retry() {
        attempt += 1
    }

    // MARK: - grouping

    struct Groups {
        var near: [GuideCard] = []
        var work: [GuideCard] = []
        var support: [GuideCard] = []
        var other: [GuideCard] = []
    }

    /// the api's order is kept inside each group
    static func group(_ cards: [GuideCard]) -> Groups {
        var groups = Groups()
        for card in cards {
            switch card.kind {
            case "hospital", "pharmacy", "transit": groups.near.append(card)
            case "leave", "ei": groups.work.append(card)
            case "support": groups.support.append(card)
            default: groups.other.append(card)
            }
        }
        return groups
    }

    /// true when a card credits openstreetmap, so the attribution line shows
    static func usesOSM(_ cards: [GuideCard]) -> Bool {
        // the web credits the close-by cards under its own map; here they are cards too, so every card counts
        cards.contains { $0.source.contains("OpenStreetMap") || $0.sourceUrl.contains("openstreetmap") }
    }

    /// "DOWNTOWN EAST VILLAGE" reads as "Downtown East Village"
    static func placeName(_ community: String) -> String {
        var out = ""
        var capitalizeNext = true
        for character in community.lowercased() {
            if capitalizeNext, character.isLetter {
                out.append(contentsOf: character.uppercased())
            } else {
                out.append(character)
            }
            capitalizeNext = character.isWhitespace || character == "/" || character == "-"
        }
        return out.replacing(/\b(Ne|Nw|Se|Sw)\b/) { $0.output.0.uppercased() }
    }

    /// "Nov 7, 2026" for the date part of a fetched-at value; nil when there is none
    static func checkedOn(_ value: String) -> String? {
        guard let match = value.prefixMatch(of: /(\d{4})-(\d{2})-(\d{2})/),
            let year = Int(match.output.1), let month = Int(match.output.2), let day = Int(match.output.3),
            (1...12).contains(month), (1...31).contains(day)
        else { return nil }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(months[month - 1]) \(day), \(year)"
    }
}
