import Foundation
import Observation
import SwiftUI

/// the state behind NearbySection: filters, the last answer from GET /api/care-access/nearby, the selected card and
/// how many cards show (NearbyResourcesAndMap.tsx)
@Observable
final class NearbyModel {
    /// cards shown before "Show N more"; markers follow the visible cards
    static let initialVisible = 6
    /// places asked for per kind
    static let perType = 4
    /// the cards on care start with every kind except transit stops, which stay one tick away
    static let careDefaultTypes: [NearbyType] = NearbyType.allCases.filter { $0 != .transit }

    struct Failure: Equatable {
        var message: String
        /// a 422 means the filters were refused, so trying the same again cannot help
        var canRetry: Bool
    }

    let allowedTypes: [NearbyType]
    private(set) var types: [NearbyType]
    private(set) var radius: NearbyRadius
    private(set) var stepFree = false
    private(set) var data: NearbyResponse?
    private(set) var failure: Failure?
    private(set) var isLoading = true
    private(set) var selectedId: String?
    private(set) var visibleCount = NearbyModel.initialVisible
    /// "Keep at least one kind of place." shows after trying to untick the last kind
    private(set) var keepOne = false
    /// bumps on retry so the loading task runs again
    private(set) var attempt = 0
    /// the next answer is read out, because someone changed a filter
    private var speak = false
    private var sequence = 0

    init(allowedTypes: [NearbyType] = NearbyType.allCases, defaultTypes: [NearbyType]? = nil, radius: NearbyRadius = .three) {
        self.allowedTypes = allowedTypes
        let first = (defaultTypes ?? allowedTypes.filter { $0 != .transit }).filter { allowedTypes.contains($0) }
        self.types = first.isEmpty ? allowedTypes : first
        self.radius = radius
    }

    var query: NearbyQuery {
        NearbyQuery(types: types, radiusKm: radius, accessible: stepFree ? .yes : .any, perType: Self.perType)
    }

    /// what the loading task depends on
    func taskKey(refresh: String?) -> String {
        "\(types.map(\.rawValue).joined(separator: ","))|\(radius.rawValue)|\(stepFree)|\(attempt)|\(refresh ?? "")"
    }

    // ---- loading

    /// asks the server for the current filters; an older answer never replaces a newer one
    func load(api: APIClient) async {
        sequence += 1
        let mine = sequence
        isLoading = true
        let query = query
        do {
            let next = try await api.nearby(query)
            guard mine == sequence, !Task.isCancelled else { return }
            data = next
            failure = nil
            if let selectedId, !next.resources.contains(where: { $0.id == selectedId }) { self.selectedId = nil }
            if speak {
                announce(
                    next.resources.isEmpty
                        ? NearbyWords.emptyText(
                            types: query.types, radiusKm: Double(query.radiusKm.rawValue), stepFreeOnly: stepFree,
                            counts: next.counts
                        )
                        : NearbyWords.summaryText(next, stepFreeOnly: stepFree)
                )
            }
        } catch {
            guard mine == sequence, !Task.isCancelled else { return }
            failure = Failure(message: error.userMessage, canRetry: error.status != 422)
            if speak { announce(error.userMessage) }
        }
        isLoading = false
        speak = false
    }

    func retry() {
        speak = true
        attempt += 1
    }

    // ---- filters

    private func changed() {
        speak = true
        visibleCount = Self.initialVisible
    }

    func isOn(_ type: NearbyType) -> Bool {
        types.contains(type)
    }

    /// ticks or unticks a kind; the last kind stays ticked
    func toggle(_ type: NearbyType) {
        let on = !types.contains(type)
        if !on && types == [type] {
            keepOne = true
            announce("Keep at least one kind of place.")
            return
        }
        keepOne = false
        changed()
        types = on ? allowedTypes.filter { $0 == type || types.contains($0) } : types.filter { $0 != type }
    }

    func choose(radius next: NearbyRadius) {
        guard next != radius else { return }
        changed()
        radius = next
    }

    func setStepFree(_ on: Bool) {
        guard on != stepFree else { return }
        changed()
        stepFree = on
    }

    // ---- cards and markers

    var ordered: [NearbyResource] {
        NearbyWords.orderResources(data?.resources ?? [])
    }

    /// the first page always holds the closest of each kind
    var shownCount: Int {
        max(visibleCount, NearbyWords.firstPageSize(ordered, initialVisible: Self.initialVisible))
    }

    var visible: [NearbyResource] {
        Array(ordered.prefix(shownCount))
    }

    var hiddenCount: Int {
        max(0, ordered.count - visible.count)
    }

    var nextBatch: Int {
        min(hiddenCount, Self.initialVisible)
    }

    var isStale: Bool {
        isLoading && data != nil
    }

    func number(of id: String) -> Int? {
        visible.firstIndex { $0.id == id }.map { $0 + 1 }
    }

    func band(of resource: NearbyResource) -> Int {
        NearbyWords.distanceBand(resource.distanceKm, radiusKm: data?.radiusKm ?? 0, withinRadius: resource.withinRadius)
    }

    var selected: NearbyResource? {
        guard let selectedId else { return nil }
        return visible.first { $0.id == selectedId }
    }

    /// a card's "Show on map": highlight its marker, or clear it when it is already highlighted
    func showOnMap(_ resource: NearbyResource) {
        if selectedId == resource.id {
            selectedId = nil
            announce("Map highlight cleared.")
            return
        }
        selectedId = resource.id
        announce("Showing \(number(of: resource.id).map(String.init) ?? ""). \(resource.name) on the map.")
    }

    /// a marker: highlight it
    func selectMarker(_ id: String) {
        selectedId = id
    }

    /// shows the next batch; returns the id of the first new card so focus can move there
    @discardableResult
    func showMore() -> String? {
        let firstNew = ordered.indices.contains(shownCount) ? ordered[shownCount].id : nil
        let batch = nextBatch
        visibleCount = shownCount + Self.initialVisible
        announce("Showing \(batch) more \(batch == 1 ? "place" : "places") in the list and on the map.")
        return firstNew
    }

    private func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }
}

/// the folded drive-time summary under the nearby cards (GET /api/care-access/home in NearRosa.tsx)
@Observable
final class NearbyHomeModel {
    private(set) var minutes = AccessWords.defaultMinutes
    private(set) var data: HomeAccess?
    private(set) var error: String?
    private(set) var isLoading = false
    /// the summary is only asked for once someone opens it
    var isOpen = false
    private(set) var opened = false
    private(set) var attempt = 0
    private var speak = false
    private var sequence = 0

    var taskKey: String {
        "\(opened)|\(AccessWords.number(minutes))|\(attempt)"
    }

    func open(_ on: Bool) {
        isOpen = on
        if on { opened = true }
    }

    func load(api: APIClient, name: String) async {
        guard opened else { return }
        sequence += 1
        let mine = sequence
        isLoading = true
        do {
            let next = try await api.careAccessHome(threshold: minutes)
            guard mine == sequence, !Task.isCancelled else { return }
            data = next
            error = nil
            if speak { AccessibilityNotification.Announcement(AccessWords.summaryOf(next)).post() }
        } catch {
            guard mine == sequence, !Task.isCancelled else { return }
            let message = error.homeMessage(name: name)
            self.error = message
            if speak { AccessibilityNotification.Announcement(message).post() }
        }
        isLoading = false
        speak = false
    }

    func choose(minutes next: Double) {
        guard next != minutes else { return }
        speak = true
        minutes = next
    }

    func retry() {
        speak = true
        attempt += 1
    }

    var mode: TravelMode {
        data?.mode ?? .driving
    }

    /// driving routes weren't fully mapped, so the server counted a straight-line distance instead
    var isFallback: Bool {
        data?.mode == .proximity
    }

    var isStale: Bool {
        isLoading && data != nil
    }

    /// "a 20-minute drive", or "3 km" on the fallback
    var shownWindow: String {
        if isFallback, let data { return AccessWords.windowText(data.threshold, mode: .proximity) }
        return AccessWords.windowText(minutes, mode: .driving)
    }

    /// "20 min" or "3 km"
    var shortWindow: String {
        mode == .driving
            ? "\(AccessWords.number(data?.threshold ?? minutes)) min" : "\(AccessWords.number(data?.threshold ?? 3)) km"
    }
}
