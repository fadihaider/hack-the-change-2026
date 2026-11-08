import Foundation
import MapKit

/// the words, colours and geometry behind the care access views (components/app/access/access-data.ts, NearRosa.tsx,
/// AccessDetail.tsx, HowThisWorks.tsx and lib/care-access/home.ts). pure: no views, no network
nonisolated enum AccessWords {
    // ---- words

    /// SERVICE_NAMES in lib/care-access/engine.ts
    static let serviceNames: [String: String] = [
        "Pharmacy": "Pharmacies", "Health Centre": "Health centres", "Hospital": "Hospitals",
        "PHS Clinic": "Public-health clinics", "Social Dev Ctr": "Social support centres",
        "Community Centre": "Community centres", "Library": "Libraries",
    ]

    private static let kinds: [String: (one: String, many: String)] = [
        "Pharmacy": ("pharmacy", "pharmacies"),
        "Health Centre": ("health centre", "health centres"),
        "Hospital": ("hospital", "hospitals"),
        "PHS Clinic": ("public-health clinic", "public-health clinics"),
        "Social Dev Ctr": ("social support centre", "social support centres"),
        "Community Centre": ("community centre", "community centres"),
        "Library": ("library", "libraries"),
    ]

    /// "Pharmacies", for a list heading
    static func kindTitle(_ category: String) -> String {
        serviceNames[category] ?? category
    }

    /// "pharmacy" or "pharmacies", for a sentence
    static func kindWord(_ category: String, count: Int) -> String {
        guard let word = kinds[category] else { return category }
        return count == 1 ? word.one : word.many
    }

    /// "Pharmacy", the published category of one place
    static func kindLabel(_ category: String) -> String {
        guard let word = kinds[category]?.one else { return category }
        return NearbyWords.capitalise(word)
    }

    static func joinWords(_ words: [String], last: String = "and") -> String {
        NearbyWords.joinWords(words, last: last)
    }

    /// String(number) in js: 20 not 20.0
    static func number(_ value: Double) -> String {
        if value.isFinite, value.rounded() == value, abs(value) < 1e15 { return String(Int(value)) }
        return String(value)
    }

    /// "4 min" by car, or "1.2 km" in a straight line
    static func costText(_ cost: Double, mode: TravelMode) -> String {
        if mode == .driving {
            let minutes = Int(cost.rounded(.toNearestOrAwayFromZero))
            return minutes < 1 ? "under 1 min" : "\(minutes) min"
        }
        return cost < 0.1 ? "under 0.1 km" : "\(NearbyWords.fixed1(cost)) km"
    }

    /// "a 20-minute drive" or "3 km"
    static func windowText(_ threshold: Double, mode: TravelMode) -> String {
        mode == .driving ? "a \(number(threshold))-minute drive" : "\(number(threshold)) km"
    }

    private static let months = AlbertaTime.months

    /// "Nov 7, 2026" in Alberta time
    static func fetchedOn(_ iso: String) -> String {
        guard let date = AlbertaTime.parse(iso) ?? parseLoose(iso) else { return "an unknown date" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = AlbertaTime.timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(months[(parts.month ?? 1) - 1]) \(parts.day ?? 1), \(parts.year ?? 0)"
    }

    /// python's isoformat has six fractional digits, which ISO8601FormatStyle does not read
    private static func parseLoose(_ iso: String) -> Date? {
        let cut = iso.replacing(/\.(\d{3})\d+/) { ".\($0.1)" }
        return AlbertaTime.parse(cut)
    }

    /// plain names for the two fitted access groups, by size, never by quality
    struct GroupName: Sendable, Hashable {
        var label: String
        var phrase: String
    }

    static func groupNames(_ sizes: [ClusterSize]) -> [Int: GroupName] {
        if sizes.count == 2 && sizes[0].areas != sizes[1].areas {
            let sorted = sizes.sorted { $0.areas > $1.areas }
            return [
                Int(sorted[0].cluster): GroupName(label: "Larger group", phrase: "the larger of the two groups"),
                Int(sorted[1].cluster): GroupName(label: "Smaller group", phrase: "the smaller of the two groups"),
            ]
        }
        var names: [Int: GroupName] = [:]
        for (index, size) in sizes.enumerated() {
            names[Int(size.cluster)] = GroupName(
                label: "Group \(index + 1)", phrase: "group \(index + 1) of \(sizes.count)"
            )
        }
        return names
    }

    /// "about 63 pharmacies within 20 minutes, and about 9 health centres and 5 hospitals within 30 minutes"
    static func typicalText(_ typical: [ClusterTypical], categories: [String]) -> String {
        var windows: [Double] = []
        var byWindow: [Double: [String]] = [:]
        for row in typical where categories.contains(row.category) {
            let count = Int(row.mean.rounded(.toNearestOrAwayFromZero))
            let words = byWindow[row.minutes] ?? []
            if byWindow[row.minutes] == nil { windows.append(row.minutes) }
            byWindow[row.minutes] = words + ["\(words.isEmpty ? "about " : "")\(count) \(kindWord(row.category, count: count))"]
        }
        let parts = windows.sorted().map { "\(joinWords(byWindow[$0] ?? [])) within \(number($0)) minutes" }
        if parts.count <= 1 { return parts.first ?? "" }
        return "\(parts.dropLast().joined(separator: ", ")), and \(parts[parts.count - 1])"
    }

    /// "DOWNTOWN EAST VILLAGE" reads as "Downtown East Village"
    static func placeName(_ community: String) -> String {
        var out = ""
        var startOfWord = true
        for character in community.lowercased() {
            if startOfWord, character.isLetter, character.isASCII {
                out += character.uppercased()
            } else {
                out.append(character)
            }
            startOfWord = character == " " || character == "/" || character == "-" || character.isWhitespace
        }
        return out.replacing(/\b(Ne|Nw|Se|Sw)\b/) { $0.1.uppercased() }
    }

    // ---- the home summary (NearRosa.tsx)

    /// the drive-time choices on Care
    static let driveChoices: [Double] = [10, 20, 30]
    static let defaultMinutes: Double = 20
    /// the kinds named in the access-group line
    static let groupKinds = ["Pharmacy", "Health Centre", "Hospital"]

    /// one plain sentence about what is in reach
    static func summaryOf(_ data: HomeAccess) -> String {
        let from = data.matchedBy == .nearest
            ? "\(data.area.name), the community closest to the home address" : data.area.name
        let total = Int(data.resourcesWithin)
        if total == 0 { return "Nothing on this list is within \(windowText(data.threshold, mode: data.mode)) of \(from)." }
        let missing = AccessCategory.all.filter { (data.counts[$0] ?? 0) == 0 }
        let places = total == 1 ? "1 place is" : "\(total) places are"
        if missing.isEmpty { return "From \(from), \(places) in reach, with at least one of each kind below." }
        return "From \(from), \(places) in reach, but no \(joinWords(missing.map { kindWord($0, count: 2) }, last: "or"))."
    }

    static func groupLine(_ data: HomeAccess) -> String {
        let area = data.area.name
        guard let cluster = data.cluster, let profile = data.clusterProfile else {
            return "\(area) isn\u{2019}t in an access group, because its driving routes weren\u{2019}t fully mapped. That says nothing about how close care is."
        }
        let group = groupNames(data.clusterSizes)[Int(cluster)]
        let typical = typicalText(profile.typical, categories: groupKinds)
        let place = group.map { "in \($0.phrase)" } ?? "in one of the groups"
        return "\(area) is one of \(number(profile.areas)) communities \(place). On average, a community there has \(typical). The groups put communities with similar counts together; neither one is better."
    }

    struct SourceCredit: Sendable, Hashable {
        var name: String
        var url: URL?
        var via: String?
    }

    static let osmCopyright = URL(string: "https://www.openstreetmap.org/copyright")!

    /// the publishers of the places shown, then the routing credit when times are drive times
    static func uniqueSources(_ data: HomeAccess) -> [SourceCredit] {
        var list: [SourceCredit] = []
        for category in AccessCategory.all {
            guard let entry = data.nearest[category], let place = entry else { continue }
            if list.contains(where: { $0.name == place.source }) { continue }
            list.append(SourceCredit(name: place.source, url: Labels.safeURL(place.sourceUrl)))
        }
        if data.mode == .driving {
            list.append(SourceCredit(name: "OpenStreetMap contributors", url: osmCopyright, via: " via OSRM"))
        }
        return list
    }

    // ---- the explorer (AccessMap.tsx)

    /// WINDOWS
    static func windows(_ mode: TravelMode) -> [Double] {
        mode == .proximity ? [1, 2, 3, 5, 10] : [10, 15, 20, 30, 45]
    }

    /// DEFAULT_WINDOW
    static func defaultWindow(_ mode: TravelMode) -> Double {
        mode == .proximity ? 3 : 20
    }

    /// "NFKC, trimmed, single spaces, upper case": "DOWNTOWN EAST VILLAGE" and " Downtown  East Village" match
    static func communityKey(_ name: String) -> String {
        name.precomposedStringWithCompatibilityMapping
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacing(/\s+/, with: " ")
            .uppercased(with: Locale(identifier: "en_CA"))
    }

    /// index of the area whose name matches the community; nil when none does
    static func areaIndex(byName areas: [BasemapArea], community: String?) -> Int? {
        guard let community, !community.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let key = communityKey(community)
        return areas.firstIndex { communityKey($0.name) == key }
    }

    /// the types the classifier was trained on; nil when the report doesn't list them
    static func classifierLabels(_ report: ClassificationReport) -> Set<String>? {
        guard let labels = report.results.first(where: { $0.model == report.selectedModel })?.labels, !labels.isEmpty else {
            return nil
        }
        return Set(labels)
    }

    /// the model's type for a place when it differs from the published one, and only when the published type is one
    /// the model could have predicted
    static func modelSuggestion(_ resource: AccessResource, labels: Set<String>?) -> String? {
        guard let labels, labels.contains(resource.category) else { return nil }
        guard let model = resource.modelCategory, !model.isEmpty, model != resource.category else { return nil }
        return model
    }

    /// "70.95%", two places as the model reports give them
    static func percent(_ value: Double) -> String {
        String(format: "%.2f%%", value * 100)
    }

    static func fixed3(_ value: Double) -> String {
        String(format: "%.3f", value)
    }

    /// what the page says about the optional live classifier
    static func liveText(_ configured: Bool?) -> String {
        switch configured {
        case false?:
            "Live prediction for new names isn\u{2019}t available: it needs the optional model service set in CARE_ACCESS_INFERENCE_URL, and this server doesn\u{2019}t have one."
        case true?: "An optional live model service is set up on this server, but this page doesn\u{2019}t call it."
        case nil: "This page doesn\u{2019}t run the model live."
        }
    }

    /// landing pages for the raw downloads the snapshot lists
    static let sourcePages: [String: (name: String, page: String)] = [
        "odhf": (
            "Statistics Canada, Open Database of Healthcare Facilities",
            "https://www150.statcan.gc.ca/n1/pub/13-26-0001/132600012020001-eng.htm"
        ),
        "services": ("City of Calgary, Community Services", "https://data.calgary.ca/d/x34e-bcjz"),
        "communities": ("City of Calgary, Community Boundaries", "https://data.calgary.ca/d/surr-xmvs"),
    ]

    /// the score line VoiceOver reads for a community
    static func rowText(area: String, row: ScoreRow, isHome: Bool, name: String) -> String {
        let home = isHome ? ", \(Labels.possessive(name)) community" : ""
        let score = row.score.map { "access \(number($0)) out of 100" } ?? "not scored, driving routes incomplete"
        let reach = Int(row.inReach)
        return "\(area)\(home): \(score), \(reach) \(reach == 1 ? "place" : "places") in reach."
    }

    /// the group line VoiceOver reads for a community when the map shows groups
    static func groupRowText(area: String, cluster: Int?, isHome: Bool, name: String, groups: [Int: GroupName]) -> String {
        let home = isHome ? ", \(Labels.possessive(name)) community" : ""
        guard let cluster, cluster >= 0 else { return "\(area)\(home): no group, driving routes incomplete" }
        return "\(area)\(home): \(groups[cluster]?.label ?? "a group")"
    }

    /// the metric line under a community's score (AccessDetail.tsx)
    static func metricText(area: String, score: Double?, categories: Int, mode: TravelMode, threshold: Double) -> String {
        guard score != nil else {
            return "Driving routes from \(area) weren\u{2019}t fully mapped, so there\u{2019}s no score. That doesn\u{2019}t mean care is far away. Choose Distance to compare it by straight-line distance."
        }
        let kinds = categories == 1 ? "the 1 kind" : "the \(categories) kinds"
        return "Each of \(kinds) you picked counts in full at 5 or more places within \(reachText(mode: mode, threshold: threshold)), and in part below that. The score is the average. It counts listed places; it doesn\u{2019}t rate care."
    }

    /// "20 minutes by car" or "3 km in a straight line"
    static func reachText(mode: TravelMode, threshold: Double) -> String {
        mode == .driving ? "\(number(threshold)) minutes by car" : "\(number(threshold)) km in a straight line"
    }

    // ---- colours

    /// a teal sequential scale for the 0 to 100 access metric, light to dark (SCORE_STEPS)
    static let scoreSteps: [(from: Int, to: Int, hex: UInt32)] = [
        (0, 19, 0xD6ECEE), (20, 39, 0xA9D6DA), (40, 59, 0x6FB5BC), (60, 79, 0x2F8D96), (80, 100, 0x0A5F67),
    ]

    static func scoreStep(_ score: Double) -> Int {
        scoreSteps.firstIndex { score <= Double($0.to) } ?? (scoreSteps.count - 1)
    }

    static func scoreHex(_ score: Double) -> UInt32 {
        scoreSteps[scoreStep(score)].hex
    }

    /// two clearly different, quiet hues for the unordered groups: a cool slate and a warm sand (GROUP_FILLS)
    static let groupHexes: [UInt32] = [0x7D8CA6, 0xD8C398, 0xA39CB8, 0x9FB59A]

    static func groupHex(_ cluster: Int) -> UInt32 {
        groupHexes[((cluster % groupHexes.count) + groupHexes.count) % groupHexes.count]
    }

    /// green to red by straight-line distance, each 5:1 or more against white numbers (band0 to band4)
    static let bandHexes: [UInt32] = [0x157F3D, 0x627800, 0x8A6A00, 0xB4530F, 0xA1260D]

    // ---- geometry

    /// one community's polygons as coordinates: each polygon is its outer ring then any holes
    static func polygons(_ geometry: AreaGeometry) -> [[[CLLocationCoordinate2D]]] {
        geometry.polygons.map { rings in
            rings.filter { $0.count >= 3 }.map { ring in
                ring.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
            }
        }
        .filter { !$0.isEmpty }
    }

    /// ray casting on one ring, in lon/lat
    static func ring(_ ring: [CLLocationCoordinate2D], contains point: CLLocationCoordinate2D) -> Bool {
        guard ring.count >= 3 else { return false }
        var inside = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i]
            let b = ring[j]
            if (a.latitude > point.latitude) != (b.latitude > point.latitude) {
                let x = (b.longitude - a.longitude) * (point.latitude - a.latitude) / (b.latitude - a.latitude) + a.longitude
                if point.longitude < x { inside.toggle() }
            }
            j = i
        }
        return inside
    }

    /// inside an outer ring and outside its holes, for any of the polygons
    static func polygons(_ polygons: [[[CLLocationCoordinate2D]]], contain point: CLLocationCoordinate2D) -> Bool {
        polygons.contains { rings in
            guard let outer = rings.first, ring(outer, contains: point) else { return false }
            return !rings.dropFirst().contains { ring($0, contains: point) }
        }
    }

    /// a region around every ring, a little padded
    static func region(around shapes: [[[[CLLocationCoordinate2D]]]], padRatio: Double = 0.03) -> MKCoordinateRegion? {
        var minLat = Double.infinity
        var maxLat = -Double.infinity
        var minLon = Double.infinity
        var maxLon = -Double.infinity
        for polygons in shapes {
            for rings in polygons {
                for point in rings.first ?? [] {
                    minLat = min(minLat, point.latitude)
                    maxLat = max(maxLat, point.latitude)
                    minLon = min(minLon, point.longitude)
                    maxLon = max(maxLon, point.longitude)
                }
            }
        }
        guard minLat.isFinite, maxLat > minLat, maxLon > minLon else { return nil }
        let latSpan = (maxLat - minLat) * (1 + 2 * padRatio)
        let lonSpan = (maxLon - minLon) * (1 + 2 * padRatio)
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2),
            span: MKCoordinateSpan(latitudeDelta: latSpan, longitudeDelta: lonSpan)
        )
    }
}
