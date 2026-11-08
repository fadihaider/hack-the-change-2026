import MapKit
import SwiftUI

/// the map under the nearby cards: city community outlines, the chosen straight-line distance, the approximate home
/// point, and one numbered marker per visible card, coloured green to red by straight-line distance. the map shows
/// home and the chosen distance; a place beyond it sits at the edge with an arrow toward it, and markers that would
/// overlap are moved apart with a line to their real spot, so every card keeps its own marker (ResourceMap.tsx).
/// the cards above are the list alternative
struct NearbyMap: View {
    var data: NearbyResponse
    /// the visible cards, in card order; marker n is card n
    var resources: [NearbyResource]
    var selectedId: String?
    var onSelect: (String) -> Void

    @State private var size = CGSize.zero
    @ScaledMetric(relativeTo: .body) private var mapHeight: CGFloat = 340
    /// the badge grows with Dynamic Type up to 1.6 times (NearbyNumberBadge), so the layout keeps that much apart
    @ScaledMetric(relativeTo: .caption) private var badgeScale: CGFloat = 1

    private struct Marker {
        var resource: NearbyResource
        var number: Int
        var placed: NearbyWords.PlacedMarker
        var at: CLLocationCoordinate2D
        var truth: CLLocationCoordinate2D
        var toward: String
    }

    private struct Layout {
        var region: MKCoordinateRegion
        var markers: [Marker]
        /// metres one point covers, for marks drawn in metres
        var metersPerPoint: Double
    }

    /// the fitted region and every marker's drawn spot for the map's current size
    private var layout: Layout? {
        guard let region = NearbyWords.mapRegion(origin: data.origin, radiusKm: data.radiusKm, resources: resources),
            size.width > 0, size.height > 0
        else { return nil }
        let projection = NearbyWords.ScreenProjection(region: region, width: size.width, height: size.height)
        let home = projection.point(lat: data.origin.lat, lon: data.origin.lon)
        let points = resources.map { projection.point(lat: $0.lat, lon: $0.lon) }
        let grow = Double(min(badgeScale, 1.6))
        var sizes = NearbyWords.MarkerSizes()
        sizes.markerR *= grow
        sizes.edge = sizes.markerR + 12
        let placed = NearbyWords.placeMarkers(points, home: home, width: size.width, height: size.height, sizes: sizes)
        let markers = resources.enumerated().map { index, resource in
            let spot = placed[index]
            return Marker(
                resource: resource, number: index + 1, placed: spot,
                at: projection.coordinate(NearbyWords.ScreenPoint(x: spot.x, y: spot.y)),
                truth: CLLocationCoordinate2D(latitude: resource.lat, longitude: resource.lon),
                toward: NearbyWords.compassText(dx: spot.trueX - home.x, dy: spot.trueY - home.y)
            )
        }
        return Layout(
            region: region, markers: markers, metersPerPoint: 111_320 * projection.cosLat / projection.scale
        )
    }

    var body: some View {
        let layout = layout
        let selected = layout?.markers.first { $0.resource.id == selectedId }
        VStack(alignment: .leading, spacing: 10) {
            map(layout)
                .frame(height: min(mapHeight, 520))
                .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
                .clipShape(.rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(mapLabel)
                .accessibilityIdentifier("nearby.map")

            Text(NearbyWords.mapCaption(
                number: selected?.number, resource: selected?.resource, marker: selected?.placed,
                toward: selected?.toward ?? ""
            ))
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityHidden(true)
            .accessibilityIdentifier("nearby.mapCaption")

            NearbyMapLegend(
                data: data,
                anyClamped: layout?.markers.contains { $0.placed.clamped } ?? false,
                anyMoved: layout?.markers.contains { $0.placed.moved } ?? false
            )
        }
    }

    @ViewBuilder private func map(_ layout: Layout?) -> some View {
        if let layout {
            Map(initialPosition: .region(layout.region), interactionModes: []) {
                ForEach(Array(data.outlines.enumerated()), id: \.offset) { _, outline in
                    let home = NearbyWords.isHomeOutline(outline, origin: data.origin)
                    ForEach(Array(outline.rings.enumerated()), id: \.offset) { _, ring in
                        if ring.count >= 3 {
                            MapPolygon(coordinates: ring.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) })
                                .foregroundStyle(home ? Theme.teal.opacity(0.10) : Color.white.opacity(0.0))
                                .stroke(home ? Theme.tealInk : Color(hex: 0x8A92A0).opacity(0.7), lineWidth: home ? 2 : 1)
                        }
                    }
                }

                MapCircle(
                    center: CLLocationCoordinate2D(latitude: data.origin.lat, longitude: data.origin.lon),
                    radius: data.radiusKm * 1000
                )
                .foregroundStyle(Theme.teal.opacity(0.06))
                .stroke(Theme.teal, style: StrokeStyle(lineWidth: 2, dash: [6, 5]))

                // a moved marker keeps a thin line back to its exact spot
                ForEach(layout.markers.filter(\.placed.moved), id: \.resource.id) { marker in
                    MapPolyline(coordinates: [marker.truth, marker.at])
                        .stroke(Theme.ink.opacity(0.7), lineWidth: 1.5)
                    // an overlay, not an annotation, so it always sits under the markers
                    MapCircle(center: marker.truth, radius: 3 * layout.metersPerPoint)
                        .foregroundStyle(Theme.ink)
                }

                // home under the markers; the layout keeps markers clear of it
                Annotation("", coordinate: CLLocationCoordinate2D(latitude: data.origin.lat, longitude: data.origin.lon), anchor: .center) {
                    NearbyHomeGlyph()
                        .accessibilityElement()
                        .accessibilityLabel(NearbyWords.originText(data.origin))
                        .accessibilityIdentifier("nearby.home")
                }
                .annotationTitles(.hidden)

                // the selected marker last so it sits on top, lower numbers above higher ones
                ForEach(paintOrder(layout.markers), id: \.resource.id) { marker in
                    Annotation("", coordinate: marker.at, anchor: .center) {
                        markerView(marker)
                    }
                    .annotationTitles(.hidden)
                }
            }
            .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
            .mapControls { MapScaleView() }
            .id("\(layout.region.center.latitude)|\(layout.region.center.longitude)|\(layout.region.span.latitudeDelta)")
        } else {
            Theme.page
        }
    }

    private func paintOrder(_ markers: [Marker]) -> [Marker] {
        markers.reversed().sorted { a, b in
            (a.resource.id == selectedId ? 1 : 0) < (b.resource.id == selectedId ? 1 : 0)
        }
    }

    private var mapLabel: String {
        let count = resources.count
        return "Map of the \(count == 1 ? "place" : "\(count) places") listed above, numbered as in the list, with a marker for \(NearbyWords.originText(data.origin)) and a \(AccessWords.number(data.radiusKm)) km straight-line circle. Choose a numbered marker to find it in the list."
    }

    private func markerView(_ marker: Marker) -> some View {
        let resource = marker.resource
        let isSelected = resource.id == selectedId
        let band = NearbyWords.distanceBand(resource.distanceKm, radiusKm: data.radiusKm, withinRadius: resource.withinRadius)
        return Button {
            onSelect(resource.id)
        } label: {
            ZStack {
                if marker.placed.clamped {
                    // an arrow on the rim, pointing at the place beyond the map
                    NearbyEdgeArrow()
                        .fill(isSelected ? Theme.ink : Theme.teal)
                        .stroke(Theme.surface, lineWidth: 1.5)
                        .frame(width: 46, height: 46)
                        .rotationEffect(.degrees(marker.placed.angle))
                }
                NearbyNumberBadge(number: marker.number, band: band, isSelected: isSelected, side: 26)
                    .overlay { Circle().strokeBorder(Color.white, lineWidth: 2) }
                    .shadow(color: Theme.ink.opacity(0.25), radius: 1.5, y: 1)
            }
            .frame(width: 44, height: 44)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(NearbyWords.markerLabel(
            number: marker.number, resource: resource, beyondToward: marker.placed.clamped ? marker.toward : nil
        ))
        .accessibilityHint("Shows its place in the list")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("nearby.marker.\(marker.number)")
    }
}

/// a small triangle on the east rim of its frame; rotate it to point elsewhere
nonisolated struct NearbyEdgeArrow: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let r = rect.width / 2
        path.move(to: CGPoint(x: rect.midX + r - 7, y: rect.midY - 5))
        path.addLine(to: CGPoint(x: rect.midX + r, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX + r - 7, y: rect.midY + 5))
        path.closeSubpath()
        return path
    }
}

/// the approximate home point: a house in a dark rounded square
struct NearbyHomeGlyph: View {
    var side: CGFloat = 24

    var body: some View {
        Image(systemName: "house.fill")
            .font(.system(size: side * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: side, height: side)
            .background(Theme.ink, in: .rect(cornerRadius: side * 0.24))
            .overlay {
                RoundedRectangle(cornerRadius: side * 0.24).strokeBorder(.white, lineWidth: 2)
            }
    }
}

/// what the map's marks mean
struct NearbyMapLegend: View {
    var data: NearbyResponse
    var anyClamped: Bool
    var anyMoved: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            item {
                Circle().fill(Theme.muted).frame(width: 16, height: 16)
            } text: {
                "A listed place, numbered as in the list"
            }
            item {
                HStack(spacing: 2) {
                    ForEach(AccessWords.bandHexes, id: \.self) { hex in
                        Circle().fill(Color(hex: hex)).frame(width: 12, height: 12)
                    }
                }
            } text: {
                NearbyWords.distanceScaleText(data.radiusKm)
            }
            item {
                NearbyHomeGlyph(side: 18)
            } text: {
                NearbyWords.originText(data.origin)
            }
            item {
                Circle()
                    .stroke(Theme.teal, style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
                    .frame(width: 15, height: 15)
            } text: {
                "\(AccessWords.number(data.radiusKm)) km in a straight line"
            }
            if anyClamped {
                item {
                    NearbyEdgeArrow()
                        .fill(Theme.teal)
                        .frame(width: 30, height: 16)
                        .offset(x: -8)
                } text: {
                    "An arrow at the edge points to a place beyond the map"
                }
            }
            if anyMoved {
                item {
                    Path { path in
                        path.move(to: CGPoint(x: 2, y: 14))
                        path.addLine(to: CGPoint(x: 15, y: 3))
                    }
                    .stroke(Theme.ink.opacity(0.7), lineWidth: 1.5)
                    .frame(width: 18, height: 18)
                } text: {
                    "A line leads from a moved marker to its exact spot"
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("nearby.legend")
    }

    private func item<Mark: View>(@ViewBuilder mark: () -> Mark, text: () -> String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            mark()
                .frame(minWidth: 70, alignment: .leading)
                .accessibilityHidden(true)
            Text(text())
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
