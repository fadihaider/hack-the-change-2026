import SwiftUI

/// one community up close: its access metric in plain words, counts per kind, its access group, and the places behind
/// the numbers with their published category, the name-based type prediction when it differs, and a link to the
/// source (AccessDetail.tsx)
struct AccessDetailView: View {
    var area: BasemapArea
    var row: ScoreRow
    /// its places in reach, nearest first; nil while they load
    var places: [AccessPlace]?
    var placesFailed: Bool
    var onRetryPlaces: () -> Void
    var labels: Set<String>?
    var groupSize: Int
    var mode: TravelMode
    var threshold: Double
    var categories: [String]
    var stepFree: Bool
    var isHome: Bool
    var name: String
    var groups: [Int: AccessWords.GroupName]

    /// the first few places show at once; the rest wait behind one quiet button
    static let placesShown = 8
    @State private var showAll = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(area.name)
                    .font(.rrTitle)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("access.detail.title")
                if isHome {
                    TonePill("\(Labels.possessive(name)) community", tone: .ask)
                }
            }

            metric

            if row.score != nil {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(categories.enumerated()), id: \.element) { index, category in
                        if index > 0 { Divider().overlay(Theme.hairline) }
                        HStack {
                            Text(AccessWords.kindTitle(category))
                            Spacer()
                            Text(AccessWords.number(row.counts[category] ?? 0)).monospacedDigit().fontWeight(.semibold)
                        }
                        .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
                        .foregroundStyle(Theme.ink)
                        .padding(.vertical, 8)
                        .accessibilityElement(children: .combine)
                    }
                }
                .accessibilityIdentifier("access.detail.counts")
            }

            Text("\(Text("Access group: ").fontWeight(.semibold))\(groupText)")
                .font(.rrNote)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)

            if row.score != nil {
                placesBlock
            }
        }
        .onChange(of: "\(area.id)|\(mode.rawValue)|\(threshold)") { showAll = false }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("access.detail")
    }

    private var groupText: String {
        guard let cluster = row.cluster.map({ Int($0) }), cluster >= 0, let group = groups[cluster] else {
            return "none, because the driving routes weren\u{2019}t fully mapped."
        }
        return "\(area.name) is in \(group.phrase), with \(groupSize) communities. Groups put communities with similar counts together; neither one is better."
    }

    private var metric: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let score = row.score {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(AccessWords.number(score))
                        .font(Fonts.figtree(40, weight: .semibold, relativeTo: .largeTitle).monospacedDigit())
                    Text("out of 100")
                        .font(.rrBody)
                        .foregroundStyle(Theme.muted)
                }
                .foregroundStyle(Theme.ink)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Access \(AccessWords.number(score)) out of 100")
                .accessibilityIdentifier("access.detail.score")
            } else {
                Text("Not scored")
                    .font(Fonts.figtree(24, weight: .semibold, relativeTo: .title2))
                    .foregroundStyle(Theme.ink)
                    .accessibilityIdentifier("access.detail.score")
            }
            Text(AccessWords.metricText(area: area.name, score: row.score, categories: categories.count, mode: mode, threshold: threshold))
                .font(.rrNote)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .leading) {
            ZStack(alignment: .leading) {
                UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: Theme.radius, topTrailingRadius: Theme.radius)
                    .fill(Theme.page)
                Rectangle().fill(Theme.teal).frame(width: 3)
            }
        }
    }

    @ViewBuilder private var placesBlock: some View {
        let how = mode == .driving ? "by car" : "in a straight line"
        if placesFailed {
            ErrorNote("The places for \(area.name) didn\u{2019}t load.", onRetry: onRetryPlaces)
        } else if let places {
            let shown = showAll ? places : Array(places.prefix(Self.placesShown))
            let hidden = places.count - shown.count
            Text(places.isEmpty ? "No places in reach" : "\(places.count) \(places.count == 1 ? "place" : "places") in reach")
                .font(.rrHeadline)
                .foregroundStyle(Theme.ink)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("access.places.title")
            if places.isEmpty {
                AccessHint(
                    stepFree
                        ? "Nothing is left once places without confirmed step-free access are taken out."
                        : "Nothing you picked is within \(AccessWords.reachText(mode: mode, threshold: threshold)). Try a longer window or more kinds of place."
                )
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.element.resource.id) { index, place in
                        if index > 0 { Divider().overlay(Theme.hairline) }
                        placeRow(place, how: how)
                            .padding(.vertical, 10)
                            .accessibilityIdentifier("access.place.\(index)")
                    }
                }
                if hidden > 0 {
                    Button("Show \(hidden) more") { showAll = true }
                        .buttonStyle(.quiet)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("access.places.more")
                }
                AccessHint("Opening hours, step-free access and whether each place can see \(name) today aren\u{2019}t known for any of these. Call ahead.")
            }
        } else {
            AccessHint("Loading the places in reach")
                .accessibilityIdentifier("access.places.loading")
        }
    }

    private func placeRow(_ place: AccessPlace, how: String) -> some View {
        let resource = place.resource
        let suggestion = AccessWords.modelSuggestion(resource, labels: labels)
        return VStack(alignment: .leading, spacing: 3) {
            Text(resource.name)
                .font(.rrBodyMedium)
                .foregroundStyle(Theme.ink)
            Text("\(AccessWords.kindLabel(resource.category)), \(AccessWords.costText(place.cost, mode: mode)) \(how)")
                .font(.rrNote)
                .foregroundStyle(Theme.ink)
            Text(resource.address)
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
            if let suggestion {
                Text("Type predicted from the name: \(suggestion) (the published type is used)")
                    .font(.rrNote)
                    .foregroundStyle(Theme.warnInk)
            }
            Text(accessParts: [.plain("Source: "), .link(resource.source, Labels.safeURL(resource.sourceUrl))])
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}
