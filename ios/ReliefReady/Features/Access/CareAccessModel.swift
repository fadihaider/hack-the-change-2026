import Foundation
import MapKit
import Observation
import SwiftUI

/// the state behind CareAccessView: the basemap (loaded once), the scores for the current choices, the shown
/// community's places, and the choices themselves (AccessMap.tsx)
@Observable
final class CareAccessModel {
    enum Colouring: String, Hashable {
        case access, groups
    }

    /// one community ready for the map: its polygons as coordinates and where its marker sits
    struct Shape: Identifiable {
        var id: String
        var index: Int
        var polygons: [[[CLLocationCoordinate2D]]]
        var center: CLLocationCoordinate2D
    }

    struct ScoreSet {
        var key: AccessQuery
        var rows: [String: ScoreRow]
    }

    struct PlaceSet {
        var key: String
        var list: [AccessPlace]
    }

    private(set) var basemap: AccessBasemap?
    private(set) var shapes: [Shape] = []
    private(set) var cityRegion: MKCoordinateRegion?
    private(set) var loadError: String?
    private(set) var scores: ScoreSet?
    private(set) var scoresFailed = false
    private(set) var places: PlaceSet?
    private(set) var placesFailedKey: String?

    private(set) var mode: TravelMode = .driving
    private(set) var threshold = AccessWords.defaultWindow(.driving)
    private(set) var categories: [String] = AccessCategory.all
    private(set) var stepFree = false
    private(set) var keepOne = false
    private(set) var selected: String?
    var colouring: Colouring = .access
    private(set) var homeId: String?

    private(set) var basemapAttempt = 0
    private(set) var scoresAttempt = 0
    private(set) var placesAttempt = 0
    /// after a filter change, the next scores are read out for the community on screen
    private var speakAfterChange = false

    var query: AccessQuery {
        AccessQuery(mode: mode, threshold: threshold, categories: categories, stepFree: stepFree)
    }

    private var queryKey: String {
        "\(mode.rawValue)|\(AccessWords.number(threshold))|\(categories.joined(separator: ","))|\(stepFree)"
    }

    // ---- loading

    var basemapKey: Int { basemapAttempt }

    func loadBasemap(api: APIClient, community: String?, hasRecipient: Bool) async {
        guard basemap == nil else { return }
        loadError = nil
        do {
            let map = try await api.careAccessBasemap()
            guard !Task.isCancelled else { return }
            apply(basemap: map)
        } catch {
            guard !Task.isCancelled else { return }
            loadError = "The Calgary map data didn\u{2019}t load. Check your connection, then try again."
            return
        }
        await findHome(api: api, community: community, hasRecipient: hasRecipient)
    }

    /// keeps the basemap and the shapes the map draws
    func apply(basemap map: AccessBasemap) {
        basemap = map
        shapes = map.areas.enumerated().map { index, area in
            Shape(
                id: area.id, index: index, polygons: AccessWords.polygons(area.geometry),
                center: CLLocationCoordinate2D(latitude: area.lat, longitude: area.lon)
            )
        }
        cityRegion = AccessWords.region(around: shapes.map(\.polygons))
    }

    /// the care recipient's community by name; when the name isn't in the list, the server matches her home point
    func findHome(api: APIClient, community: String?, hasRecipient: Bool) async {
        guard let basemap else { return }
        if let index = AccessWords.areaIndex(byName: basemap.areas, community: community) {
            homeId = basemap.areas[index].id
            return
        }
        guard hasRecipient else { return }
        // no home community: the map still works, with the first routed community chosen
        if let home = try? await api.careAccessHome(threshold: AccessWords.defaultWindow(.driving)) {
            homeId = home.area.id
        }
    }

    func retryBasemap() {
        basemapAttempt += 1
    }

    var scoresTaskKey: String {
        "\(basemap != nil)|\(queryKey)|\(scoresAttempt)"
    }

    /// scores for every community under the current choices; an older answer never replaces a newer one
    func loadScores(api: APIClient, name: String) async {
        guard basemap != nil else { return }
        let query = query
        scoresFailed = false
        do {
            let answer = try await api.careAccessScores(query)
            guard !Task.isCancelled, query == self.query else { return }
            scores = ScoreSet(key: query, rows: Dictionary(answer.areas.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }))
            if speakAfterChange, let shownId {
                speakAfterChange = false
                announce("Map updated. \(rowText(shownId, name: name))")
            }
        } catch {
            guard !Task.isCancelled else { return }
            scoresFailed = true
        }
    }

    func retryScores() {
        scoresAttempt += 1
    }

    var placesKey: String? {
        shownId.map { "\($0)|\(queryKey)" }
    }

    var placesTaskKey: String {
        "\(placesKey ?? "")|\(placesAttempt)"
    }

    /// the shown community's places for the current choices
    func loadPlaces(api: APIClient) async {
        guard basemap != nil, let shownId, let key = placesKey else { return }
        placesFailedKey = nil
        do {
            let answer = try await api.careAccessPlaces(query, areaId: shownId)
            guard !Task.isCancelled, key == placesKey else { return }
            places = PlaceSet(key: key, list: answer.areas.first?.resources ?? [])
        } catch {
            guard !Task.isCancelled, key == placesKey else { return }
            placesFailedKey = key
        }
    }

    func retryPlaces() {
        placesAttempt += 1
    }

    // ---- choices

    func choose(mode next: TravelMode) {
        guard next != mode, next.isKnown else { return }
        speakAfterChange = true
        mode = next
        threshold = AccessWords.defaultWindow(next)
    }

    func choose(threshold next: Double) {
        guard next != threshold else { return }
        speakAfterChange = true
        threshold = next
    }

    func isOn(_ category: String) -> Bool {
        categories.contains(category)
    }

    func toggle(_ category: String) {
        let on = !categories.contains(category)
        if !on && categories == [category] {
            keepOne = true
            announce("Keep at least one kind of place.")
            return
        }
        keepOne = false
        speakAfterChange = true
        categories = on
            ? AccessCategory.all.filter { $0 == category || categories.contains($0) }
            : categories.filter { $0 != category }
    }

    func setStepFree(_ on: Bool) {
        guard on != stepFree else { return }
        speakAfterChange = true
        stepFree = on
    }

    func select(_ id: String, name: String) {
        selected = id
        announce(rowText(id, name: name))
    }

    /// the community under a tapped point, if any
    func area(at coordinate: CLLocationCoordinate2D) -> String? {
        shapes.first { AccessWords.polygons($0.polygons, contain: coordinate) }?.id
    }

    // ---- what is shown

    private var firstRouted: String? {
        guard let basemap else { return nil }
        return basemap.areas.indices.first { basemap.drivingCoverage.indices.contains($0) && basemap.drivingCoverage[$0] == 1 }
            .map { basemap.areas[$0].id }
    }

    var shownId: String? {
        selected ?? homeId ?? firstRouted
    }

    var shownRow: ScoreRow? {
        shownId.flatMap { scores?.rows[$0] }
    }

    func area(_ id: String?) -> BasemapArea? {
        guard let id else { return nil }
        return basemap?.areas.first { $0.id == id }
    }

    var shownArea: BasemapArea? { area(shownId) }
    var homeArea: BasemapArea? { area(homeId) }

    /// the map keeps the last answer, dimmed, until the scores for the new choices arrive
    var isStale: Bool {
        guard let scores else { return false }
        return scores.key != query
    }

    var shownPlaces: [AccessPlace]? {
        guard let places, places.key == placesKey else { return nil }
        return places.list
    }

    var placesFailed: Bool {
        placesFailedKey != nil && placesFailedKey == placesKey
    }

    var sizes: [ClusterSize] { basemap?.clusterSizes ?? [] }

    var groups: [Int: AccessWords.GroupName] { AccessWords.groupNames(sizes) }

    var labels: Set<String>? {
        basemap.flatMap { AccessWords.classifierLabels($0.benchmark.classification) }
    }

    var sortedAreas: [BasemapArea] {
        (basemap?.areas ?? []).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func cluster(at index: Int) -> Int? {
        guard let basemap, basemap.clusters.indices.contains(index), let value = basemap.clusters[index] else { return nil }
        return Int(value)
    }

    var unroutedCount: Int {
        basemap?.drivingCoverage.filter { $0 != 1 }.count ?? 0
    }

    var ungroupedCount: Int {
        basemap?.clusters.filter { $0 == nil || ($0 ?? 0) < 0 }.count ?? 0
    }

    var groupSize: Int {
        guard let cluster = shownRow?.cluster else { return 0 }
        return Int(sizes.first { $0.cluster == cluster }?.areas ?? 0)
    }

    /// the colour of one community on the map; nil is the "no score" or "no group" pattern
    func fillHex(for shape: Shape) -> UInt32? {
        switch colouring {
        case .groups:
            guard let cluster = cluster(at: shape.index), cluster >= 0 else { return nil }
            return AccessWords.groupHex(cluster)
        case .access:
            guard let score = scores?.rows[shape.id]?.score else { return nil }
            return AccessWords.scoreHex(score)
        }
    }

    func rowText(_ id: String, name: String) -> String {
        guard let row = scores?.rows[id], let area = area(id) else { return "" }
        return AccessWords.rowText(area: area.name, row: row, isHome: id == homeId, name: name)
    }

    /// what VoiceOver reads for a community in the current colouring
    func label(for shape: Shape, name: String) -> String {
        guard let area = basemap?.areas[shape.index] else { return "" }
        if colouring == .groups {
            return AccessWords.groupRowText(
                area: area.name, cluster: cluster(at: shape.index), isHome: shape.id == homeId, name: name, groups: groups
            )
        }
        return rowText(shape.id, name: name)
    }

    private func announce(_ text: String) {
        guard !text.isEmpty else { return }
        AccessibilityNotification.Announcement(text).post()
    }
}
