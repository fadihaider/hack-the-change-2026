import MapKit
import SwiftUI

/// every Calgary community from the basemap, coloured by the access score or by the two unordered access groups.
/// tap a community to see its details; the Community button above the map is the list alternative (AccessMap.tsx)
struct CommunityMap: View {
    var access: CareAccessModel
    var name: String
    var onSelect: (String) -> Void

    @State private var position: MapCameraPosition = .automatic
    @ScaledMetric(relativeTo: .body) private var mapHeight: CGFloat = 420

    /// a neutral grey for a community with no score or no group, clearly apart from the lightest teal
    static let unknownFill = Color(hex: 0xC9CED7)

    var body: some View {
        MapReader { proxy in
            Map(position: $position, interactionModes: []) {
                ForEach(access.shapes) { shape in
                    let hex = access.fillHex(for: shape)
                    ForEach(Array(shape.polygons.enumerated()), id: \.offset) { _, rings in
                        if let outer = rings.first {
                            MapPolygon(polygon(outer: outer, holes: Array(rings.dropFirst())))
                                .foregroundStyle(hex.map { Color(hex: $0, opacity: 0.86) } ?? Self.unknownFill.opacity(0.75))
                                .stroke(Color.white, lineWidth: 0.8)
                        }
                    }
                }

                // her community's outline, then the one shown in the details on top
                if let home = shape(access.homeId) {
                    outline(home, color: Theme.ink, width: 2, dash: [5, 3])
                }
                if let shown = shape(access.shownId) {
                    outline(shown, color: Color.white, width: 6)
                    outline(shown, color: Theme.ink, width: 3)
                }
                if let home = shape(access.homeId) {
                    Annotation("", coordinate: home.center, anchor: .center) {
                        Circle()
                            .fill(.white)
                            .frame(width: 18, height: 18)
                            .overlay { Circle().strokeBorder(Theme.ink, lineWidth: 2.5) }
                            .accessibilityHidden(true)
                    }
                    .annotationTitles(.hidden)
                }
            }
            .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
            .mapControls { MapScaleView() }
            .onTapGesture { point in
                guard let coordinate = proxy.convert(point, from: .local), let id = access.area(at: coordinate) else { return }
                onSelect(id)
            }
        }
        .frame(height: min(mapHeight, 600))
        .clipShape(.rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
        }
        .opacity(access.isStale ? 0.55 : 1)
        .onAppear { if let region = access.cityRegion { position = .region(region) } }
        .onChange(of: access.shapes.count) { if let region = access.cityRegion { position = .region(region) } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mapLabel)
        .accessibilityValue(shownValue)
        .accessibilityHint("Swipe up or down to move through the communities. The Community button above lists them all.")
        .accessibilityAdjustableAction { direction in
            step(direction == .increment ? 1 : -1)
        }
        .accessibilityIdentifier("access.map")
    }

    private var mapLabel: String {
        "Map of \(access.basemap?.areas.count ?? 0) Calgary communities, coloured by \(access.colouring == .access ? "access" : "access group")"
    }

    private var shownValue: String {
        guard let shown = shape(access.shownId) else { return "" }
        return access.label(for: shown, name: name)
    }

    /// the next or previous community by name, for VoiceOver's adjustable action
    private func step(_ offset: Int) {
        let list = access.sortedAreas
        guard !list.isEmpty else { return }
        let current = list.firstIndex { $0.id == access.shownId } ?? 0
        let next = (current + offset + list.count) % list.count
        onSelect(list[next].id)
    }

    private func shape(_ id: String?) -> CareAccessModel.Shape? {
        guard let id else { return nil }
        return access.shapes.first { $0.id == id }
    }

    private func polygon(outer: [CLLocationCoordinate2D], holes: [[CLLocationCoordinate2D]]) -> MKPolygon {
        let interiors = holes.map { MKPolygon(coordinates: $0, count: $0.count) }
        return MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: interiors.isEmpty ? nil : interiors)
    }

    @MapContentBuilder
    private func outline(_ shape: CareAccessModel.Shape, color: Color, width: CGFloat, dash: [CGFloat] = []) -> some MapContent {
        ForEach(Array(shape.polygons.enumerated()), id: \.offset) { _, rings in
            if let outer = rings.first {
                MapPolyline(coordinates: outer + [outer[0]])
                    .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: dash))
            }
        }
    }
}

/// what the map's colours mean, under the map
struct CommunityMapKey: View {
    var access: CareAccessModel
    var name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if access.colouring == .access {
                Text("Access, out of 100")
                    .font(.rrLabel)
                    .foregroundStyle(Theme.ink)
                AccessFlowLayout(spacing: 14, lineSpacing: 6) {
                    ForEach(Array(AccessWords.scoreSteps.enumerated()), id: \.offset) { _, step in
                        keyItem(swatch: Color(hex: step.hex), text: "\(step.from) to \(step.to)")
                    }
                    if access.mode == .driving && access.unroutedCount > 0 {
                        keyItem(swatch: nil, text: "Not scored (\(access.unroutedCount))")
                    }
                }
                AccessHint(
                    "Darker means more of the places you picked are within reach."
                        + (access.mode == .driving && access.unroutedCount > 0
                            ? " Grey means the driving routes weren\u{2019}t fully mapped, not that access is low."
                            : "")
                )
            } else {
                Text("Access groups")
                    .font(.rrLabel)
                    .foregroundStyle(Theme.ink)
                AccessFlowLayout(spacing: 14, lineSpacing: 6) {
                    ForEach(access.sizes, id: \.cluster) { size in
                        keyItem(
                            swatch: Color(hex: AccessWords.groupHex(Int(size.cluster))),
                            text: "\(access.groups[Int(size.cluster)]?.label ?? "Group"), \(AccessWords.number(size.areas)) communities"
                        )
                    }
                    if access.ungroupedCount > 0 {
                        keyItem(swatch: nil, text: "No group (\(access.ungroupedCount))")
                    }
                }
                AccessHint("The groups were made once, from counts of pharmacies within 20 minutes and other places within 30 minutes by car. The choices above don\u{2019}t change them, and neither group is better. Grey communities had incomplete driving routes.")
            }

            VStack(alignment: .leading, spacing: 6) {
                if let home = access.homeArea {
                    HStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 3)
                            .strokeBorder(Theme.ink, style: StrokeStyle(lineWidth: 2, dash: [4, 2]))
                            .frame(width: 18, height: 14)
                            .accessibilityHidden(true)
                        Text("\(AccessWords.possessive(name)) community, \(home.name)")
                    }
                }
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 3)
                        .strokeBorder(Theme.ink, lineWidth: 3)
                        .frame(width: 18, height: 14)
                        .accessibilityHidden(true)
                    Text("The community shown in the details")
                }
            }
            .font(.rrNote)
            .foregroundStyle(Theme.ink)

            Text(accessParts: [
                .plain("Boundaries: "), .link("City of Calgary", URL(string: "https://data.calgary.ca/d/surr-xmvs")),
                .plain(". Routing: "), .link("OpenStreetMap contributors", AccessWords.osmCopyright),
                .plain(" ("), .link("ODbL", URL(string: "https://opendatacommons.org/licenses/odbl/")),
                .plain(") via "), .link("OSRM", URL(string: "https://project-osrm.org/")), .plain("."),
            ])
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("access.key")
    }

    private func keyItem(swatch: Color?, text: String) -> some View {
        HStack(spacing: 8) {
            Group {
                if let swatch {
                    RoundedRectangle(cornerRadius: 4).fill(swatch)
                } else {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(CommunityMap.unknownFill)
                }
            }
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
            Text(text)
                .font(.rrNote.monospacedDigit())
                .foregroundStyle(Theme.ink)
        }
        .accessibilityElement(children: .combine)
    }
}
