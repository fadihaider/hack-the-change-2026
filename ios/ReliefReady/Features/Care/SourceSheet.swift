import SwiftUI

/// what the source sheet shows: the fact's words and where they came from (SourceSheet.tsx)
nonisolated struct SourceRequest: Sendable, Hashable, Identifiable {
    var id: String
    var sourceId: String?
    var textExact: String
    var spanStart: Double?
    var spanEnd: Double?

    init(fact: CareFact) {
        id = fact.id
        sourceId = fact.sourceId
        textExact = fact.textExact
        spanStart = fact.spanStart
        spanEnd = fact.spanEnd
    }

    init(cited: CitedFact, fact: CareFact?) {
        id = cited.id
        sourceId = cited.sourceId ?? fact?.sourceId
        textExact = cited.textExact
        spanStart = fact?.spanStart
        spanEnd = fact?.spanEnd
    }

    /// the fields sourceParts reads
    var asFact: CareFact {
        CareFact(
            id: id, category: "", textExact: textExact, status: .approved, sourceId: sourceId, sourceKind: nil,
            spanStart: spanStart, spanEnd: spanEnd, conflictsWith: [], events: [], createdAt: ""
        )
    }
}

/// the full retained source behind one fact, as plain text, with the fact's own words marked
struct SourceSheet: View {
    @Environment(AppModel.self) private var app
    var request: SourceRequest
    var onClose: () -> Void
    @State private var source: CareSourceDetail?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SheetHeader(title: "Full source", closeLabel: "Close the full source", onClose: onClose)
                if request.sourceId == nil {
                    Text("This fact has no saved source to show.").font(.rrBody).foregroundStyle(Theme.muted)
                } else if let error {
                    ErrorNote(error) { Task { await load() } }
                } else if let source {
                    loaded(source)
                } else {
                    Text("Loading the full source\u{2026}").font(.rrBody).foregroundStyle(Theme.muted)
                }
            }
            .padding(Theme.gutter)
        }
        .rrSheet()
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("sheet.source")
        .task(id: request.sourceId) { await load() }
    }

    @ViewBuilder private func loaded(_ source: CareSourceDetail) -> some View {
        let parts = CareData.sourceParts(source.fullText, fact: request.asFact)
        let added = CareData.addedDay(source.createdAt).map { ", added \($0)" } ?? ""
        let author = CareData.authorName(source.author).map { " by \($0)" } ?? ""
        Text("\(Labels.source(source.kind))\(added)\(author)")
            .font(.rrLabel)
            .foregroundStyle(Theme.ink)
        NoteText(
            parts == nil
                ? "The fact\u{2019}s exact words couldn\u{2019}t be found in this source, so nothing is highlighted."
                : "The highlighted words are the fact in the passport.",
            alignment: .leading
        )
        Group {
            if let parts {
                Text(Self.marked(parts))
            } else {
                Text(source.fullText)
            }
        }
        .font(.rrBody)
        .foregroundStyle(Theme.ink)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.page, in: .rect(cornerRadius: Theme.radius))
        .accessibilityLabel(parts.map { "Source text. \($0.before) Start of the fact: \($0.match) End of the fact. \($0.after)" } ?? source.fullText)
        .accessibilityIdentifier("source.text")
    }

    /// the source with the fact's words on a teal highlight, like the web's <mark>
    static func marked(_ parts: CareData.SourceParts) -> AttributedString {
        var match = AttributedString(parts.match)
        match.backgroundColor = Theme.selection
        match.font = Fonts.figtree(16, weight: .semibold, relativeTo: .body)
        return AttributedString(parts.before) + match + AttributedString(parts.after)
    }

    private func load() async {
        guard let id = request.sourceId else { return }
        error = nil
        do {
            source = try await app.api.careSource(id: id)
            careAnnounce("Full source loaded.")
        } catch {
            self.error = error.userMessage
        }
    }
}
