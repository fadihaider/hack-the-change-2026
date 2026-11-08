import SwiftUI

/// the ask bar's state: answers come only from approved facts (AskAboutRosa.tsx)
@Observable
final class AskModel {
    static let maxChars = 500

    struct Asked: Hashable {
        var key: Int
        var question: String
        var result: AskResponse
    }

    var question = ""
    private(set) var asked: Asked?
    private(set) var busy = false
    private(set) var error: String?
    private(set) var invalid = false
    @ObservationIgnored private var asks = 0

    /// POST /api/care/ask; true when the answer saved an open question, so the profile should reload
    func ask(_ api: APIClient) async -> Bool {
        guard !busy else { return false }
        let words = question.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty {
            invalid = true
            error = "Write a question first, for example: where are her glasses?"
            return false
        }
        if words.count > Self.maxChars {
            invalid = true
            error = "That question is longer than 500 characters. Shorten it, then ask again."
            return false
        }
        busy = true
        error = nil
        invalid = false
        defer { busy = false }
        do {
            let result = try await api.ask(question: words)
            asks += 1
            asked = Asked(key: asks, question: words, result: result)
            return result.openQuestionId != nil
        } catch {
            self.error = error.userMessage
            return false
        }
    }

    func edited() {
        if invalid { invalid = false }
    }
}

struct AskAboutView: View {
    @Environment(AppModel.self) private var app
    var name: String
    var facts: [CareFact]
    var openQuestions: [OpenQuestion]
    var onAdd: () -> Void
    var onChanged: () async -> Void
    var onSource: (SourceRequest) -> Void
    var onReveal: (String) -> Void
    @State private var model = AskModel()
    @State private var openListShown = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        @Bindable var model = model
        let stillOpen = CareHelp.uniqueQuestions(openQuestions)
        let factById = Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        CareSection(title: "Ask about \(name)", identifier: "care.ask") {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
                    TextField("Ask where her glasses are, what her routine is\u{2026}", text: $model.question, axis: .vertical)
                        .font(.rrBody)
                        .lineLimit(1...4)
                        .submitLabel(.search)
                        .focused($fieldFocused)
                        .onSubmit { submit() }
                        .onChange(of: model.question) { _, value in
                            model.edited()
                            if value.contains("\n") {
                                model.question = value.replacingOccurrences(of: "\n", with: "")
                                submit()
                            } else if value.count > AskModel.maxChars {
                                model.question = String(value.prefix(AskModel.maxChars))
                            }
                        }
                        .disabled(model.busy)
                        .accessibilityLabel("Your question about \(name)")
                        .accessibilityHint("Answers come only from \(Labels.possessive(name)) approved passport")
                        .accessibilityIdentifier("care.ask.field")
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 52)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius)
                        .strokeBorder(model.invalid ? Theme.badInk : Theme.fieldBorder, lineWidth: model.invalid ? 2 : 1)
                }
                Button("Ask") { submit() }
                    .buttonStyle(PrimaryButtonStyle(isBusy: model.busy))
                    .fixedSize()
                    .disabled(model.busy)
                    .accessibilityLabel(model.busy ? "Looking" : "Ask")
                    .accessibilityIdentifier("care.ask.submit")
            }
            NoteText("Answers come only from \(Labels.possessive(name)) approved passport, never from a guess.", alignment: .leading)
            if let error = model.error { ErrorNote(error) }

            if let asked = model.asked {
                AnswerView(
                    name: name, asked: asked, factById: factById, onAdd: onAdd, onSource: onSource, onReveal: onReveal
                )
                .id(asked.key)
            }

            if !stillOpen.isEmpty {
                Button {
                    openListShown.toggle()
                } label: {
                    HStack {
                        Text("Still to find out (\(stillOpen.count))").font(.rrBodyMedium)
                        Spacer()
                        CareChevron(isOpen: openListShown)
                    }
                    .foregroundStyle(Theme.ink)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityValue(openListShown ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("care.ask.stillOpen")
                if openListShown {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(stillOpen) { item in
                            Text("\u{2022} \(item.question)").font(.rrBody).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private func submit() {
        fieldFocused = false
        careAnnounce("Looking in \(Labels.possessive(name)) approved passport.")
        Task {
            if await model.ask(app.api) { await onChanged() }
            if let asked = model.asked { careAnnounce(AnswerView.leadText(name: name, asked: asked)) }
        }
    }
}

private struct AnswerView: View {
    var name: String
    var asked: AskModel.Asked
    var factById: [String: CareFact]
    var onAdd: () -> Void
    var onSource: (SourceRequest) -> Void
    var onReveal: (String) -> Void

    static func leadText(name: String, asked: AskModel.Asked) -> String {
        let result = asked.result
        if result.medicalRedirect { return CareHelp.redirectText(result) }
        if result.notFound { return "I don\u{2019}t have that in \(Labels.possessive(name)) approved passport." }
        return result.answer ?? "Here\u{2019}s what \(Labels.possessive(name)) passport says, word for word."
    }

    var body: some View {
        let result = asked.result
        let tone: (ink: Color, tint: Color) = result.medicalRedirect
            ? (Theme.badInk, Theme.badTint)
            : result.notFound ? (Theme.warnInk, Theme.warnTint) : (Theme.ink, Theme.tealTint)
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Text("You asked: \u{201C}\(asked.question)\u{201D}")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if result.medicalRedirect {
                        Image(systemName: "phone.fill").accessibilityHidden(true)
                    } else if result.notFound {
                        Image(systemName: "questionmark.circle").accessibilityHidden(true)
                    }
                    Text(Self.leadText(name: name, asked: asked))
                        .font(.rrBodyMedium)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(tone.ink)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.tint, in: .rect(cornerRadius: Theme.radius))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("care.ask.answer")

            if result.medicalRedirect {
                HStack(spacing: 10) {
                    callLink("Call 911", note: "Emergency", url: CareHelp.emergencyURL, emergency: true, id: "care.ask.call911")
                    callLink(
                        "Call 811", note: "Health Link, 24/7 nurse advice", url: CareHelp.healthLinkURL, emergency: false,
                        id: "care.ask.call811"
                    )
                }
                citedList(result.citedFacts)
            } else {
                details(result)
            }
        }
    }

    @ViewBuilder private func details(_ result: AskResponse) -> some View {
        if result.notFound {
            if result.openQuestionId != nil {
                Label("Saved as an open question", systemImage: "checkmark")
                    .font(.rrCallout)
                    .foregroundStyle(Theme.goodInk)
                    .accessibilityIdentifier("care.ask.saved")
            }
            if result.conflictPending {
                Text("Open \u{201C}Open questions & conflicts\u{201D} in \(Labels.possessive(name)) passport and keep the note that\u{2019}s right.")
                    .font(.rrBody)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("care.ask.conflictPending")
            } else {
                Button("Add the answer", action: onAdd)
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("care.ask.addAnswer")
            }
            HStack(spacing: 4) {
                Text("For health advice, call")
                Link(destination: CareHelp.healthLinkURL) { Text("Health Link at 811").underline().foregroundStyle(Theme.tealInk) }.accessibilityIdentifier("care.ask.link811")
            }
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            HStack(spacing: 4) {
                Text("In an emergency, call")
                Link(destination: CareHelp.emergencyURL) { Text("911").underline().foregroundStyle(Theme.tealInk) }.accessibilityIdentifier("care.ask.link911")
            }
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
        } else {
            citedList(result.citedFacts)
        }
        if let notice = result.healthNotice {
            Label(notice, systemImage: "phone").font(.rrNote).foregroundStyle(Theme.ink)
        }
        let provider = CareHelp.answeredByLabel(result.answeredBy)
        let searched = CareHelp.retrievalLine(result.retrieval)
        if provider != nil || searched != nil {
            VStack(alignment: .leading, spacing: 2) {
                if let provider { Text(provider) }
                if let searched { Text(searched) }
            }
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("care.ask.provenance")
        }
    }

    @ViewBuilder private func citedList(_ cited: [CitedFact]) -> some View {
        if !cited.isEmpty {
            Text("Based on \(cited.count == 1 ? "this approved fact" : "these \(cited.count) approved facts")")
                .font(.rrLabel)
                .accessibilityAddTraits(.isHeader)
            ForEach(cited) { item in
                CitationRow(name: name, cited: item, fact: factById[item.id], onSource: onSource, onReveal: onReveal)
            }
        }
    }

    private func callLink(_ title: String, note: String, url: URL, emergency: Bool, id: String) -> some View {
        Link(destination: url) {
            VStack(alignment: .leading, spacing: 2) {
                Label(title, systemImage: "phone.fill").font(.rrButtonSecondary)
                Text(note).font(.rrNote).fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(emergency ? .white : Theme.ink)
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
            .background(emergency ? Theme.badInk : Theme.surface, in: .rect(cornerRadius: Theme.radius))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(emergency ? .clear : Theme.hairline, lineWidth: 1)
            }
        }
        .accessibilityLabel("\(title), \(note)")
        .accessibilityIdentifier(id)
    }
}

private struct CitationRow: View {
    var name: String
    var cited: CitedFact
    var fact: CareFact?
    var onSource: (SourceRequest) -> Void
    var onReveal: (String) -> Void
    @State private var open = false

    var body: some View {
        let version = max(cited.version, fact?.version ?? 1)
        VStack(alignment: .leading, spacing: 10) {
            Button {
                open.toggle()
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 6) {
                        TonePill(sectionTitle, tone: .ask)
                        Text(cited.textExact)
                            .font(.careQuote)
                            .foregroundStyle(Theme.ink)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    CareChevron(isOpen: open).foregroundStyle(Theme.muted)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(sectionTitle). \(cited.textExact)")
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows where this fact came from")
            .accessibilityIdentifier("care.ask.citation")
            if open {
                VStack(alignment: .leading, spacing: 4) {
                    Text(CareHelp.citationFromLine(cited, fact: fact))
                    if version > 1 { Text("Version \(version)") }
                    Text("Approved")
                }
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                HStack(spacing: 8) {
                    if cited.sourceId ?? fact?.sourceId != nil {
                        Button("View source") { onSource(SourceRequest(cited: cited, fact: fact)) }
                            .buttonStyle(.careSmall)
                            .accessibilityLabel("View source for \u{201C}\(CareData.shorten(cited.textExact, 48))\u{201D}")
                            .accessibilityIdentifier("care.ask.viewSource")
                    }
                    if fact?.status == .approved {
                        Button {
                            onReveal(cited.id)
                        } label: {
                            Label("Show in \(Labels.possessive(name)) passport", systemImage: "book")
                        }
                        .buttonStyle(.careSmall)
                        .accessibilityIdentifier("care.ask.showInPassport")
                    }
                }
            }
        }
        .padding(14)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
    }

    private var sectionTitle: String {
        let id = PassportSection.section(of: cited.category)
        return PassportSection.all.first { $0.id == id }?.title ?? "Care passport"
    }
}
