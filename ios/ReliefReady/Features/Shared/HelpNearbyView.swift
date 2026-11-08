import SwiftUI
import UIKit

/// Help nearby: the tenure question ("90 days or more?") and the GET /api/guide cards (leave rules, EI,
/// supports, nearest hospital, pharmacy, stops) with their sources. used inside Urgent and Recover.
struct HelpNearbyView: View {
    @Environment(AppModel.self) private var model
    /// a typed address; nil uses the care recipient's saved address on the server
    var address: String?

    init(address: String? = nil) {
        self.address = address
    }

    var body: some View {
        HelpNearbySection(api: model.api, address: address, appNow: model.session?.appNow)
            .id(model.config.baseURL.absoluteString)
    }
}

/// the help list for one server
struct HelpNearbySection: View {
    @State private var help: HelpNearbyModel
    @AccessibilityFocusState private var headingFocused: Bool
    private let address: String?
    private let appNow: String?

    init(api: any UrgentAPI, address: String?, appNow: String?) {
        self.address = address
        self.appNow = appNow
        _help = State(initialValue: HelpNearbyModel(api: api, address: address))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Help nearby")
                .font(.rrTitle)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($headingFocused)
                .accessibilityIdentifier("help.title")
            Text(help.leadLine)
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)

            if help.guide == nil && help.loading {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.teal)
                    Text("Finding help nearby").font(.rrCallout).foregroundStyle(Theme.muted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("help.loading")
            }

            if let error = help.error {
                VStack(alignment: .leading, spacing: 12) {
                    if help.locationProblem {
                        ErrorNote(error)
                        addressForm
                    } else {
                        ErrorNote(error) { help.retry() }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("help.error")
            }

            if let guide = help.guide {
                groups(guide)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("section.helpNearby")
        .task(id: "\(help.query)|\(help.tenure.rawValue)|\(help.attempt)|\(appNow ?? "")") {
            await help.load()
            if help.refocus {
                help.refocus = false
                headingFocused = true
            }
        }
        .onChange(of: address) { _, next in help.address = next }
    }

    private var addressForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Calgary address").font(.rrLabel).foregroundStyle(Theme.ink)
            TextField("Calgary address", text: $help.draft, prompt: Text("800 3 St SE"))
                .font(.rrBody)
                .textContentType(.fullStreetAddress)
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                .overlay { RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.fieldBorder, lineWidth: 1) }
                .onChange(of: help.draft) { _, value in
                    if value.count > HelpNearbyModel.addressMax { help.draft = String(value.prefix(HelpNearbyModel.addressMax)) }
                }
                .onSubmit { help.lookUp() }
                .accessibilityLabel("Calgary address")
                .accessibilityIdentifier("help.address")
            UrgentButton(
                title: "Find help near this address", kind: .secondary, isBusy: help.loading, busyTitle: "Looking it up",
                identifier: "help.lookUp"
            ) { help.lookUp() }
        }
    }

    @ViewBuilder private func groups(_ guide: GuideResponse) -> some View {
        let grouped = HelpNearbyModel.group(guide.cards)
        let community = HelpNearbyModel.placeName(guide.location.community)

        if !grouped.near.isEmpty {
            section(community.isEmpty ? "Close by" : "Close to \(community)", identifier: "help.group.near") {
                if help.typedAddress {
                    Text("From public Calgary lists. Distances are straight lines from the address you entered, not travel times. Transit isn\u{2019}t routed.")
                        .font(.rrNote).foregroundStyle(Theme.muted)
                }
                cardList(grouped.near)
            }
        }

        section("Time off and income", identifier: "help.group.work") {
            tenureQuestion
            if !grouped.work.isEmpty { cardList(grouped.work) }
        }

        if !grouped.support.isEmpty {
            let shown = help.allSupports ? grouped.support : Array(grouped.support.prefix(HelpNearbyModel.supportsShown))
            let hidden = grouped.support.count - shown.count
            section("Support for you", identifier: "help.group.support") {
                cardList(shown)
                if hidden > 0 {
                    UrgentButton(title: "Show \(hidden) more", kind: .quiet, identifier: "help.showMore") {
                        help.allSupports = true
                    }
                }
            }
        }

        if !grouped.other.isEmpty {
            section("More help", identifier: "help.group.other") { cardList(grouped.other) }
        }

        if HelpNearbyModel.usesOSM(guide.cards), let url = Labels.safeURL(guide.attribution.url) {
            HStack(spacing: 4) {
                Text("Map data").font(.rrNote).foregroundStyle(Theme.muted)
                Link(guide.attribution.text, destination: url)
                    .font(.rrNote)
                    .foregroundStyle(Theme.tealInk)
                    .accessibilityIdentifier("help.attribution")
            }
        }
    }

    private func section<Content: View>(_ title: String, identifier: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            GroupTitle(title)
            content()
        }
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var tenureQuestion: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Have you worked at your job for 90 days or more?")
                .font(.rrBodyMedium)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            ChoiceRow {
                ForEach(Tenure.allCases, id: \.self) { choice in
                    tenureButton(choice)
                }
            }
            Text(help.tenureHint)
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("help.tenureHint")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("help.tenure")
    }

    private func tenureButton(_ choice: Tenure) -> some View {
        let on = help.tenure == choice
        return Button {
            help.chooseTenure(choice)
        } label: {
            Text(HelpNearbyModel.tenureLabel(choice))
                .font(.rrButtonSecondary)
                .foregroundStyle(on ? Color.white : Theme.ink)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 12)
                .background(on ? Theme.teal : Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(on ? Theme.teal : Theme.hairline, lineWidth: 1)
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(HelpNearbyModel.tenureLabel(choice))
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("help.tenure.\(choice.rawValue)")
    }

    private func cardList(_ cards: [GuideCard]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(cards) { HelpCardView(card: $0) }
        }
    }
}

/// one help card: what it is, its details and links, and where it came from
struct HelpCardView: View {
    var card: GuideCard

    private static let icons: [String: String] = [
        "leave": "briefcase", "ei": "building.columns", "support": "hands.and.sparkles",
        "hospital": "cross.case", "pharmacy": "pills", "transit": "bus",
    ]

    var body: some View {
        let links = card.links.compactMap { link in Labels.safeURL(link.url).map { (label: link.label, url: $0) } }
        let source = Labels.safeURL(card.sourceUrl)
        // the source name links only when no card link already points at the same page
        let sourceURL = source.flatMap { url in links.contains { $0.url == url } ? nil : url }
        Card {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: Self.icons[card.kind] ?? "mappin")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Theme.teal)
                    .frame(width: 34, height: 34)
                    .background(Theme.tealTint, in: .rect(cornerRadius: Theme.radiusSmall))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(card.title)
                        .font(.rrHeadline)
                        .foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(card.body).font(.rrBody).foregroundStyle(Theme.ink)
                    if !card.details.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(card.details.enumerated()), id: \.offset) { _, detail in
                                detailRow(detail)
                            }
                        }
                    }
                    if let notice = card.draftNotice { EmployerNotice(text: notice) }
                    ForEach(Array(links.enumerated()), id: \.offset) { _, link in
                        Link(destination: link.url) {
                            HStack(spacing: 4) {
                                Text(link.label)
                                Image(systemName: "arrow.up.right.square").accessibilityHidden(true)
                            }
                            .font(.rrBodyMedium)
                            .foregroundStyle(Theme.tealInk)
                            .frame(minHeight: 44, alignment: .leading)
                        }
                        .accessibilityLabel("\(link.label), opens in Safari")
                        .accessibilityIdentifier("help.link.\(card.id)")
                    }
                    sourceLine(sourceURL)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("help.card.\(card.kind)")
    }

    @ViewBuilder private func detailRow(_ detail: GuideDetail) -> some View {
        let digits = detail.value.filter { $0.isNumber || $0 == "+" }
        let phone = detail.label.lowercased() == "phone" && digits.wholeMatch(of: /\+?\d{3,15}/) != nil
        // label above value, so long labels and values never squeeze into columns
        VStack(alignment: .leading, spacing: 0) {
            Text(detail.label).font(.rrLabel).foregroundStyle(Theme.muted)
            if phone, let url = URL(string: "tel:\(digits)") {
                Link(detail.value, destination: url)
                    .font(.rrBody)
                    .foregroundStyle(Theme.tealInk)
                    .accessibilityLabel("Call \(detail.value)")
                    .accessibilityIdentifier("help.call")
            } else {
                Text(detail.value).font(.rrBody).foregroundStyle(Theme.ink)
            }
        }
    }

    private func sourceLine(_ url: URL?) -> some View {
        let checked = HelpNearbyModel.checkedOn(card.fetchedAt)
        let tail = (checked.map { ", checked \($0)." } ?? ".") + (card.license.map { " Licence: \($0)." } ?? "")
        // one run of text, the source name a link inside it when it has a page of its own
        var line = AttributedString("Source: ")
        var name = AttributedString(card.source)
        if let url {
            name.link = url
            name.foregroundColor = Theme.tealInk
            name.underlineStyle = .single
        }
        line.append(name)
        line.append(AttributedString(tail))
        return Text(line)
            .tint(Theme.tealInk)
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .accessibilityIdentifier("help.source")
    }
}

/// a short notice for the employer, with a copy button
struct EmployerNotice: View {
    var text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("A short notice for your employer. It shares no health details.")
                .font(.rrNote).foregroundStyle(Theme.muted)
            Text(text)
                .font(.rrBody)
                .foregroundStyle(Theme.ink)
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.page, in: .rect(cornerRadius: Theme.radiusSmall))
            UrgentButton(
                title: copied ? "Copied" : "Copy the notice", kind: .secondary, systemImage: "doc.on.doc",
                identifier: "help.copyNotice"
            ) {
                UIPasteboard.general.string = text
                copied = true
                AccessibilityNotification.Announcement("Copied the notice.").post()
            }
        }
    }
}
