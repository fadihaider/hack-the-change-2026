import Foundation
import MapKit

/// the words behind the nearby cards and their map (components/app/resources/nearby-words.ts). pure: no views, no network
nonisolated enum NearbyWords {
    /// RADIUS_CHOICES
    static let radiusChoices: [NearbyRadius] = [.one, .two, .three, .five]

    /// the chip label, then the singular and plural words used in sentences (TYPE_WORDS)
    struct TypeWords: Sendable, Hashable {
        var label: String
        var one: String
        var many: String
    }

    static func words(_ type: NearbyType) -> TypeWords? {
        switch type {
        case .pharmacy: TypeWords(label: "Pharmacies", one: "pharmacy", many: "pharmacies")
        case .clinic: TypeWords(label: "Clinics and doctors", one: "clinic", many: "clinics and doctors\u{2019} offices")
        case .hospital: TypeWords(label: "Hospitals", one: "hospital", many: "hospitals")
        case .publicHealth:
            TypeWords(label: "Public-health clinics", one: "public-health clinic", many: "public-health clinics")
        case .socialSupport:
            TypeWords(label: "Social support centres", one: "social support centre", many: "social support centres")
        case .communityCentre:
            TypeWords(label: "Community centres", one: "community centre", many: "community centres")
        case .library: TypeWords(label: "Libraries", one: "library", many: "libraries")
        case .transit: TypeWords(label: "Transit stops", one: "transit stop", many: "transit stops")
        case .unrecognized: nil
        }
    }

    /// the chip label for a kind
    static func label(_ type: NearbyType) -> String {
        words(type)?.label ?? type.rawValue.replacingOccurrences(of: "_", with: " ")
    }

    /// the type shown on a card, e.g. "Pharmacy" or "Doctor’s office"
    static func typeText(type: NearbyType, kind: String, typeLabel: String = "") -> String {
        if type == .clinic && kind == "doctors" { return "Doctor\u{2019}s office" }
        if let one = words(type)?.one { return capitalise(one) }
        return capitalise(typeLabel.isEmpty ? type.rawValue.replacingOccurrences(of: "_", with: " ") : typeLabel)
    }

    static func typeText(_ resource: NearbyResource) -> String {
        typeText(type: resource.type, kind: resource.kind, typeLabel: resource.typeLabel)
    }

    static func capitalise(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }

    /// "a, b and c", or "a, b or c"
    static func joinWords(_ words: [String], last: String = "and") -> String {
        if words.count <= 1 { return words.first ?? "" }
        return "\(words.dropLast().joined(separator: ", ")) \(last) \(words[words.count - 1])"
    }

    /// toFixed(1)
    static func fixed1(_ value: Double) -> String {
        String(format: "%.1f", value)
    }

    /// String(Number(x.toFixed(1))): "0.6", "3", "2.4"
    static func trimmed1(_ value: Double) -> String {
        let text = fixed1(value)
        return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
    }

    /// "under 0.1 km", "0.4 km", "1.2 km", "12 km"
    static func kmText(_ km: Double) -> String {
        if !km.isFinite || km < 0 { return "Unknown distance" }
        if km < 0.1 { return "under 0.1 km" }
        return km < 10 ? "\(fixed1(km)) km" : "\(Int(km.rounded(.toNearestOrAwayFromZero))) km"
    }

    /// "1.2 km straight-line", never a drive or walking time
    static func distanceText(_ km: Double) -> String {
        let text = kmText(km)
        return text == "Unknown distance" ? text : "\(text) straight-line"
    }

    /// how many colour steps the map uses between close (green) and far (red)
    static let distanceBands = 5

    /// the colour step of a place: 0 is the closest fifth of the chosen straight-line distance (green), 4 the
    /// farthest fifth (red). a place beyond the chosen distance, such as the nearest hospital, is always red
    static func distanceBand(_ distanceKm: Double, radiusKm: Double, withinRadius: Bool = true) -> Int {
        let last = distanceBands - 1
        if !withinRadius || !(radiusKm > 0) || !distanceKm.isFinite { return last }
        // a tiny allowance so a place exactly on a step (0.6 of 3 km) is not pushed down by floating point
        let step = Int((distanceKm * Double(distanceBands) / radiusKm + 1e-9).rounded(.down))
        return min(last, max(0, step))
    }

    /// the legend line for the colours
    static func distanceScaleText(_ radiusKm: Double) -> String {
        let step = radiusKm / Double(distanceBands)
        return "Colour shows straight-line distance: green is under \(trimmed1(step)) km, "
            + "red is \(trimmed1(step * Double(distanceBands - 1))) km or more, or beyond \(trimmed1(radiusKm)) km."
    }

    /// the listed hours, or Unknown; open or closed only when the listed hours say so
    static func hoursText(_ hours: ResourceHours) -> (text: String, status: String?) {
        let trimmed = hours.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = trimmed.isEmpty ? "Hours unknown" : trimmed
        switch hours.status {
        case .open: return (text, "Open now by the listed hours")
        case .closed: return (text, "Closed now by the listed hours")
        case .unknown: return (text, nil)
        }
    }

    /// step-free access as the source lists it; a missing tag is Unknown, never "no"
    static func wheelchairText(_ value: Wheelchair) -> String {
        switch value {
        case .yes: "Yes, per the source"
        case .limited: "Limited, per the source"
        case .no: "No, per the source"
        case .unknown: "Unknown"
        }
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "Nov 7, 2026" for the date part of a fetched-at value; nil when there is none
    static func checkedOn(_ value: String) -> String? {
        guard let match = value.prefixMatch(of: /(\d{4})-(\d{2})-(\d{2})/) else { return nil }
        guard let year = Int(match.1), let month = Int(match.2), let day = Int(match.3) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) else {
            return nil
        }
        // Date.parse rolls 2026-02-31 over to March, as the web does
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        guard let m = parts.month, let d = parts.day, let y = parts.year else { return nil }
        return "\(months[m - 1]) \(d), \(y)"
    }

    /// a tel: url, or nil when the listed phone isn't a dialable number
    static func telURL(_ phone: String?) -> URL? {
        guard let phone, !phone.isEmpty else { return nil }
        let digits = String(phone.unicodeScalars.filter { CharacterSet(charactersIn: "+0123456789").contains($0) })
        guard digits.wholeMatch(of: /\+?\d{3,15}/) != nil else { return nil }
        return URL(string: "tel:\(digits)")
    }

    /// "Rosa’s home (approximate)": the server's label, with "approximate" added when the point is rounded
    static func originText(_ origin: NearbyOrigin) -> String {
        let trimmed = origin.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = trimmed.isEmpty ? "Home" : trimmed
        return origin.approximate && label.range(of: "approximate", options: .caseInsensitive) == nil
            ? "\(label) (approximate)" : label
    }

    private static func openRank(_ status: HoursStatus) -> Int {
        switch status {
        case .open: 0
        case .unknown: 1
        case .closed: 2
        }
    }

    /// the reading order of the cards, which is also the marker numbering: the closest of each kind first, then the
    /// second closest of each kind, and so on. places inside the chosen distance come before ones outside it.
    /// openFirst puts pharmacies open now by their listed hours ahead of unknown, then closed
    static func orderResources(_ resources: [NearbyResource], openFirst: Bool = false) -> [NearbyResource] {
        // kinds in order of first appearance, as a js Map keeps them
        var kinds: [NearbyType] = []
        var byType: [NearbyType: [(offset: Int, element: NearbyResource)]] = [:]
        for (offset, resource) in resources.enumerated() {
            if byType[resource.type] == nil { kinds.append(resource.type) }
            byType[resource.type, default: []].append((offset, resource))
        }
        var rounds: [[(offset: Int, element: NearbyResource)]] = []
        for kind in kinds {
            let list = (byType[kind] ?? []).sorted { a, b in
                if openFirst && a.element.type == .pharmacy {
                    let open = openRank(a.element.hours.status) - openRank(b.element.hours.status)
                    if open != 0 { return open < 0 }
                }
                if a.element.distanceKm != b.element.distanceKm { return a.element.distanceKm < b.element.distanceKm }
                return a.offset < b.offset
            }
            for (rank, item) in list.enumerated() {
                if rounds.count <= rank { rounds.append([]) }
                rounds[rank].append(item)
            }
        }
        var ordered: [NearbyResource] = []
        for round in rounds {
            // a stable sort: equal places keep the order they had in the round
            let sorted = round.enumerated().sorted { a, b in
                let x = a.element.element
                let y = b.element.element
                if x.withinRadius != y.withinRadius { return x.withinRadius }
                if x.distanceKm != y.distanceKm { return x.distanceKm < y.distanceKm }
                return a.offset < b.offset
            }
            ordered.append(contentsOf: sorted.map(\.element.element))
        }
        // one card per id, so every marker maps to exactly one card
        var seen = Set<String>()
        return ordered.filter { seen.insert($0.id).inserted }
    }

    /// cards on the first page: at least one of each kind, so the closest of each kind (including a nearest hospital
    /// outside the chosen distance, which the limits mention) is never hidden behind "Show more"
    static func firstPageSize(_ resources: [NearbyResource], initialVisible: Int) -> Int {
        max(initialVisible, Set(resources.map(\.type)).count)
    }

    /// "800 m" or "2 km" for a counting distance
    static func radiusText(_ km: Double) -> String {
        km < 1 ? "\(Int((km * 1000).rounded(.toNearestOrAwayFromZero))) m" : "\(trimmed1(km)) km"
    }

    /// the distance a count really covers: the server's withinKm when it is shorter (transit, 800 m), else the chosen one
    static func countingKm(_ withinKm: Double?, radiusKm: Double) -> Double {
        if let km = withinKm, km.isFinite, km > 0, km < radiusKm { return km }
        return radiusKm
    }

    /// group items by the distance they are counted within, the chosen distance first
    static func byCountingKm<T>(_ items: [T], radiusKm: Double, kmOf: (T) -> Double) -> [(km: Double, items: [T])] {
        var groups: [(km: Double, items: [T])] = [(radiusKm, [])]
        for item in items {
            let km = kmOf(item)
            if let index = groups.firstIndex(where: { $0.km == km }) {
                groups[index].items.append(item)
            } else {
                groups.append((km, [item]))
            }
        }
        return groups.filter { !$0.items.isEmpty }
    }

    /// plain sentences about what is within the chosen distance, from the server's counts. a kind counted within a
    /// shorter distance (transit stops, 800 m) gets its own sentence with that distance, never the chosen one
    static func summaryText(counts: [NearbyCount], radiusKm: Double, stepFreeOnly: Bool) -> String {
        let access = stepFreeOnly ? " with step-free access listed by the source" : ""
        func part(_ count: NearbyCount) -> String {
            let words = words(count.type)
            let many = words?.many ?? count.label.lowercased()
            if count.withinRadius == 0 { return "no \(many)" }
            return "\(count.withinRadius) \(count.withinRadius == 1 ? (words?.one ?? many) : many)"
        }
        let groups = byCountingKm(counts, radiusKm: radiusKm) { countingKm($0.withinKm, radiusKm: radiusKm) }
        if groups.isEmpty {
            return "Within \(radiusText(radiusKm)) in a straight line: nothing on these lists\(access)."
        }
        return groups
            .map { "Within \(radiusText($0.km)) in a straight line\(access): \(joinWords($0.items.map(part)))." }
            .joined(separator: " ")
    }

    static func summaryText(_ data: NearbyResponse, stepFreeOnly: Bool) -> String {
        summaryText(counts: data.counts, radiusKm: data.radiusKm, stepFreeOnly: stepFreeOnly)
    }

    /// the empty-state sentence: never a placeholder point, always a next step
    static func emptyText(types: [NearbyType], radiusKm: Double, stepFreeOnly: Bool, counts: [NearbyCount] = []) -> String {
        let groups = byCountingKm(types, radiusKm: radiusKm) { type in
            countingKm(counts.first { $0.type == type }?.withinKm, radiusKm: radiusKm)
        }
        let what = groups.enumerated().map { index, group in
            let kinds = joinWords(group.items.map { words($0)?.many ?? $0.rawValue }, last: "or")
            return "\(index == 0 ? "No" : "and no") \(kinds) within \(radiusText(group.km))"
        }
        .joined(separator: ", ")
        if stepFreeOnly {
            return "\(what) have step-free access listed by the source. Unknown isn\u{2019}t the same as not accessible, so try turning this off."
        }
        // a longer distance only helps a kind counted at the chosen distance, and only below the longest choice
        let longest = Double(radiusChoices.map(\.rawValue).max() ?? 5)
        let longer = radiusKm < longest && groups.contains { $0.km >= radiusKm }
        return "\(what) in these public lists. \(longer ? "Try a longer distance." : "Try another kind of place.")"
    }

    // ---- the map

    static let kmPerDegreeLat = 111.2

    /// mapBounds: the home point, the places inside the chosen distance and the whole distance circle. places outside
    /// the distance (a far hospital) are left out, so they can't zoom the map out and stack the nearby markers
    static func mapRegion(origin: NearbyOrigin, radiusKm: Double, resources: [NearbyResource]) -> MKCoordinateRegion? {
        var points: [(lat: Double, lon: Double)] = [(origin.lat, origin.lon)]
        points += resources.filter(\.withinRadius).map { ($0.lat, $0.lon) }
        if origin.lat.isFinite, origin.lon.isFinite, radiusKm.isFinite, radiusKm > 0 {
            let dLat = radiusKm / kmPerDegreeLat
            let dLon = radiusKm / (kmPerDegreeLat * max(0.1, cos(origin.lat * .pi / 180)))
            points += [
                (origin.lat + dLat, origin.lon), (origin.lat - dLat, origin.lon),
                (origin.lat, origin.lon + dLon), (origin.lat, origin.lon - dLon),
            ]
        }
        return region(around: points, padRatio: 0.04)
    }

    /// a region around the points, padded, and never narrower than minSpanKm (boundsAround)
    static func region(around points: [(lat: Double, lon: Double)], padRatio: Double = 0.12, minSpanKm: Double = 1.5)
        -> MKCoordinateRegion?
    {
        let usable = points.filter { $0.lat.isFinite && $0.lon.isFinite && abs($0.lat) <= 90 }
        guard !usable.isEmpty else { return nil }
        var west = usable.map(\.lon).min()!
        var east = usable.map(\.lon).max()!
        var south = usable.map(\.lat).min()!
        var north = usable.map(\.lat).max()!
        let midLat = (south + north) / 2
        let cosine = max(0.1, cos(midLat * .pi / 180))
        let minLat = minSpanKm / kmPerDegreeLat
        let minLon = minSpanKm / (kmPerDegreeLat * cosine)
        if north - south < minLat {
            let mid = (north + south) / 2
            south = mid - minLat / 2
            north = mid + minLat / 2
        }
        if east - west < minLon {
            let mid = (east + west) / 2
            west = mid - minLon / 2
            east = mid + minLon / 2
        }
        let padLat = (north - south) * padRatio
        let padLon = (east - west) * padRatio
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (south + north) / 2, longitude: (west + east) / 2),
            span: MKCoordinateSpan(latitudeDelta: north - south + 2 * padLat, longitudeDelta: east - west + 2 * padLon)
        )
    }

    // ---- marker layout (placeMarkers in nearby-words.ts), in screen points of a map showing a fixed region

    struct ScreenPoint: Sendable, Hashable {
        var x: Double
        var y: Double
    }

    /// a fixed region drawn into a box of points: web mercator, which at city scale is lon-linear and stretches
    /// latitude by 1/cos(lat), centred and fitted without stretching, as MapKit fits a region
    struct ScreenProjection: Sendable {
        var center: CLLocationCoordinate2D
        var width: Double
        var height: Double
        /// points per degree of longitude
        var scale: Double
        var cosLat: Double

        init(region: MKCoordinateRegion, width: Double, height: Double) {
            center = region.center
            self.width = width
            self.height = height
            cosLat = max(0.1, cos(region.center.latitude * .pi / 180))
            let spanX = max(1e-9, region.span.longitudeDelta)
            let spanY = max(1e-9, region.span.latitudeDelta / cosLat)
            scale = min(width / spanX, height / spanY)
        }

        func point(lat: Double, lon: Double) -> ScreenPoint {
            ScreenPoint(
                x: width / 2 + (lon - center.longitude) * scale,
                y: height / 2 - (lat - center.latitude) / cosLat * scale
            )
        }

        func coordinate(_ point: ScreenPoint) -> CLLocationCoordinate2D {
            CLLocationCoordinate2D(
                latitude: center.latitude - (point.y - height / 2) * cosLat / scale,
                longitude: center.longitude + (point.x - width / 2) / scale
            )
        }
    }

    struct MarkerSizes: Sendable, Hashable {
        /// the drawn dot
        var markerR: Double = 13
        /// the largest tap target
        var hitR: Double = 22
        /// half the home glyph, so no marker covers it
        var homeR: Double = 12
        /// clear space kept between markers
        var gap: Double = 4
        /// how far in from the map edge a marker for a place beyond the map sits, with room for its arrow
        var edge: Double = 25
    }

    struct PlacedMarker: Sendable, Hashable {
        /// where the marker is drawn
        var x: Double
        var y: Double
        /// the place's real projected point, which may be off the map
        var trueX: Double
        var trueY: Double
        /// the real point is beyond the map, so the marker sits at the edge in its direction with an arrow
        var clamped: Bool
        /// drawn away from its real point so it doesn't cover another marker; a line leads to the real point
        var moved: Bool
        /// degrees from the drawn marker toward the real point (0 is east, 90 is south on screen)
        var angle: Double
    }

    private static let goldenAngle = 2.399963
    private static let settleRounds = 120

    /// one visible, separate marker per point. a point beyond the map is pulled in along the line from home to the
    /// map edge (clamped). markers that would overlap each other or the home glyph are pushed apart a little (moved).
    /// points keep their order: result n is point n
    static func placeMarkers(
        _ points: [ScreenPoint], home: ScreenPoint, width: Double, height: Double, sizes: MarkerSizes = MarkerSizes()
    ) -> [PlacedMarker] {
        let keep = sizes.markerR + 6
        func inside(_ value: Double, _ low: Double, _ high: Double) -> Double { min(high, max(low, value)) }
        let anchors: [(x: Double, y: Double, clamped: Bool)] = points.map { point in
            let minX = sizes.edge
            let maxX = width - sizes.edge
            let minY = sizes.edge
            let maxY = height - sizes.edge
            if point.x >= keep && point.x <= width - keep && point.y >= keep && point.y <= height - keep {
                return (point.x, point.y, false)
            }
            // walk from home toward the point and stop at the edge, so the marker keeps the real direction
            let hx = inside(home.x, minX, maxX)
            let hy = inside(home.y, minY, maxY)
            let dx = point.x - hx
            let dy = point.y - hy
            var t = 1.0
            if dx > 0 { t = min(t, (maxX - hx) / dx) }
            if dx < 0 { t = min(t, (minX - hx) / dx) }
            if dy > 0 { t = min(t, (maxY - hy) / dy) }
            if dy < 0 { t = min(t, (minY - hy) / dy) }
            return (inside(hx + dx * t, minX, maxX), inside(hy + dy * t, minY, maxY), true)
        }

        var placed = anchors.map { ScreenPoint(x: $0.x, y: $0.y) }
        let apart = 2 * sizes.markerR + sizes.gap
        let fromHome = sizes.markerR + sizes.homeR + sizes.gap
        func pin(_ index: Int) {
            let pad = anchors[index].clamped ? sizes.edge : keep
            placed[index].x = inside(placed[index].x, pad, width - pad)
            placed[index].y = inside(placed[index].y, pad, height - pad)
        }
        for _ in 0..<settleRounds {
            var overlap = false
            for i in placed.indices {
                for j in placed.indices where j > i {
                    var dx = placed[j].x - placed[i].x
                    var dy = placed[j].y - placed[i].y
                    var d = hypot(dx, dy)
                    if d >= apart - 0.01 { continue }
                    overlap = true
                    if d < 1e-6 {
                        // the same spot: fan out in a fixed direction so the layout is the same every time
                        let turn = Double(i + j) * goldenAngle
                        dx = cos(turn)
                        dy = sin(turn)
                        d = 1
                    } else {
                        dx /= d
                        dy /= d
                    }
                    let push = (apart - max(d, 0)) / 2 + 0.05
                    placed[i].x -= dx * push
                    placed[i].y -= dy * push
                    placed[j].x += dx * push
                    placed[j].y += dy * push
                    pin(i)
                    pin(j)
                }
                let hx = placed[i].x - home.x
                let hy = placed[i].y - home.y
                let hd = hypot(hx, hy)
                if hd < fromHome - 0.01 {
                    overlap = true
                    let turn = Double(i) * goldenAngle
                    let ux = hd < 1e-6 ? cos(turn) : hx / hd
                    let uy = hd < 1e-6 ? sin(turn) : hy / hd
                    placed[i].x = home.x + ux * (fromHome + 0.05)
                    placed[i].y = home.y + uy * (fromHome + 0.05)
                    pin(i)
                }
            }
            if !overlap { break }
        }

        return placed.enumerated().map { index, position in
            let trueX = points[index].x
            let trueY = points[index].y
            return PlacedMarker(
                x: position.x, y: position.y, trueX: trueX, trueY: trueY,
                clamped: anchors[index].clamped,
                moved: !anchors[index].clamped && hypot(position.x - trueX, position.y - trueY) > 1.5,
                angle: atan2(trueY - position.y, trueX - position.x) * 180 / .pi
            )
        }
    }

    private static let compass = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"]

    /// "north-west" for a screen direction (y grows downward)
    static func compassText(dx: Double, dy: Double) -> String {
        let degrees = atan2(-dy, dx) * 180 / .pi
        let step = Int((degrees / 45).rounded(.toNearestOrAwayFromZero))
        return compass[((step % 8) + 8) % 8]
    }

    /// the community's own outline is drawn darker
    static func isHomeOutline(_ outline: CommunityOutline, origin: NearbyOrigin) -> Bool {
        let home = (origin.community ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !home.isEmpty && outline.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == home
    }

    /// what a marker says to VoiceOver; toward is the compass direction of a place beyond the map edge
    static func markerLabel(number: Int, resource: NearbyResource, beyondToward toward: String? = nil) -> String {
        let where_ = toward.map { ", beyond the map edge to the \($0)" } ?? ""
        return "\(number). \(resource.name), \(typeText(resource)), \(distanceText(resource.distanceKm))\(where_)"
    }

    /// the line under the map
    static func mapCaption(number: Int?, resource: NearbyResource?, marker: PlacedMarker? = nil, toward: String = "")
        -> String
    {
        guard let number, let resource else { return "Choose a marker or a place in the list to match them up." }
        var text = "\(number). \(resource.name) \u{00B7} \(typeText(resource)) \u{00B7} \(distanceText(resource.distanceKm))"
        if let marker, marker.clamped {
            text += " \u{00B7} beyond the map edge to the \(toward)"
        } else if let marker, marker.moved {
            text += " \u{00B7} moved a little so it doesn\u{2019}t cover another marker"
        }
        return text
    }
}
