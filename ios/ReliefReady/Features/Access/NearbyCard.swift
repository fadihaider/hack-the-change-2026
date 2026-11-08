import SwiftUI

/// one place: what it is, how far in a straight line, its listed hours and access (or Unknown), and its source
/// (ResourceCard in NearbyResourcesAndMap.tsx)
struct NearbyCard: View {
    var resource: NearbyResource
    /// the same number as its marker on the map
    var number: Int
    /// the marker's distance colour step, so the number badge matches its marker
    var band: Int
    var isSelected: Bool
    var onShow: () -> Void

    var body: some View {
        let hours = NearbyWords.hoursText(resource.hours)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                NearbyNumberBadge(number: number, band: band, isSelected: isSelected)
                Text(resource.name)
                    .font(.rrHeadline)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("\(number). \(resource.name)")
                    .accessibilityAddTraits(.isHeader)
            }

            Text(meta)
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text(address)
                .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                fact("Hours") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(hours.text)
                        if let status = hours.status {
                            TonePill(status, tone: resource.hours.status == .open ? .good : .plain)
                        }
                    }
                }
                fact("Step-free") { Text(NearbyWords.wheelchairText(resource.wheelchair)) }
                if let phone = resource.phone, !phone.isEmpty {
                    fact("Phone") {
                        if let tel = NearbyWords.telURL(phone) {
                            Link(phone, destination: tel)
                                .foregroundStyle(Theme.tealInk)
                                .underline()
                                .frame(minHeight: 44, alignment: .leading)
                                .accessibilityLabel("Call \(resource.name), \(phone)")
                                .accessibilityIdentifier("nearby.card.\(number).phone")
                        } else {
                            Text(phone)
                        }
                    }
                }
            }
            .padding(.top, 4)

            Text(accessParts: sourceParts)
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .tint(Theme.tealInk)
                .accessibilityIdentifier("nearby.card.\(number).source")

            Button(action: onShow) {
                HStack(spacing: 6) {
                    Image(systemName: isSelected ? "mappin.circle.fill" : "mappin.circle")
                        .accessibilityHidden(true)
                    Text("Show on map")
                }
                .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                .foregroundStyle(isSelected ? Theme.surface : Theme.tealInk)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(isSelected ? Theme.tealInk : Theme.tealTint, in: .rect(cornerRadius: Theme.radiusSmall))
                .contentShape(.rect(cornerRadius: Theme.radiusSmall))
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
            .accessibilityLabel("Show on map, marker \(number)")
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("nearby.card.\(number).show")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(isSelected ? Theme.teal : Theme.hairline, lineWidth: isSelected ? 2 : 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("nearby.card.\(number)")
    }

    private var meta: String {
        let outside = resource.withinRadius ? "" : ", outside the chosen distance"
        return "\(NearbyWords.typeText(resource)) \u{00B7} \(NearbyWords.distanceText(resource.distanceKm))\(outside)"
    }

    private var address: String {
        let trimmed = resource.address?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Address unknown" : trimmed
    }

    private var sourceParts: [AccessLinkPart] {
        var parts: [AccessLinkPart] = [.plain("Source: "), .link(resource.source, Labels.safeURL(resource.sourceUrl))]
        if let checked = NearbyWords.checkedOn(resource.fetchedAt) {
            parts.append(.plain(", fetched \(checked)."))
        } else {
            parts.append(.plain("."))
        }
        if let license = resource.license, !license.isEmpty { parts.append(.plain(" Licence: \(license).")) }
        return parts
    }

    private func fact<Value: View>(_ term: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(term)
                .font(Fonts.figtree(14, weight: .semibold, relativeTo: .footnote))
                .foregroundStyle(Theme.muted)
                .frame(minWidth: 78, alignment: .leading)
            value()
                .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

/// the round number shared by a card and its marker, in its distance colour; a dark ring when selected
struct NearbyNumberBadge: View {
    var number: Int
    var band: Int
    var isSelected: Bool
    var side: CGFloat = 28
    @ScaledMetric(relativeTo: .caption) private var scale: CGFloat = 1

    var body: some View {
        let size = side * min(scale, 1.6)
        Text("\(number)")
            .font(.system(size: 13 * min(scale, 1.6), weight: .bold).monospacedDigit())
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(hex: AccessWords.bandHexes[min(max(band, 0), AccessWords.bandHexes.count - 1)]), in: .circle)
            .overlay {
                if isSelected {
                    Circle().strokeBorder(Theme.surface, lineWidth: 2)
                    Circle().stroke(Theme.ink, lineWidth: 2).padding(-2)
                }
            }
            .accessibilityHidden(true)
    }
}
