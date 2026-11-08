import SwiftUI

/// folded under the nearby cards: the drive-time summary from the public Calgary access snapshot, with counts and
/// the closest of each kind from the community's centre, the access group in plain words, and sources (NearRosa.tsx)
struct NearbyHomeSummary: View {
    @Environment(AppModel.self) private var model
    @State private var home = NearbyHomeModel()
    var name: String
    var recipientCommunity: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { home.open(!home.isOpen) }
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("How close is care by car\(community.map { " from \($0)" } ?? "")?")
                            .font(.rrBodyMedium)
                            .foregroundStyle(Theme.ink)
                        Text("Drive times from the community\u{2019}s centre, from the Calgary access snapshot")
                            .font(.rrNote)
                            .foregroundStyle(Theme.muted)
                    }
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.muted)
                        .rotationEffect(.degrees(home.isOpen ? 180 : 0))
                        .accessibilityHidden(true)
                }
                .padding(16)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(home.isOpen ? "Expanded" : "Collapsed")
            .accessibilityHint(home.isOpen ? "Double-tap to fold it away." : "Double-tap to open it.")
            .accessibilityIdentifier("nearby.home.toggle")

            if home.isOpen {
                Divider().overlay(Theme.hairline)
                content
                    .padding(16)
                    .transition(.opacity)
            }
        }
        .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
        }
        .task(id: home.taskKey) { await home.load(api: model.api, name: name) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("nearby.home")
    }

    /// the community in title case: from the answer, else from the session
    private var community: String? {
        if let area = home.data?.area.name { return area }
        return recipientCommunity.flatMap { $0.isEmpty ? nil : AccessWords.placeName($0) }
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What\u{2019}s within \(home.shownWindow) of \(community.map { "the centre of \($0)" } ?? "\(Labels.possessive(name)) community")?")
                .font(.rrHeadline)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)

            if !home.isFallback {
                VStack(alignment: .leading, spacing: 8) {
                    AccessFieldLabel("Drive time")
                    AccessSegments(
                        label: "Drive time", values: AccessWords.driveChoices, selection: home.minutes,
                        title: { "\(AccessWords.number($0)) min" },
                        identifier: { "nearby.home.drive.\(AccessWords.number($0))" },
                        onSelect: { home.choose(minutes: $0) }
                    )
                }
            }

            if let error = home.error {
                ErrorNote(error) { home.retry() }
            } else if let data = home.data {
                details(data)
                    .opacity(home.isStale ? 0.55 : 1)
            } else {
                AccessStatePanel(text: "Finding care places near \(name)")
                    .accessibilityIdentifier("nearby.home.loading")
            }
        }
    }

    private func details(_ data: HomeAccess) -> some View {
        let mode = data.mode
        let how = mode == .driving ? "by car" : "in a straight line"
        return VStack(alignment: .leading, spacing: 12) {
            if home.isFallback, data.fallbackReason != nil {
                AccessNotice("Driving routes for \(data.area.name) weren\u{2019}t fully mapped, so this counts places within \(AccessWords.number(data.threshold)) km in a straight line instead. Real trips are longer.")
            }
            Text(AccessWords.summaryOf(data))
                .font(.rrBody)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("nearby.home.summary")

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(AccessCategory.all.enumerated()), id: \.element) { index, category in
                    let count = Int(data.counts[category] ?? 0)
                    let closest = data.nearest[category] ?? nil
                    let cost = closest.flatMap { $0.minutes ?? $0.km }
                    if index > 0 { Divider().overlay(Theme.hairline) }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(AccessWords.kindTitle(category))
                                .font(.rrBodyMedium)
                                .foregroundStyle(Theme.ink)
                            Spacer(minLength: 8)
                            Text("\(Text(count == 0 ? "None" : "\(count)").bold()) within \(home.shortWindow)")
                                .font(.rrNote.monospacedDigit())
                                .foregroundStyle(Theme.ink)
                        }
                        if let closest, let cost {
                            Text("\(closest.within ? "Closest: " : "Closest, outside this window: ")\(Text(closest.name).fontWeight(.semibold)), \(AccessWords.costText(cost, mode: mode)) \(how)")
                                .font(.rrNote)
                                .foregroundStyle(Theme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(closest.address)
                                .font(.rrNote)
                                .foregroundStyle(Theme.muted)
                        } else {
                            Text("No \(AccessWords.kindWord(category, count: 2)) with a known \(mode == .driving ? "drive time" : "distance").")
                                .font(.rrNote)
                                .foregroundStyle(Theme.muted)
                        }
                    }
                    .padding(.vertical, 10)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("nearby.home.kind.\(category)")
                }
            }

            Text("\(Text("Access group: ").fontWeight(.semibold))\(AccessWords.groupLine(data))")
                .font(.rrNote)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)

            AccessHint("Counted from a central point in \(data.area.name), not \(Labels.possessive(name)) door, \(mode == .driving ? "by car with no traffic" : "in a straight line"). Opening hours, step-free access and whether a place can see \(name) today aren\u{2019}t known, so call ahead. Transit isn\u{2019}t routed, so no transit times are shown.")
            AccessHint("This summary uses the Calgary access snapshot, a different list from the places above, so the counts can differ.")

            Text(accessParts: sourceParts(data))
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("nearby.home.sources")
        }
    }

    private func sourceParts(_ data: HomeAccess) -> [AccessLinkPart] {
        let sources = AccessWords.uniqueSources(data)
        var parts: [AccessLinkPart] = [.plain("Snapshot sources: ")]
        for (index, source) in sources.enumerated() {
            if index > 0 { parts.append(.plain(index == sources.count - 1 ? " and " : ", ")) }
            parts.append(.link(source.name, source.url))
            if let via = source.via { parts.append(.plain(via)) }
        }
        parts.append(.plain(". Prepared \(AccessWords.fetchedOn(data.fetchedAt))."))
        return parts
    }
}
