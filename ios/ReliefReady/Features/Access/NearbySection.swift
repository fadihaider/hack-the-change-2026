import SwiftUI

/// Near Rosa: the embeddable nearby section for Care, built on GET /api/care-access/nearby (type and radius
/// filters, the inline map with community outlines, straight-line distances and the limits under the map), then the
/// folded GET /api/care-access/home summary (NearRosa.tsx and NearbyResourcesAndMap.tsx)
struct NearbySection: View {
    @Environment(AppModel.self) private var model
    @State private var nearby = NearbyModel(defaultTypes: NearbyModel.careDefaultTypes)

    init() {}

    var body: some View {
        if let recipient = model.session?.careRecipient {
            ScrollViewReader { proxy in
                Card {
                    Text("Near \(model.careRecipientName) \u{2014} real Calgary help")
                        .font(.rrTitle)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("nearby.title")

                    places(proxy: proxy)
                        .padding(.top, 6)

                    NavigationLink {
                        CareAccessView()
                    } label: {
                        Text("Explore all Calgary access")
                    }
                    .buttonStyle(.secondary)
                    .padding(.top, 8)
                    .accessibilityHint("Compares care places in reach across Calgary communities")
                    .accessibilityIdentifier("nearby.explore")

                    NearbyHomeSummary(name: model.careRecipientName, recipientCommunity: recipient.community)
                        .padding(.top, 8)
                }
            }
            .task(id: nearby.taskKey(refresh: model.session?.appNow)) { await nearby.load(api: model.api) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("section.nearby")
        }
    }

    private var name: String { model.careRecipientName }

    @ViewBuilder private func places(proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Places near \(AccessWords.possessive(name)) home")
                .font(.rrHeadline)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            Text("From public Calgary lists. Distances are straight lines from near \(AccessWords.possessive(name)) home, not travel times. Transit isn\u{2019}t routed.")
                .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)

            filters
                .padding(.top, 16)

            results(proxy: proxy)
        }
    }

    // ---- filters

    private var filters: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                AccessFieldLabel("Kind of place")
                AccessFlowLayout {
                    ForEach(nearby.allowedTypes, id: \.self) { type in
                        AccessChip(title: NearbyWords.label(type), isOn: nearby.isOn(type)) {
                            nearby.toggle(type)
                        }
                        .accessibilityIdentifier("nearby.type.\(type.rawValue)")
                    }
                }
                if nearby.keepOne {
                    AccessHint("Keep at least one kind of place.")
                        .accessibilityIdentifier("nearby.keepOne")
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                AccessFieldLabel("Distance (straight line)")
                AccessSegments(
                    label: "Distance (straight line)", values: NearbyWords.radiusChoices, selection: nearby.radius,
                    title: { "\($0.rawValue) km" }, identifier: { "nearby.radius.\($0.rawValue)" },
                    onSelect: { nearby.choose(radius: $0) }
                )
            }

            VStack(alignment: .leading, spacing: 8) {
                Toggle(isOn: Binding(get: { nearby.stepFree }, set: { nearby.setStepFree($0) })) {
                    Text("Step-free confirmed only")
                        .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                        .foregroundStyle(Theme.ink)
                }
                .tint(Theme.teal)
                .frame(minHeight: 44)
                .accessibilityIdentifier("nearby.stepFree")
                if nearby.stepFree {
                    AccessNotice("Only places whose source lists wheelchair access are shown. Most sources don\u{2019}t say, and unknown isn\u{2019}t the same as not accessible.")
                }
            }
        }
        .accessFilterPanel()
    }

    // ---- cards, map and limits

    @ViewBuilder private func results(proxy: ScrollViewProxy) -> some View {
        if let failure = nearby.failure {
            ErrorNote(failure.message, onRetry: failure.canRetry ? { nearby.retry() } : nil)
                .padding(.top, 16)
                .accessibilityIdentifier("nearby.error")
        } else if let data = nearby.data {
            if nearby.ordered.isEmpty {
                AccessStatePanel(
                    text: NearbyWords.emptyText(
                        types: nearby.types, radiusKm: Double(nearby.radius.rawValue), stepFreeOnly: nearby.stepFree,
                        counts: data.counts
                    ),
                    isEmpty: true
                )
                .opacity(nearby.isStale ? 0.55 : 1)
                .padding(.top, 16)
                .accessibilityIdentifier("nearby.empty")
            } else {
                list(data, proxy: proxy)
                    .opacity(nearby.isStale ? 0.55 : 1)
            }
        } else {
            AccessStatePanel(text: "Finding places near \(name)")
                .padding(.top, 16)
                .accessibilityIdentifier("nearby.loading")
        }
    }

    private func list(_ data: NearbyResponse, proxy: ScrollViewProxy) -> some View {
        let visible = nearby.visible
        return VStack(alignment: .leading, spacing: 10) {
            Text("\(NearbyWords.summaryText(data, stepFreeOnly: nearby.stepFree)) The closest of each kind comes first.")
                .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
                .padding(.bottom, 2)
                .accessibilityIdentifier("nearby.summary")

            ForEach(Array(visible.enumerated()), id: \.element.id) { index, resource in
                NearbyCard(
                    resource: resource, number: index + 1, band: nearby.band(of: resource),
                    isSelected: resource.id == nearby.selectedId
                ) {
                    let wasSelected = resource.id == nearby.selectedId
                    nearby.showOnMap(resource)
                    if !wasSelected { scroll(proxy, to: "nearby.mapAnchor", anchor: .center) }
                }
                .id("nearby.card.\(resource.id)")
            }

            if nearby.hiddenCount > 0 {
                Button("Show \(nearby.nextBatch) more") {
                    if let first = nearby.showMore() { scroll(proxy, to: "nearby.card.\(first)", anchor: .top) }
                }
                .buttonStyle(.quiet)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("nearby.more")
            }

            NearbyMap(data: data, resources: visible, selectedId: nearby.selectedId) { id in
                nearby.selectMarker(id)
                scroll(proxy, to: "nearby.card.\(id)", anchor: .center)
            }
            .id("nearby.mapAnchor")
            .padding(.top, 6)

            if !data.limits.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(data.limits, id: \.self) { limit in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\u{2022}").accessibilityHidden(true)
                            Text(limit).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .padding(.top, 6)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("nearby.limits")
            }

            Text(accessParts: credits(visible))
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("nearby.credits")
        }
    }

    private func credits(_ visible: [NearbyResource]) -> [AccessLinkPart] {
        let usesOSM = visible.contains {
            "\($0.source) \($0.sourceUrl)".range(of: "openstreetmap", options: .caseInsensitive) != nil
        }
        var parts: [AccessLinkPart] = [.plain("Community outlines: City of Calgary.")]
        if usesOSM {
            parts += [
                .plain(" Place data "), .link("\u{00A9} OpenStreetMap contributors", AccessWords.osmCopyright),
                .plain(", ODbL."),
            ]
        }
        return parts
    }

    private func scroll(_ proxy: ScrollViewProxy, to id: String, anchor: UnitPoint) {
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        if reduceMotion {
            proxy.scrollTo(id, anchor: anchor)
        } else {
            withAnimation(.easeInOut(duration: 0.3)) { proxy.scrollTo(id, anchor: anchor) }
        }
    }
}
