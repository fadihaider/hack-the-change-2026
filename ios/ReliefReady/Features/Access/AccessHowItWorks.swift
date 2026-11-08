import SwiftUI

/// how this works, in plain words: the score (a count, not machine learning), the service-type prediction from names
/// and its test results, the area access groups and what their internal checks do and don't mean, where the data
/// comes from, and what none of it can tell you. every number is read from the basemap (HowThisWorks.tsx)
struct AccessHowItWorks: View {
    var basemap: AccessBasemap

    var body: some View {
        let classification = basemap.benchmark.classification
        let clustering = basemap.benchmark.clustering
        let provenance = basemap.provenance
        let selected = classification.results.first { $0.model == classification.selectedModel }
        let results = classification.results.sorted { $0.heldoutMacroF1 > $1.heldoutMacroF1 }
        let labels = AccessWords.classifierLabels(classification)
        let untrained = labels.map { set in AccessCategory.all.filter { !set.contains($0) } } ?? []
        let communities = basemap.areas.count
        let unscored = basemap.drivingCoverage.filter { $0 != 1 }.count

        VStack(alignment: .leading, spacing: 14) {
            Text("How this works")
                .font(.rrTitle)
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("access.how")

            block("The access score (not machine learning)") {
                paragraph("The score is a plain count of how many listed places are within reach, not a prediction. For each kind of place you pick, a community gets full marks for 5 or more within the window you chose, and part marks below that. The score is the average across the kinds, from 0 to 100, and every kind counts the same. It doesn\u{2019}t rate care.")
                Text("As written in the data: \(basemap.scoreFormula)")
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.ink)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.page, in: .rect(cornerRadius: Theme.radiusSmall))
                    .fixedSize(horizontal: false, vertical: true)
                if unscored > 0 {
                    paragraph("\(unscored) of \(communities) communities have no driving score, because their driving routes weren\u{2019}t fully mapped. They\u{2019}re grey on the map. Distance still compares them in a straight line.")
                }
                paragraph("Transit isn\u{2019}t scored: there\u{2019}s no timetable routing, so no transit times are guessed.")
            }

            block("Service-type prediction from place names") {
                Text("Not a measure of care quality.")
                    .font(.rrNote.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                paragraph("Every place keeps the type its source published, and every count uses that published type. A \(classification.selectedModel) model reads only a place\u{2019}s name and predicts what type of service it is, shown as \u{201C}Type predicted from the name\u{201D} when it disagrees. It never changes a count."
                    + (untrained.isEmpty ? "" : " It only learned the national list\u{2019}s types, so it makes no prediction for \(AccessWords.joinWords(untrained.map { AccessWords.kindWord($0, count: 2) }))."))
                if let selected {
                    let tested = classification.testRows.map { "\(AccessWords.number($0)) facility names" } ?? "names"
                    paragraph("On \(tested) it hadn\u{2019}t seen, from a national list, it predicted the right service type \(AccessWords.percent(selected.heldoutAccuracy)) of the time (held-out accuracy), with a macro F1 of \(AccessWords.fixed3(selected.heldoutMacroF1)). Macro F1 averages how well each type is recognised, so rare types count as much as common ones. This isn\u{2019}t a Calgary-specific test.")
                }
                paragraph("The predictions were made once, when this data was prepared. \(AccessWords.liveText(basemap.inference.configured)) So this page uses the published types and those saved predictions.")
                modelTable(results, selected: classification.selectedModel)
            }

            block("Area access groups") {
                let grouped = clustering.areas.map { "\(AccessWords.number($0)) " } ?? ""
                let k = AccessWords.number(clustering.selected.clusters)
                paragraph("A \(clustering.selected.algorithm) model with k = \(k) sorted the \(grouped)communities with full driving routes into \(k) area access groups, by how many places of each kind are within 20 minutes (pharmacies) or 30 minutes (everything else) by car. It ran once; the map\u{2019}s choices don\u{2019}t change it. A group describes a community\u{2019}s access pattern, never a person\u{2019}s health.")
                paragraph("These are internal clustering checks, not accuracy:")
                bullets(
                    ["Silhouette \(AccessWords.fixed3(clustering.selected.silhouette)): how cleanly the groups separate, from \u{2212}1 to 1, where higher is cleaner."]
                        + (clustering.selected.daviesBouldin.map {
                            ["Davies-Bouldin \(AccessWords.fixed3($0)): how much the groups overlap, where lower is cleaner."]
                        } ?? [])
                        + ["Perturbation ARI \(AccessWords.fixed3(clustering.selected.perturbationAri)): whether the same groups come back when the scaled counts get a small random nudge (0.01 standard deviations) and the model is fitted again, where 1 means identical."]
                )
                paragraph("None of these says the groups are right, because there\u{2019}s no answer key to check them against. The groups have no order: one isn\u{2019}t better than the other.")
            }

            block("Where the data comes from") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(provenance.sources.keys.sorted(by: sourceOrder), id: \.self) { key in
                        let known = AccessWords.sourcePages[key]
                        Text(accessParts: [.plain("\u{2022} "), .link(known?.name ?? key, Labels.safeURL(known?.page ?? provenance.sources[key]))])
                    }
                    Text(accessParts: [
                        .plain("\u{2022} Drive times: "), .link("OSRM", URL(string: "https://project-osrm.org/")),
                        .plain(" on "), .link("OpenStreetMap", AccessWords.osmCopyright), .plain(" roads, with no live traffic"),
                    ])
                }
                .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                let licences = provenance.licences ?? []
                AccessHint("Fetched \(AccessWords.fetchedOn(provenance.fetchedAt)).\(licences.isEmpty ? "" : " Licences: \(licences.joined(separator: "; ")).")")
            }

            block("What this can\u{2019}t tell you") {
                bullets(
                    provenance.limitations.map { "\($0.hasSuffix(".") ? String($0.dropLast()) : $0)." }
                        + basemap.excludedCategories.map { item in
                            let count = Int(item.resources)
                            return "\(count) \(count == 1 ? "place is" : "places are") listed as \u{201C}\(item.category)\u{201D}, which isn\u{2019}t one of the \(AccessCategory.all.count) kinds above, so no score or list on this page counts them."
                        }
                        + ["It isn\u{2019}t a measure of medical quality, who is eligible, or whether a place is open or has room today."]
                )
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("access.howSection")
    }

    /// the order the snapshot lists its sources in: the national list, then the city's two
    private func sourceOrder(_ a: String, _ b: String) -> Bool {
        let order = ["odhf", "services", "communities"]
        return (order.firstIndex(of: a) ?? order.count, a) < (order.firstIndex(of: b) ?? order.count, b)
    }

    private func block<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.rrHeadline)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
        }
    }

    private func paragraph(_ text: String) -> some View {
        Text(text)
            .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func bullets(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items, id: \.self) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\u{2022}").accessibilityHidden(true)
                    Text(item).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
        .foregroundStyle(Theme.ink)
    }

    private func modelTable(_ results: [ClassificationResult], selected: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Models compared on the same held-out names")
                .font(.rrNote.weight(.semibold))
                .foregroundStyle(Theme.muted)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow {
                    Text("Model")
                    Text("Accuracy").gridColumnAlignment(.trailing)
                    Text("Macro F1").gridColumnAlignment(.trailing)
                }
                .font(.rrNote.weight(.semibold))
                .foregroundStyle(Theme.muted)
                .accessibilityElement(children: .ignore)
                Divider().overlay(Theme.hairline)
                ForEach(results, id: \.model) { result in
                    let chosen = result.model == selected
                    GridRow {
                        Text(chosen ? "\(result.model) (used here)" : result.model)
                            .fontWeight(chosen ? .semibold : .regular)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(AccessWords.percent(result.heldoutAccuracy)).monospacedDigit()
                        Text(AccessWords.fixed3(result.heldoutMacroF1)).monospacedDigit()
                    }
                    .font(.rrNote)
                    .foregroundStyle(Theme.ink)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(result.model)\(chosen ? ", used here" : ""): accuracy \(AccessWords.percent(result.heldoutAccuracy)), macro F1 \(AccessWords.fixed3(result.heldoutMacroF1))")
                }
            }
            .padding(12)
            .background(Theme.page, in: .rect(cornerRadius: Theme.radiusSmall))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("access.models")
    }
}
