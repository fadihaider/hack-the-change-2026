import CoreLocation
import Foundation
import Testing
@testable import ReliefReady

/// the nearby and explorer view models against canned replies
@MainActor
struct AccessModelTests {
    private func reply(_ fixture: String, status: Int = 200) throws -> StubProtocol.Reply {
        StubProtocol.Reply(status: status, body: try Fixtures.data(fixture))
    }

    @Test func nearbyStartsWithCareKindsAndAsksForThem() async throws {
        let (api, host) = StubProtocol.client(reply: try reply("nearby"))
        let model = NearbyModel(defaultTypes: NearbyModel.careDefaultTypes)
        #expect(model.types == NearbyType.allCases.filter { $0 != .transit })
        #expect(model.radius == .three)
        await model.load(api: api)
        #expect(model.data != nil)
        #expect(model.failure == nil)
        #expect(!model.isLoading)
        let url = try #require(StubProtocol.requests(host: host).last?.request.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.first { $0.name == "types" }?.value == "pharmacy,clinic,hospital,public_health,social_support,community_centre,library")
        #expect(items.first { $0.name == "radiusKm" }?.value == "3")
        #expect(items.first { $0.name == "accessible" }?.value == "any")
        #expect(items.first { $0.name == "perType" }?.value == "4")
        // 9 places, 3 kinds: the first page is 6, the rest one tap away
        #expect(model.visible.count == 6)
        #expect(model.hiddenCount == 3)
        #expect(model.nextBatch == 3)
        let firstNew = model.showMore()
        #expect(firstNew?.hasPrefix("39c5") == true)
        #expect(model.visible.count == 9)
        #expect(model.hiddenCount == 0)
    }

    @Test func theLastKindStaysTickedAndFiltersResetThePage() {
        let model = NearbyModel(allowedTypes: [.pharmacy, .transit], defaultTypes: [.pharmacy])
        #expect(model.types == [.pharmacy])
        model.toggle(.pharmacy)
        #expect(model.types == [.pharmacy])
        #expect(model.keepOne)
        model.toggle(.transit)
        #expect(model.types == [.pharmacy, .transit])
        #expect(!model.keepOne)
        model.toggle(.pharmacy)
        #expect(model.types == [.transit])
        // ticking again keeps the allowed order, not the tap order
        model.toggle(.pharmacy)
        #expect(model.types == [.pharmacy, .transit])
        let key = model.taskKey(refresh: nil)
        model.choose(radius: .one)
        model.setStepFree(true)
        #expect(model.query.radiusKm == .one)
        #expect(model.query.accessible == .yes)
        #expect(model.taskKey(refresh: nil) != key)
    }

    @Test func showOnMapTogglesTheHighlight() async throws {
        let (api, _) = StubProtocol.client(reply: try reply("nearby"))
        let model = NearbyModel()
        await model.load(api: api)
        let second = model.visible[1]
        model.showOnMap(second)
        #expect(model.selectedId == second.id)
        #expect(model.number(of: second.id) == 2)
        model.showOnMap(second)
        #expect(model.selectedId == nil)
        model.selectMarker(second.id)
        #expect(model.selected?.id == second.id)
        #expect(model.band(of: model.visible[2]) == 4, "the far hospital is red")
    }

    @Test func refusedFiltersCannotBeRetriedButOtherFailuresCan() async throws {
        let (refused, _) = StubProtocol.client(reply: try reply("error-invalid-input", status: 422))
        let model = NearbyModel()
        await model.load(api: refused)
        #expect(model.failure?.canRetry == false)
        let (down, _) = StubProtocol.client(reply: StubProtocol.Reply(status: 503, body: Data("{}".utf8)))
        await model.load(api: down)
        #expect(model.failure?.canRetry == true)
        #expect(model.failure?.message == "The live workspace is not available yet. The demo remains available.")
    }

    @Test func theHomeSummaryLoadsOnlyOnceOpened() async throws {
        let (api, host) = StubProtocol.client(reply: try reply("care-access-home"))
        let home = NearbyHomeModel()
        await home.load(api: api, name: "Rosa")
        #expect(StubProtocol.requests(host: host).isEmpty)
        home.open(true)
        await home.load(api: api, name: "Rosa")
        let url = try #require(StubProtocol.requests(host: host).last?.request.url)
        #expect(url.query == "threshold=20")
        #expect(home.data?.area.id == "DNE")
        #expect(home.shortWindow == "15 min")
        #expect(!home.isFallback)
        home.choose(minutes: 30)
        #expect(home.taskKey.contains("30"))
    }

    @Test func aMissingHomeAreaSaysWhatToDo() async throws {
        let body = Data(#"{"error":{"code":"no_home_area"}}"#.utf8)
        let (api, _) = StubProtocol.client(reply: StubProtocol.Reply(status: 404, body: body))
        let home = NearbyHomeModel()
        home.open(true)
        await home.load(api: api, name: "Rosa")
        #expect(home.error?.hasPrefix("Rosa\u{2019}s community isn\u{2019}t in the Calgary community list") == true)
    }

    @Test func theExplorerFindsHerCommunityAndChoosesSensibly() async throws {
        let (api, _) = StubProtocol.client(reply: try reply("care-access-basemap"))
        let access = CareAccessModel()
        await access.loadBasemap(api: api, community: "DOWNTOWN EAST VILLAGE", hasRecipient: true)
        #expect(access.homeId == "DNE")
        #expect(access.shownId == "DNE")
        #expect(access.shapes.count == access.basemap?.areas.count)
        #expect(access.cityRegion != nil)
        #expect(access.query.threshold == 20)
        #expect(access.query.categories == AccessCategory.all)

        // her community's own point falls inside her community
        let home = try #require(access.shapes.first { $0.id == "DNE" })
        #expect(access.area(at: home.center) == "DNE")

        access.choose(mode: .proximity)
        #expect(access.threshold == 3)
        access.choose(threshold: 5)
        access.choose(mode: .unrecognized)
        #expect(access.mode == .proximity)

        for category in AccessCategory.all.dropFirst() { access.toggle(category) }
        #expect(access.categories == ["Pharmacy"])
        access.toggle("Pharmacy")
        #expect(access.categories == ["Pharmacy"])
        #expect(access.keepOne)
        access.toggle("Library")
        #expect(access.categories == ["Pharmacy", "Library"])
        access.select("BLN", name: "Rosa")
        #expect(access.shownId == "BLN")
        #expect(access.placesKey?.hasPrefix("BLN|proximity|5|Pharmacy,Library|false") == true)
    }

    @Test func scoresColourTheMapAndGoStaleWhenChoicesChange() async throws {
        let (mapAPI, _) = StubProtocol.client(reply: try reply("care-access-basemap"))
        let access = CareAccessModel()
        await access.loadBasemap(api: mapAPI, community: "DOWNTOWN EAST VILLAGE", hasRecipient: true)
        let scores = try Fixtures.decode(AccessScores.self, "care-access-scores")
        // the fixture was captured for its own query; answer with it for whatever is asked
        access.choose(threshold: scores.threshold)
        let (scoreAPI, _) = StubProtocol.client(reply: try reply("care-access-scores"))
        await access.loadScores(api: scoreAPI, name: "Rosa")
        #expect(access.scores != nil)
        #expect(!access.isStale)
        let shape = try #require(access.shapes.first { $0.id == scores.areas.first(where: { $0.score != nil })?.id })
        #expect(access.fillHex(for: shape) != nil)
        if let unscored = scores.areas.first(where: { $0.score == nil }), let unscoredShape = access.shapes.first(where: { $0.id == unscored.id }) {
            #expect(access.fillHex(for: unscoredShape) == nil)
        }
        #expect(access.rowText("DNE", name: "Rosa").hasPrefix("Downtown East Village, Rosa\u{2019}s community: "))
        access.colouring = .groups
        #expect(access.fillHex(for: shape) != nil)
        access.choose(threshold: 45)
        #expect(access.isStale)
    }
}
