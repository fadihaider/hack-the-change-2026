import Foundation

// nearby resources (live-api.ts) and the calgary care access explorer (components/app/access/access-data.ts)

nonisolated enum NearbyType: String, TolerantEnum {
    case pharmacy, clinic, hospital
    case publicHealth = "public_health"
    case socialSupport = "social_support"
    case communityCentre = "community_centre"
    case library, transit, unrecognized
    static var fallback: Self { .unrecognized }

    /// every type the server knows, in its order; never the fallback
    static let allCases: [NearbyType] = [
        .pharmacy, .clinic, .hospital, .publicHealth, .socialSupport, .communityCentre, .library, .transit,
    ]}

nonisolated enum HoursStatus: String, TolerantEnum {
    case open, closed, unknown
    static var fallback: Self { .unknown }
}

nonisolated enum Wheelchair: String, TolerantEnum {
    case yes, limited, no, unknown
    static var fallback: Self { .unknown }
}

/// the radii the nearby route accepts
nonisolated enum NearbyRadius: Int, Sendable, Hashable, CaseIterable {
    case one = 1, two = 2, three = 3, five = 5
}

/// the step-free filter for nearby resources
nonisolated enum NearbyAccessible: String, Sendable, Hashable, CaseIterable {
    case any, yes
}

nonisolated struct NearbyQuery: Sendable, Hashable {
    var types: [NearbyType]
    var radiusKm: NearbyRadius
    var accessible: NearbyAccessible
    var perType: Int?
    var address: String?

    init(
        types: [NearbyType], radiusKm: NearbyRadius, accessible: NearbyAccessible = .any,
        perType: Int? = nil, address: String? = nil
    ) {
        self.types = types
        self.radiusKm = radiusKm
        self.accessible = accessible
        self.perType = perType
        self.address = address
    }
}

/// [lon, lat]
nonisolated struct LonLat: Codable, Sendable, Hashable {
    var lon: Double
    var lat: Double

    init(lon: Double, lat: Double) {
        self.lon = lon
        self.lat = lat
    }

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        lon = try c.decode(Double.self)
        lat = try c.decode(Double.self)
        guard c.isAtEnd else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "a point has exactly two numbers")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(lon)
        try c.encode(lat)
    }
}

// GET /api/care-access/nearby
nonisolated struct NearbyResponse: Codable, Sendable, Hashable {
    var origin: NearbyOrigin
    var radiusKm: Double
    /// always "straight_line"
    var method: String
    var resources: [NearbyResource]
    /// city community boundaries inside the map bounds
    var outlines: [CommunityOutline]
    var bounds: MapBounds
    var counts: [NearbyCount]
    /// plain-language limits to show under the map
    var limits: [String]
}

nonisolated struct NearbyOrigin: Codable, Sendable, Hashable {
    var lat: Double
    var lon: Double
    /// e.g. "Rosa's home (approximate)"
    var label: String
    var community: String?
    var approximate: Bool
}

nonisolated struct NearbyResource: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var type: NearbyType
    var typeLabel: String
    /// the raw resource kind, e.g. "pharmacy", "doctors", "transit_stop"
    var kind: String
    var name: String
    var address: String?
    var lat: Double
    var lon: Double
    /// straight-line kilometres; never a drive or transit time
    var distanceKm: Double
    var withinRadius: Bool
    var phone: String?
    var hours: ResourceHours
    var wheelchair: Wheelchair
    var source: String
    var sourceUrl: String
    var license: String?
    var fetchedAt: String
}

nonisolated struct ResourceHours: Codable, Sendable, Hashable {
    var text: String?
    var status: HoursStatus
}

nonisolated struct CommunityOutline: Codable, Sendable, Hashable {
    var name: String
    var rings: [[LonLat]]
}

nonisolated struct MapBounds: Codable, Sendable, Hashable {
    var west: Double
    var south: Double
    var east: Double
    var north: Double
}

nonisolated struct NearbyCount: Codable, Sendable, Hashable {
    var type: NearbyType
    var label: String
    var shown: Int
    var withinRadius: Int
    /// the distance withinRadius was counted within; shorter for transit stops
    var withinKm: Double?
}

// ---- the care access explorer

nonisolated enum TravelMode: String, TolerantEnum {
    case driving, proximity, unrecognized
    static var fallback: Self { .unrecognized }
    /// only what the explorer sends (TravelMode in access-data.ts), so a picker never offers the fallback
    static let allCases: [TravelMode] = [.driving, .proximity]
}

nonisolated enum AccessMatch: String, TolerantEnum {
    case name, nearest, unrecognized
    static var fallback: Self { .unrecognized }
}

nonisolated enum AccessUnit: String, TolerantEnum {
    case minutes, km, unrecognized
    static var fallback: Self { .unrecognized }
}

/// the published service categories the scores count (SERVICE_CATEGORIES in lib/care-access/engine.ts)
nonisolated enum AccessCategory {
    static let all: [String] = [
        "Pharmacy", "Health Centre", "Hospital", "PHS Clinic", "Social Dev Ctr", "Community Centre", "Library",
    ]
    /// what the route uses when no category is given
    static let defaults: [String] = ["Pharmacy", "Health Centre"]
}

/// the explorer filters; categories are published names from AccessCategory.all
nonisolated struct AccessQuery: Sendable, Hashable {
    var mode: TravelMode
    var threshold: Double
    var categories: [String]
    var stepFree: Bool

    init(mode: TravelMode = .driving, threshold: Double = 15, categories: [String] = AccessCategory.defaults, stepFree: Bool = false) {
        self.mode = mode
        self.threshold = threshold
        self.categories = categories
        self.stepFree = stepFree
    }
}

// GET /api/care-access/home?threshold=
nonisolated struct HomeAccess: Codable, Sendable, Hashable {
    var area: AccessAreaRef
    var matchedBy: AccessMatch
    var mode: TravelMode
    var unit: AccessUnit
    var threshold: Double
    var requestedThreshold: Double?
    var fallbackReason: String?
    var score: Double?
    var counts: [String: Double]
    var nearest: [String: HomeNearest?]
    var resourcesWithin: Double
    var cluster: Double?
    var clusterProfile: ClusterProfile?
    var clusterSizes: [ClusterSize]
    var clusterBasis: String
    var routingCoverage: Double
    var limitations: [String]
    var scoreFormula: String
    var fetchedAt: String
}

nonisolated struct AccessAreaRef: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
}

nonisolated struct HomeNearest: Codable, Sendable, Hashable {
    var name: String
    var address: String
    var minutes: Double?
    var km: Double?
    var within: Bool
    var sourceUrl: String
    var source: String
    var modelCategory: String?
}

nonisolated struct ClusterProfile: Codable, Sendable, Hashable {
    var cluster: Double
    var areas: Double
    var typical: [ClusterTypical]
}

nonisolated struct ClusterTypical: Codable, Sendable, Hashable {
    var category: String
    var minutes: Double
    var mean: Double
}

nonisolated struct ClusterSize: Codable, Sendable, Hashable {
    var cluster: Double
    var areas: Double
}

nonisolated enum GeometryKind: String, TolerantEnum {
    case polygon = "Polygon"
    case multiPolygon = "MultiPolygon"
    case unrecognized
    static var fallback: Self { .unrecognized }
}

/// a geojson polygon or multipolygon, kept as polygons of rings of points.
/// zod only checks that coordinates is an array (access-data.ts), and the web map skips unusable points, so decoding
/// keeps the first two finite numbers of each position (an altitude is dropped) and skips anything else
nonisolated struct AreaGeometry: Codable, Sendable, Hashable {
    var type: GeometryKind
    /// every polygon as rings of [lon, lat]; a Polygon has one entry
    var polygons: [[[LonLat]]]

    private enum CodingKeys: String, CodingKey { case type, coordinates }

    init(type: GeometryKind, polygons: [[[LonLat]]]) {
        self.type = type
        self.polygons = polygons
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(GeometryKind.self, forKey: .type)
        let coordinates = try c.decode(JSONValue.self, forKey: .coordinates)
        guard case .array(let items) = coordinates else {
            throw DecodingError.dataCorruptedError(forKey: .coordinates, in: c, debugDescription: "coordinates is an array")
        }
        switch type {
        case .polygon: polygons = [Self.rings(items)]
        case .multiPolygon: polygons = items.map { Self.rings(Self.list($0)) }
        case .unrecognized: polygons = []
        }
    }

    private static func list(_ value: JSONValue) -> [JSONValue] {
        if case .array(let items) = value { return items }
        return []
    }

    /// usable() in access-data.ts: a point needs two finite numbers first
    private static func point(_ value: JSONValue) -> LonLat? {
        let items = list(value)
        guard items.count >= 2, case .number(let lon) = items[0], case .number(let lat) = items[1],
            lon.isFinite, lat.isFinite
        else { return nil }
        return LonLat(lon: lon, lat: lat)
    }

    private static func rings(_ items: [JSONValue]) -> [[LonLat]] {
        items.map { list($0).compactMap(point) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        if type == .polygon, let first = polygons.first {
            try c.encode(first, forKey: .coordinates)
        } else {
            try c.encode(polygons, forKey: .coordinates)
        }
    }
}

nonisolated struct BasemapArea: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var lat: Double
    var lon: Double
    var sector: String
    var geometry: AreaGeometry
}

nonisolated struct AccessProvenance: Codable, Sendable, Hashable {
    var fetchedAt: String
    var limitations: [String]
    var sources: [String: String]
    var licences: [String]?
}

nonisolated struct ClassificationResult: Codable, Sendable, Hashable {
    var model: String
    var heldoutAccuracy: Double
    var heldoutMacroF1: Double
    var labels: [String]?

    private enum CodingKeys: String, CodingKey {
        case model
        case heldoutAccuracy = "heldout_accuracy"
        case heldoutMacroF1 = "heldout_macro_f1"
        case labels
    }
}

nonisolated struct ClassificationReport: Codable, Sendable, Hashable {
    var selectedModel: String
    var results: [ClassificationResult]
    var testRows: Double?
    var trainRows: Double?
    var features: String?
    var labelSource: String?
    var limitations: [String]?

    private enum CodingKeys: String, CodingKey {
        case selectedModel = "selected_model"
        case results
        case testRows = "test_rows"
        case trainRows = "train_rows"
        case features
        case labelSource = "label_source"
        case limitations
    }
}

nonisolated struct ClusteringSelection: Codable, Sendable, Hashable {
    var algorithm: String
    var silhouette: Double
    var daviesBouldin: Double?
    var perturbationAri: Double
    var clusters: Double

    private enum CodingKeys: String, CodingKey {
        case algorithm, silhouette
        case daviesBouldin = "davies_bouldin"
        case perturbationAri = "perturbation_ari"
        case clusters
    }
}

nonisolated struct ClusterMeanProfile: Codable, Sendable, Hashable {
    var cluster: Double
    var areas: Double
    var meanCounts: [String: Double]

    private enum CodingKeys: String, CodingKey {
        case cluster, areas
        case meanCounts = "mean_counts"
    }
}

nonisolated struct ClusteringReport: Codable, Sendable, Hashable {
    var selected: ClusteringSelection
    var profiles: [ClusterMeanProfile]
    var accuracyReason: String
    var areas: Double?
    var features: [String]?

    private enum CodingKeys: String, CodingKey {
        case selected, profiles
        case accuracyReason = "accuracy_reason"
        case areas, features
    }
}

nonisolated struct AccessBenchmark: Codable, Sendable, Hashable {
    var classification: ClassificationReport
    var clustering: ClusteringReport
}

nonisolated struct ResourceTotals: Codable, Sendable, Hashable {
    var total: Double
    var stepFreeConfirmed: Double
}

nonisolated struct ExcludedCategory: Codable, Sendable, Hashable {
    var category: String
    var resources: Double
}

nonisolated struct InferenceStatus: Codable, Sendable, Hashable {
    /// nil when the page can't tell
    var configured: Bool?
}

// GET /api/care-access/basemap
nonisolated struct AccessBasemap: Codable, Sendable, Hashable {
    var areas: [BasemapArea]
    /// one per area, in area order
    var drivingCoverage: [Double]
    /// one per area, in area order
    var clusters: [Double?]
    var clusterSizes: [ClusterSize]
    var clusterBasis: String
    var scoreFormula: String
    var provenance: AccessProvenance
    var benchmark: AccessBenchmark
    /// places in the snapshot, and how many confirm step-free access
    var resources: ResourceTotals
    /// published types in the snapshot that no score counts
    var excludedCategories: [ExcludedCategory]
    var inference: InferenceStatus
}

nonisolated struct ScoreRow: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var score: Double?
    var counts: [String: Double]
    /// places in reach after the step-free filter
    var inReach: Double
    var unknownStepFree: Double
    var cluster: Double?
    var routingCoverage: Double
}

// GET /api/care-access?view=scores
nonisolated struct AccessScores: Codable, Sendable, Hashable {
    var mode: TravelMode
    var threshold: Double
    var categories: [String]
    var areas: [ScoreRow]
}

nonisolated struct AccessResource: Codable, Sendable, Hashable, Identifiable {
    var id: String
    var name: String
    var category: String
    var modelCategory: String?
    var address: String
    var sourceUrl: String
    var source: String
    var wheelchair: Bool?
    var hours: String?
}

nonisolated struct AccessPlace: Codable, Sendable, Hashable {
    var resource: AccessResource
    /// minutes when driving, kilometres for proximity
    var cost: Double
}

nonisolated struct AreaPlaces: Codable, Sendable, Hashable {
    var area: AccessAreaRef
    var resources: [AccessPlace]
}

// GET /api/care-access?area=ID
nonisolated struct AccessAreaPlaces: Codable, Sendable, Hashable {
    /// exactly one entry
    var areas: [AreaPlaces]
}
