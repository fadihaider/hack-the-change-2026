import SwiftUI

/// Care access map: the Calgary explorer from More. owns GET /api/care-access/home, /basemap, and
/// /api/care-access?view=scores and ?area=ID (mode, threshold, categories and step-free filters). ports
/// components/app/access/AccessMap.tsx, AccessDetail.tsx and HowThisWorks.tsx
struct CareAccessView: View {
    @Environment(AppModel.self) private var model
    @State private var access = CareAccessModel()
    @State private var isPickingCommunity = false

    init() {}

    private var name: String { model.careRecipientName }

    var body: some View {
        ScreenColumn {
            QuestionHeader(
                "How do other Calgary communities compare?",
                lead: access.homeArea.map { "\(name) lives in \($0.name)." }
            )
            .padding(.bottom, -14)
            .accessibilityIdentifier("access.question")
            Text("Each community is measured from one central point, using public lists of care places. Pick what matters to you, then choose a community on the map or from the list to see what\u{2019}s close.")
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)

            content
        }
        .screenTitle("Care access")
        .task(id: access.basemapKey) {
            await access.loadBasemap(
                api: model.api, community: model.session?.careRecipient?.community,
                hasRecipient: model.session?.careRecipient != nil
            )
        }
        .task(id: access.scoresTaskKey) { await access.loadScores(api: model.api, name: name) }
        .task(id: access.placesTaskKey) { await access.loadPlaces(api: model.api) }
        .sheet(isPresented: $isPickingCommunity) {
            AccessCommunityPicker(access: access, name: name) { id in
                isPickingCommunity = false
                access.select(id, name: name)
            }
        }
        .toolbar {
            #if DEBUG
                if NearbyHarnessView.isEnabled {
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink("Near Rosa") { NearbyHarnessView() }
                            .accessibilityIdentifier("access.harness.nearby")
                    }
                }
            #endif
        }
        .accessibilityIdentifier("screen.careAccess")
    }

    @ViewBuilder private var content: some View {
        if let basemap = access.basemap, access.scores != nil {
            controls
            mapPane
            detail
            AccessHowItWorks(basemap: basemap)
                .padding(.top, 8)
        } else if let error = access.loadError {
            ErrorNote(error) { access.retryBasemap() }
                .accessibilityIdentifier("access.loadError")
        } else if access.scoresFailed {
            ErrorNote("The Calgary access scores didn\u{2019}t load. Check your connection, then try again.") {
                access.retryScores()
            }
            .accessibilityIdentifier("access.scoresError")
        } else {
            LoadingView("Loading the Calgary map")
                .frame(minHeight: 240)
                .accessibilityIdentifier("access.loading")
        }
    }

    // ---- what to measure

    private var controls: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                AccessFieldLabel("How to measure")
                AccessSegments(
                    label: "How to measure", values: ["driving", "proximity", "transit"],
                    selection: access.mode.rawValue,
                    title: { ["driving": "Driving", "proximity": "Distance", "transit": "Transit"][$0] ?? $0 },
                    identifier: { "access.mode.\($0)" },
                    isEnabled: { $0 != "transit" },
                    onSelect: { value in
                        if let mode = TravelMode(rawValue: value), mode.isKnown { access.choose(mode: mode) }
                    }
                )
                AccessHint(
                    (access.mode == .driving
                        ? "Drive times along roads, with no traffic." : "Straight-line distance. Real trips are longer.")
                        + " Transit isn\u{2019}t available: there\u{2019}s no timetable routing, so no times are guessed."
                )
            }

            VStack(alignment: .leading, spacing: 8) {
                AccessFieldLabel(access.mode == .driving ? "Drive time" : "Distance")
                AccessSegments(
                    label: access.mode == .driving ? "Drive time" : "Distance", values: AccessWords.windows(access.mode),
                    selection: access.threshold,
                    title: { "\(AccessWords.number($0)) \(access.mode == .driving ? "min" : "km")" },
                    identifier: { "access.window.\(AccessWords.number($0))" },
                    onSelect: { access.choose(threshold: $0) }
                )
            }

            VStack(alignment: .leading, spacing: 4) {
                AccessFieldLabel("Kinds of place")
                ForEach(AccessCategory.all, id: \.self) { category in
                    AccessCheckRow(title: AccessWords.kindTitle(category), isOn: access.isOn(category)) {
                        access.toggle(category)
                    }
                    .accessibilityIdentifier("access.kind.\(category)")
                }
                if access.keepOne {
                    AccessHint("Keep at least one kind of place, so there\u{2019}s something to count.")
                        .accessibilityIdentifier("access.keepOne")
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Toggle(isOn: Binding(get: { access.stepFree }, set: { access.setStepFree($0) })) {
                    Text("Only places with confirmed step-free access")
                        .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .tint(Theme.teal)
                .frame(minHeight: 44)
                .accessibilityIdentifier("access.stepFree")
                if access.stepFree {
                    AccessNotice(
                        ((access.basemap?.resources.stepFreeConfirmed ?? 0) == 0
                            ? "None of the source lists confirm step-free access, so every place is left out and the counts drop to zero."
                            : "Places without confirmed step-free access are left out.")
                            + " Unknown isn\u{2019}t the same as not accessible."
                    )
                    .accessibilityIdentifier("access.stepFreeNotice")
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                AccessFieldLabel("Community")
                Button {
                    isPickingCommunity = true
                } label: {
                    HStack {
                        Text(communityTitle)
                            .font(.rrBody)
                            .foregroundStyle(Theme.ink)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.muted)
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 48)
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.fieldBorder, lineWidth: 1)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Community")
                .accessibilityValue(communityTitle)
                .accessibilityHint("Opens the list of Calgary communities")
                .accessibilityIdentifier("access.community")
            }

            AccessHint("Not a measure of medical quality, eligibility or whether a place is open today.")
        }
        .accessFilterPanel(on: Theme.surface)
    }

    private var communityTitle: String {
        guard let area = access.shownArea else { return "Choose a community" }
        return area.id == access.homeId ? "\(area.name) (\(AccessWords.possessive(name)))" : area.name
    }

    // ---- the map

    private var mapPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(access.colouring == .access ? "Access across Calgary" : "Access groups across Calgary")
                .font(.rrTitle)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("access.mapTitle")

            VStack(alignment: .leading, spacing: 6) {
                Text("Colour the map by")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
                AccessSegments(
                    label: "Colour the map by", values: [CareAccessModel.Colouring.access, .groups],
                    selection: access.colouring,
                    title: { $0 == .access ? "Access" : "Access groups" },
                    identifier: { "access.view.\($0.rawValue)" },
                    onSelect: { access.colouring = $0 }
                )
            }

            if access.scoresFailed {
                ErrorNote("The map didn\u{2019}t update for your latest choices, so it still shows the last ones.") {
                    access.retryScores()
                }
            }

            CommunityMap(access: access, name: name) { id in
                access.select(id, name: name)
            }

            CommunityMapKey(access: access, name: name)
        }
        .padding(.top, 8)
    }

    // ---- the chosen community

    @ViewBuilder private var detail: some View {
        if let area = access.shownArea, let row = access.shownRow {
            AccessDetailView(
                area: area, row: row, places: access.shownPlaces, placesFailed: access.placesFailed,
                onRetryPlaces: { access.retryPlaces() }, labels: access.labels, groupSize: access.groupSize,
                mode: access.mode, threshold: access.threshold, categories: access.categories,
                stepFree: access.stepFree, isHome: area.id == access.homeId, name: name, groups: access.groups
            )
            .padding(16)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
            }
            .opacity(access.isStale ? 0.55 : 1)
        }
    }
}

/// every community by name, searchable; the list alternative to the map (the web's community select)
struct AccessCommunityPicker: View {
    var access: CareAccessModel
    var name: String
    var onChoose: (String) -> Void
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss

    private var areas: [BasemapArea] {
        let all = access.sortedAreas
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return all }
        return all.filter { $0.name.localizedStandardContains(needle) }
    }

    var body: some View {
        NavigationStack {
            List(areas) { area in
                Button {
                    onChoose(area.id)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(area.id == access.homeId ? "\(area.name) (\(AccessWords.possessive(name)))" : area.name)
                                .font(.rrBody)
                                .foregroundStyle(Theme.ink)
                            if let row = access.scores?.rows[area.id] {
                                Text(row.score.map { "Access \(AccessWords.number($0)) out of 100" } ?? "Not scored")
                                    .font(.rrNote)
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer()
                        if area.id == access.shownId {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Theme.teal)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(area.id == access.shownId ? .isSelected : [])
                .accessibilityIdentifier("access.picker.\(area.id)")
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search communities")
            .navigationTitle("Community")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .accessibilityIdentifier("access.picker.close")
                }
            }
        }
        .accessibilityIdentifier("screen.communityPicker")
    }
}
