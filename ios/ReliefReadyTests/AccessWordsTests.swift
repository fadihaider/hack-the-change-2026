import CoreLocation
import Foundation
import Testing
@testable import ReliefReady

// ports of lib/frontend/nearby-words.test.ts plus the access-data.ts and NearRosa.tsx wording; expected values follow
// the TypeScript helpers
struct AccessNearbyWordsTests {
    private func place(
        _ id: String, _ type: NearbyType, km: Double, within: Bool = true, status: HoursStatus = .unknown,
        lat: Double = 51.045, lon: Double = -114.055
    ) -> NearbyResource {
        NearbyResource(
            id: id, type: type, typeLabel: type.rawValue, kind: type.rawValue, name: "Place \(id)", address: nil,
            lat: lat, lon: lon, distanceKm: km, withinRadius: within, phone: nil,
            hours: ResourceHours(text: nil, status: status), wheelchair: .unknown, source: "OpenStreetMap contributors",
            sourceUrl: "https://www.openstreetmap.org/node/1", license: "ODbL", fetchedAt: "2026-11-07"
        )
    }

    @Test func distanceColoursRunGreenToRedAndBeyondIsRed() {
        #expect(NearbyWords.distanceBands == 5)
        #expect(NearbyWords.distanceBand(0, radiusKm: 3) == 0)
        #expect(NearbyWords.distanceBand(0.59, radiusKm: 3) == 0)
        #expect(NearbyWords.distanceBand(0.6, radiusKm: 3) == 1)
        #expect(NearbyWords.distanceBand(1.5, radiusKm: 3) == 2)
        #expect(NearbyWords.distanceBand(2.4, radiusKm: 3) == 4)
        #expect(NearbyWords.distanceBand(3, radiusKm: 3) == 4)
        #expect(NearbyWords.distanceBand(0.3, radiusKm: 3, withinRadius: false) == 4)
        #expect(NearbyWords.distanceBand(.nan, radiusKm: 3) == 4)
        #expect(
            NearbyWords.distanceScaleText(3)
                == "Colour shows straight-line distance: green is under 0.6 km, red is 2.4 km or more, or beyond 3 km."
        )
        #expect(
            NearbyWords.distanceScaleText(1)
                == "Colour shows straight-line distance: green is under 0.2 km, red is 0.8 km or more, or beyond 1 km."
        )
        #expect(AccessWords.bandHexes.count == NearbyWords.distanceBands)
    }

    @Test func cardsListTheClosestOfEachKindFirstOncePerId() {
        let p1 = place("p1", .pharmacy, km: 0.4)
        let p2 = place("p2", .pharmacy, km: 0.9, status: .open)
        let h1 = place("h1", .hospital, km: 5.8, within: false)
        let t1 = place("t1", .transit, km: 0.1)
        #expect(NearbyWords.orderResources([p1, p2, h1, t1, p1]).map(\.id) == ["t1", "p1", "h1", "p2"])
        #expect(NearbyWords.orderResources([p1, p2, h1, t1], openFirst: true).map(\.id) == ["t1", "p2", "h1", "p1"])
    }

    @Test func unknownStaysUnknown() {
        let unknown = NearbyWords.hoursText(ResourceHours(text: nil, status: .unknown))
        #expect(unknown.text == "Hours unknown")
        #expect(unknown.status == nil)
        #expect(NearbyWords.hoursText(ResourceHours(text: "Mo-Fr 09:00-17:00", status: .closed)).status == "Closed now by the listed hours")
        #expect(NearbyWords.hoursText(ResourceHours(text: "Mo-Fr 09:00-17:00", status: .unknown)).status == nil)
        #expect(NearbyWords.wheelchairText(.unknown) == "Unknown")
        #expect(NearbyWords.wheelchairText(.no) == "No, per the source")
        #expect(NearbyWords.distanceText(1.23) == "1.2 km straight-line")
        #expect(NearbyWords.distanceText(0.04) == "under 0.1 km straight-line")
        #expect(NearbyWords.distanceText(12.4) == "12 km straight-line")
        #expect(NearbyWords.distanceText(-1) == "Unknown distance")
        #expect(NearbyWords.typeText(type: .clinic, kind: "doctors") == "Doctor\u{2019}s office")
        #expect(NearbyWords.typeText(type: .pharmacy, kind: "pharmacy") == "Pharmacy")
        #expect(NearbyWords.checkedOn("2026-11-07") == "Nov 7, 2026")
        #expect(NearbyWords.checkedOn("2026-11-07T10:00:00Z") == "Nov 7, 2026")
        #expect(NearbyWords.checkedOn("soon") == nil)
        #expect(NearbyWords.telURL("(403) 555-0100")?.absoluteString == "tel:4035550100")
        #expect(NearbyWords.telURL("+1 403 263 4620")?.absoluteString == "tel:+14032634620")
        #expect(NearbyWords.telURL("call the front desk") == nil)
        let origin = NearbyOrigin(lat: 51.045, lon: -114.055, label: "Rosa\u{2019}s home", community: nil, approximate: true)
        #expect(NearbyWords.originText(origin) == "Rosa\u{2019}s home (approximate)")
        var already = origin
        already.label = "Rosa\u{2019}s home (approximate)"
        #expect(NearbyWords.originText(already) == "Rosa\u{2019}s home (approximate)")
    }

    @Test func summaryAndEmptyTextNameTheStraightLineDistance() {
        let counts = [
            NearbyCount(type: .pharmacy, label: "Pharmacies", shown: 2, withinRadius: 9, withinKm: nil),
            NearbyCount(type: .hospital, label: "Hospitals", shown: 1, withinRadius: 0, withinKm: nil),
            NearbyCount(type: .transit, label: "Transit stops", shown: 1, withinRadius: 1, withinKm: nil),
        ]
        #expect(
            NearbyWords.summaryText(counts: counts, radiusKm: 2, stepFreeOnly: false)
                == "Within 2 km in a straight line: 9 pharmacies, no hospitals and 1 transit stop."
        )
        #expect(
            NearbyWords.emptyText(types: [.pharmacy], radiusKm: 1, stepFreeOnly: false)
                == "No pharmacies within 1 km in these public lists. Try a longer distance."
        )
        #expect(NearbyWords.emptyText(types: [.pharmacy], radiusKm: 1, stepFreeOnly: true).contains("Unknown isn\u{2019}t the same as not accessible"))
        #expect(NearbyWords.emptyText(types: [.pharmacy], radiusKm: 5, stepFreeOnly: false).hasSuffix("Try another kind of place."))
    }

    @Test func transitCountsNameTheirOwnCountingDistance() {
        let counts = [
            NearbyCount(type: .pharmacy, label: "Pharmacies", shown: 2, withinRadius: 9, withinKm: 5),
            NearbyCount(type: .transit, label: "Transit stops", shown: 3, withinRadius: 75, withinKm: 0.8),
        ]
        #expect(
            NearbyWords.summaryText(counts: counts, radiusKm: 5, stepFreeOnly: false)
                == "Within 5 km in a straight line: 9 pharmacies. Within 800 m in a straight line: 75 transit stops."
        )
        var none = counts[1]
        none.withinRadius = 0
        #expect(NearbyWords.summaryText(counts: [none], radiusKm: 5, stepFreeOnly: false) == "Within 800 m in a straight line: no transit stops.")
        #expect(
            NearbyWords.emptyText(types: [.transit], radiusKm: 5, stepFreeOnly: false, counts: counts)
                == "No transit stops within 800 m in these public lists. Try another kind of place."
        )
        #expect(
            NearbyWords.emptyText(types: [.pharmacy, .transit], radiusKm: 1, stepFreeOnly: false, counts: counts)
                == "No pharmacies within 1 km, and no transit stops within 800 m in these public lists. Try a longer distance."
        )
    }

    @Test func theFirstPageHoldsTheClosestOfEachKind() {
        let types: [NearbyType] = [.pharmacy, .clinic, .publicHealth, .socialSupport, .communityCentre, .library]
        var resources: [NearbyResource] = []
        for (index, type) in types.enumerated() {
            resources.append(place("\(type.rawValue)-1", type, km: 0.2 + Double(index) / 10))
            resources.append(place("\(type.rawValue)-2", type, km: 1 + Double(index) / 10))
        }
        resources.append(place("far-hospital", .hospital, km: 5.8, within: false))
        let ordered = NearbyWords.orderResources(resources)
        let first = ordered.prefix(NearbyWords.firstPageSize(ordered, initialVisible: 6))
        #expect(first.count == 7)
        #expect(first.contains { $0.id == "far-hospital" })
        #expect(NearbyWords.firstPageSize(Array(ordered.prefix(3)), initialVisible: 6) == 6)
    }

    @Test func theFixtureReadsInCardOrder() throws {
        let data = try Fixtures.decode(NearbyResponse.self, "nearby")
        #expect(
            NearbyWords.orderResources(data.resources).map { String($0.id.prefix(4)) }
                == ["551b", "0ee7", "f3f2", "e50b", "d6f7", "4436", "39c5", "5547", "d281"]
        )
        #expect(
            NearbyWords.summaryText(data, stepFreeOnly: false)
                == "Within 3 km in a straight line: 24 pharmacies, 26 clinics and doctors\u{2019} offices and no hospitals."
        )
        let region = try #require(NearbyWords.mapRegion(origin: data.origin, radiusKm: data.radiusKm, resources: data.resources))
        // the map fits home and the 3 km circle, not the far hospital
        #expect(region.span.latitudeDelta > 6 / 111.2)
        #expect(region.span.latitudeDelta < 7 / 111.2)
    }

    @Test func markersStaySeparateClearOfHomeAndInsideTheMap() {
        let home = NearbyWords.ScreenPoint(x: 160, y: 160)
        let points = [
            NearbyWords.ScreenPoint(x: 161, y: 160), NearbyWords.ScreenPoint(x: 161, y: 160),
            NearbyWords.ScreenPoint(x: 200, y: 150), NearbyWords.ScreenPoint(x: -400, y: 100),
        ]
        let sizes = NearbyWords.MarkerSizes()
        let placed = NearbyWords.placeMarkers(points, home: home, width: 320, height: 320, sizes: sizes)
        #expect(placed.count == 4)
        for (i, a) in placed.enumerated() {
            #expect(a.x >= 0 && a.x <= 320 && a.y >= 0 && a.y <= 320)
            #expect(hypot(a.x - home.x, a.y - home.y) >= sizes.markerR + sizes.homeR + sizes.gap - 0.5, "\(i) covers home")
            for b in placed[(i + 1)...] {
                #expect(hypot(a.x - b.x, a.y - b.y) >= 2 * sizes.markerR + sizes.gap - 0.5)
            }
        }
        #expect(placed[0].moved && placed[1].moved)
        #expect(!placed[2].clamped)
        #expect(placed[3].clamped)
        #expect(placed[3].x == sizes.edge)
        #expect(NearbyWords.compassText(dx: placed[3].trueX - home.x, dy: placed[3].trueY - home.y) == "west")
        #expect(NearbyWords.compassText(dx: -1, dy: -1) == "north-west")
        #expect(NearbyWords.compassText(dx: 0, dy: 1) == "south")
    }

    @Test func theScreenProjectionRoundTrips() {
        let region = NearbyWords.region(around: [(51.03, -114.08), (51.06, -114.03)], padRatio: 0)!
        let projection = NearbyWords.ScreenProjection(region: region, width: 320, height: 340)
        let point = projection.point(lat: 51.05, lon: -114.06)
        let back = projection.coordinate(point)
        #expect(abs(back.latitude - 51.05) < 1e-9)
        #expect(abs(back.longitude - -114.06) < 1e-9)
        let centre = projection.point(lat: region.center.latitude, lon: region.center.longitude)
        #expect(abs(centre.x - 160) < 1e-9 && abs(centre.y - 170) < 1e-9)
        #expect(projection.point(lat: 51.06, lon: -114.05).y < projection.point(lat: 51.04, lon: -114.05).y, "north is up")
    }
}

struct AccessExplorerWordsTests {
    @Test func words() {
        #expect(AccessWords.kindTitle("PHS Clinic") == "Public-health clinics")
        #expect(AccessWords.kindWord("Library", count: 1) == "library")
        #expect(AccessWords.kindWord("Library", count: 2) == "libraries")
        #expect(AccessWords.kindLabel("Social Dev Ctr") == "Social support centre")
        #expect(AccessWords.kindLabel("Ambulatory") == "Ambulatory")
        #expect(AccessWords.costText(4.4, mode: .driving) == "4 min")
        #expect(AccessWords.costText(0.4, mode: .driving) == "under 1 min")
        #expect(AccessWords.costText(1.25, mode: .proximity) == "1.2 km" || AccessWords.costText(1.25, mode: .proximity) == "1.3 km")
        #expect(AccessWords.costText(0.05, mode: .proximity) == "under 0.1 km")
        #expect(AccessWords.windowText(20, mode: .driving) == "a 20-minute drive")
        #expect(AccessWords.windowText(3, mode: .proximity) == "3 km")
        #expect(AccessWords.fetchedOn("2026-11-08T02:53:05.250882+00:00") == "Nov 7, 2026")
        #expect(AccessWords.fetchedOn("2026-11-08T12:00:00Z") == "Nov 8, 2026")
        #expect(AccessWords.fetchedOn("later") == "an unknown date")
        #expect(AccessWords.placeName("DOWNTOWN EAST VILLAGE") == "Downtown East Village")
        #expect(AccessWords.placeName("BRIDGELAND/RIVERSIDE") == "Bridgeland/Riverside")
        #expect(AccessWords.placeName("UNIVERSITY DISTRICT NW") == "University District NW")
        #expect(AccessWords.percent(0.7095238) == "70.95%")
        #expect(AccessWords.communityKey(" Downtown  East Village ") == AccessWords.communityKey("DOWNTOWN EAST VILLAGE"))
    }

    @Test func groupsAreNamedBySizeNeverByQuality() {
        let two = AccessWords.groupNames([ClusterSize(cluster: 0, areas: 122), ClusterSize(cluster: 1, areas: 28)])
        #expect(two[0]?.label == "Larger group")
        #expect(two[1]?.phrase == "the smaller of the two groups")
        let even = AccessWords.groupNames([ClusterSize(cluster: 0, areas: 5), ClusterSize(cluster: 1, areas: 5)])
        #expect(even[1]?.label == "Group 2")
        #expect(even[0]?.phrase == "group 1 of 2")
    }

    @Test func theHomeSummaryReadsTheFixture() throws {
        let home = try Fixtures.decode(HomeAccess.self, "care-access-home")
        #expect(AccessWords.summaryOf(home) == "From Downtown East Village, 148 places are in reach, with at least one of each kind below.")
        #expect(
            AccessWords.groupLine(home)
                == "Downtown East Village is one of 122 communities in the larger of the two groups. On average, a community there has about 63 pharmacies within 20 minutes, and about 9 health centres and 5 hospitals within 30 minutes. The groups put communities with similar counts together; neither one is better."
        )
        var none = home
        none.resourcesWithin = 0
        #expect(AccessWords.summaryOf(none) == "Nothing on this list is within a 15-minute drive of Downtown East Village.")
        var missing = home
        missing.counts["Library"] = 0
        missing.counts["Hospital"] = 0
        missing.matchedBy = .nearest
        #expect(
            AccessWords.summaryOf(missing)
                == "From Downtown East Village, the community closest to the home address, 148 places are in reach, but no hospitals or libraries."
        )
        var ungrouped = home
        ungrouped.cluster = nil
        #expect(AccessWords.groupLine(ungrouped).hasPrefix("Downtown East Village isn\u{2019}t in an access group"))
        let sources = AccessWords.uniqueSources(home)
        #expect(sources.last?.name == "OpenStreetMap contributors")
        #expect(sources.last?.via == " via OSRM")
        #expect(Set(sources.map(\.name)).count == sources.count)
    }

    @Test func scoresAndGroupsColourTheMap() {
        #expect(AccessWords.scoreHex(0) == 0xD6ECEE)
        #expect(AccessWords.scoreHex(19) == 0xD6ECEE)
        #expect(AccessWords.scoreHex(20) == 0xA9D6DA)
        #expect(AccessWords.scoreHex(97) == 0x0A5F67)
        #expect(AccessWords.groupHex(0) == 0x7D8CA6)
        #expect(AccessWords.groupHex(5) == 0xD8C398)
    }

    @Test func modelSuggestionsOnlyForTypesTheModelKnows() {
        let labels: Set<String> = ["Pharmacy", "Health Centre", "Hospital"]
        var resource = AccessResource(
            id: "a", name: "X", category: "Hospital", modelCategory: "Health Centre", address: "", sourceUrl: "",
            source: "", wheelchair: nil, hours: nil
        )
        #expect(AccessWords.modelSuggestion(resource, labels: labels) == "Health Centre")
        #expect(AccessWords.modelSuggestion(resource, labels: nil) == nil)
        resource.category = "Library"
        #expect(AccessWords.modelSuggestion(resource, labels: labels) == nil)
        resource.category = "Health Centre"
        #expect(AccessWords.modelSuggestion(resource, labels: labels) == nil)
    }

    @Test func pointInPolygonHonoursHoles() {
        func c(_ lat: Double, _ lon: Double) -> CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lon) }
        let outer = [c(0, 0), c(0, 10), c(10, 10), c(10, 0)]
        let hole = [c(4, 4), c(4, 6), c(6, 6), c(6, 4)]
        #expect(AccessWords.polygons([[outer, hole]], contain: c(2, 2)))
        #expect(!AccessWords.polygons([[outer, hole]], contain: c(5, 5)))
        #expect(!AccessWords.polygons([[outer]], contain: c(11, 5)))
    }

    @Test func theBasemapFixtureFindsHerCommunityAndHowItWorks() throws {
        let basemap = try Fixtures.decode(AccessBasemap.self, "care-access-basemap")
        let index = try #require(AccessWords.areaIndex(byName: basemap.areas, community: "DOWNTOWN EAST VILLAGE"))
        #expect(basemap.areas[index].id == "DNE")
        #expect(AccessWords.areaIndex(byName: basemap.areas, community: "Atlantis") == nil)
        #expect(AccessWords.areaIndex(byName: basemap.areas, community: "  ") == nil)
        let labels = try #require(AccessWords.classifierLabels(basemap.benchmark.classification))
        #expect(labels.contains("Pharmacy"))
        #expect(!labels.contains("Library"))
        #expect(AccessWords.liveText(false).contains("CARE_ACCESS_INFERENCE_URL"))
        #expect(AccessWords.region(around: basemap.areas.map { AccessWords.polygons($0.geometry) }) != nil)
    }
}
