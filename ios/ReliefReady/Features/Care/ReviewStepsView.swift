import SwiftUI

/// the one-at-a-time check (ReviewSteps.tsx)
struct ReviewStepsView: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: ReviewModel
    @FocusState private var editFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScreenColumn {
                Color.clear.frame(height: 0).id("review.top")
                content
            }
            .onChange(of: model.moves) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("review.top", anchor: .top) }
            }
        }
        .screenTitle("Check what you added")
        .navigationBarBackButtonHidden(true)
        .toolbar {
            // a word, not a chevron: on iOS 26 a bar chevron draws alone and reads as one step back, while the
            // in-page Back right below it is the step back. this one leaves the check
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    model.finish()
                }
                .disabled(model.isWorking)
                .accessibilityLabel("Back to \(Labels.possessive(model.name)) care")
                .accessibilityIdentifier("review.close")
            }
        }
        .accessibilityIdentifier("screen.careReview")
        .onChange(of: model.announcement) { _, text in
            if let text { careAnnounce(text) }
        }
        .task(id: sourceIdOnScreen) {
            if let id = sourceIdOnScreen { await model.loadSource(id) }
        }
    }

    private var sourceIdOnScreen: String? {
        guard let step = model.step, step.kind == .fact else { return nil }
        return model.byId[step.factId]?.sourceId
    }

    @ViewBuilder private var content: some View {
        if model.steps.isEmpty {
            QuestionHeader("There\u{2019}s nothing left to check.")
            Button("Back to \(Labels.possessive(model.name)) care") { model.finish() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("review.backToCare")
        } else {
            progress
            if let receipt = model.receipt {
                Receipt(receipt).accessibilityIdentifier("review.receipt")
            }
            if model.atSummary {
                summaryView
            } else if let step = model.step {
                if step.kind == .fact {
                    factStep(step)
                } else {
                    conflictStep(step)
                }
            }
        }
    }

    private var progress: some View {
        StepProgress(
            total: model.steps.count,
            current: model.index,
            labels: model.labels,
            done: model.done,
            onBack: model.index > 0 && !model.isWorking ? { model.back() } : nil
        )
        .accessibilityIdentifier("review.progress")
    }

    // MARK: - the end

    @ViewBuilder private var summaryView: some View {
        let summary = model.summary
        QuestionHeader("Here\u{2019}s what you decided.", lead: "That\u{2019}s everything for now.")
            .accessibilityIdentifier("review.summary.title")
        VStack(spacing: 0) {
            ForEach(ReviewData.summaryRows(summary)) { row in
                HStack {
                    Text(row.label).font(.rrBody)
                    Spacer()
                    Text("\(row.count)").font(.rrBodyMedium.monospacedDigit())
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 48)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("review.summary.\(row.key)")
                if row.key != "skipped" { Rectangle().fill(Theme.hairline).frame(height: 1) }
            }
        }
        .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
        ButtonStack {
            Button("Back to \(Labels.possessive(model.name)) care") { model.finish() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("review.backToCare")
            if summary.skipped > 0 && model.firstLeft != nil {
                Button("Check the ones left for later") { model.checkLeftForLater() }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("review.checkLeft")
            }
            NoteText("Only what you approved is on \(Labels.possessive(model.name)) profile. The rest waits for you.")
        }
    }

    // MARK: - one fact

    @ViewBuilder private func factStep(_ step: ReviewStep) -> some View {
        let fact = model.byId[step.factId]
        switch model.outcomes[step.key] {
        case .edited(_, let text, let original):
            factQuestion(text, ask: "You approved your wording.")
            Text("\(Text("Original wording, kept as an earlier version:").font(.rrLabel)) \(Text("\u{201C}\(original)\u{201D}").font(.rrBody))")
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            nextButton
        case .rejected(let text):
            factQuestion(text, ask: "You rejected this. It stays off \(Labels.possessive(model.name)) profile.")
            nextButton
        case .approved where fact != nil:
            factMeta(fact!)
            factQuestion(fact!.textExact, ask: "You said it\u{2019}s right.")
            nextButton
        default:
            if let fact, fact.status == .suggested {
                suggested(step, fact)
            } else {
                changed(fact)
            }
        }
    }

    @ViewBuilder private func suggested(_ step: ReviewStep, _ fact: CareFact) -> some View {
        let locked = LockedWording.isLocked(category: fact.category, text: fact.textExact)
        let editing = model.draft != nil
        factMeta(fact)
        factQuestion(fact.textExact, ask: editing ? "What should it say?" : "Is that right?")
        if let sourceId = fact.sourceId, case .loaded(let source) = model.sources[sourceId] {
            SourceContextView(fact: fact, source: source)
        }
        if editing {
            CareTextArea(
                label: "Your wording",
                hint: "It\u{2019}s saved as a new version and approved. The original wording stays in its history.",
                text: Binding(get: { model.draft ?? "" }, set: { model.draft = $0 }),
                minLines: 3, maxLength: ReviewModel.editMax, isDisabled: model.isWorking,
                identifier: "review.editField", focus: $editFocused
            )
            .onAppear { editFocused = true }
            if let error = model.error { ErrorNote(error) }
            ButtonStack {
                Button("Approve this wording") { Task { await model.saveEdit(fact) } }
                    .buttonStyle(.primary(busy: model.busy == .edit || model.busy == .approve))
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("review.saveEdit")
                Button("Cancel") { model.cancelEdit() }
                    .buttonStyle(.quiet)
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("review.cancelEdit")
            }
        } else {
            if let consequence = ReviewData.consequenceLine(name: model.name, fact: fact) {
                Label(consequence, systemImage: "calendar.badge.plus")
                    .font(.rrBody)
                    .foregroundStyle(Theme.tealInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("review.consequence")
            }
            if let error = model.error { ErrorNote(error) }
            ButtonStack {
                Button("Approve") { Task { await model.approve(fact) } }
                    .buttonStyle(.primary(busy: model.busy == .approve))
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("review.approve")
                HStack(spacing: 12) {
                    if !locked {
                        Button("Edit and approve") { model.startEdit(fact) }
                            .buttonStyle(.secondary)
                            .disabled(model.isWorking)
                            .accessibilityIdentifier("review.edit")
                    }
                    Button("Reject") { Task { await model.reject(fact) } }
                        .buttonStyle(.secondary(busy: model.busy == .reject))
                        .disabled(model.isWorking)
                        .accessibilityIdentifier("review.reject")
                }
                Button("Leave for later") { model.skip() }
                    .buttonStyle(.secondary)
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("review.later")
                NoteText(
                    locked
                        ? "Written care instructions stay word for word. Approve or reject them as written."
                        : "Only what you approve goes on \(Labels.possessive(model.name)) profile."
                )
                finishLater
            }
        }
    }

    @ViewBuilder private func changed(_ fact: CareFact?) -> some View {
        if let fact {
            QuestionHeader(changedText(fact), lead: "\u{201C}\(ReviewData.quoteOf(fact, max: ReviewModel.inlineMax))\u{201D}")
        } else {
            QuestionHeader("This one was removed while you were checking.")
        }
        if let error = model.error { ErrorNote(error) }
        nextButton
    }

    private func changedText(_ fact: CareFact) -> String {
        switch fact.status {
        case .approved: "It\u{2019}s already on \(Labels.possessive(model.name)) profile."
        case .rejected: "It was rejected while you were checking."
        case .superseded: "A newer version replaced it while you were checking."
        case .conflicting: "It now disagrees with another note. Pick one the next time you check."
        default: "It changed while you were checking."
        }
    }

    private func factMeta(_ fact: CareFact) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CareMetaLine(systemImage: "doc.text", text: ReviewData.reviewSourceLine(fact))
            CareMetaLine(systemImage: "tag", text: ReviewData.sectionTitle(fact.category))
                .accessibilityLabel("Passport section: \(ReviewData.sectionTitle(fact.category))")
        }
        .accessibilityIdentifier("review.meta")
    }

    @ViewBuilder private func factQuestion(_ text: String, ask: String) -> some View {
        if text.count <= ReviewModel.inlineMax {
            QuestionHeader(ask, lead: "\u{201C}\(text)\u{201D}")
                .accessibilityIdentifier("review.question")
        } else {
            QuestionHeader(ask, lead: "Your note says this.")
                .accessibilityIdentifier("review.question")
            CareQuote(text: text)
        }
    }

    private var nextButton: some View {
        Button(model.isLast ? "See what changed" : "Next") { model.advance() }
            .buttonStyle(.primary)
            .accessibilityIdentifier("review.next")
    }

    private var finishLater: some View {
        Button("Finish later") { model.finish() }
            .buttonStyle(.quiet)
            .disabled(model.isWorking)
            .accessibilityIdentifier("review.finishLater")
    }

    // MARK: - notes that disagree

    @ViewBuilder private func conflictStep(_ step: ReviewStep) -> some View {
        let byId = model.byId
        let group = step.factIds.compactMap { byId[$0] }
        let isOpen = !group.isEmpty && group.allSatisfy { $0.status == .conflicting }
        if case .kept(let factId) = model.outcomes[step.key], let kept = byId[factId] {
            QuestionHeader("You kept this one.", lead: group.count > 2 ? "These notes disagreed." : "Two notes disagreed.")
            CareQuote(text: kept.textExact, footer: ReviewData.reviewSourceLine(kept))
            nextButton
        } else if isOpen {
            let keeping: String? = if case .keep(let id) = model.busy { id } else { nil }
            QuestionHeader(
                group.count == 1 ? "Keep it?" : "Which one is right?",
                lead: group.count == 1
                    ? "This note disagreed with one that has changed."
                    : group.count > 2 ? "\(group.count) notes disagree." : "Two notes disagree."
            )
            .accessibilityIdentifier("review.conflict.question")
            if let note = model.session.notes[step.key], let label = ReviewData.noteLabel(app.session?.mode.ai) {
                Text("\(Text("\(label):").font(.rrLabel)) \(Text(note).font(.rrBody))")
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .careBox(Theme.radiusSmall)
                    .accessibilityIdentifier("review.conflict.note")
            }
            ForEach(group) { fact in
                conflictOption(fact, busy: keeping == fact.id)
            }
            if let error = model.error { ErrorNote(error) }
            ButtonStack {
                NoteText(
                    "The other \(group.count > 2 ? "notes are" : "note is") set aside, not deleted. Until you pick, neither time is on \(Labels.possessive(model.name)) day."
                )
                Button("Decide later") { model.skip() }
                    .buttonStyle(.secondary)
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("review.conflict.later")
                finishLater
            }
        } else {
            QuestionHeader("Nothing to do here.", lead: "These notes were sorted out while you were checking.")
            if let error = model.error { ErrorNote(error) }
            nextButton
        }
    }

    private func conflictOption(_ fact: CareFact, busy: Bool) -> some View {
        Button {
            Task { await model.keep(fact) }
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                Text("\u{201C}\(fact.textExact)\u{201D}")
                    .font(.careQuote)
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                CareMetaLine(systemImage: "doc.text", text: ReviewData.reviewSourceLine(fact))
                if let when = CareData.timeLine(fact) { CareMetaLine(systemImage: "clock", text: when) }
                HStack(spacing: 6) {
                    if busy { ProgressView().tint(Theme.teal) }
                    Text(busy ? "Keeping it" : "Keep this one")
                }
                .font(.rrButtonSecondary)
                .foregroundStyle(Theme.tealInk)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(busy ? Theme.teal : Theme.hairline, lineWidth: busy ? 2 : 1)
            }
            .shadow(color: Theme.ink.opacity(0.06), radius: 1, y: 1)
            .contentShape(.rect(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .disabled(model.isWorking)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Keep: \u{201C}\(fact.textExact)\u{201D}. \(ReviewData.reviewSourceLine(fact))")
        .accessibilityIdentifier("review.conflict.keep")
    }
}

/// the sentence the suggestion came from, with the quoted part marked
private struct SourceContextView: View {
    var fact: CareFact
    var source: CareSourceDetail
    @State private var whole = false

    var body: some View {
        if let context = ReviewData.sourceContext(source.fullText, fact: fact) {
            VStack(alignment: .leading, spacing: 8) {
                Text(ReviewData.contextLabel(source.kind)).font(.rrLabel).foregroundStyle(Theme.muted)
                Text(marked(context))
                    .font(.rrBody)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if context.cutStart || context.cutEnd {
                    Button(ReviewData.wholeSourceLabel(source.kind)) { whole.toggle() }
                        .buttonStyle(.careSmall)
                        .accessibilityValue(whole ? "Expanded" : "Collapsed")
                    if whole {
                        Text(source.fullText).font(.rrNote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .careBox(Theme.radius)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("review.context")
        }
    }

    private func marked(_ context: SourceContext) -> AttributedString {
        var quote = AttributedString(context.quote)
        quote.backgroundColor = Theme.selection
        quote.font = Fonts.figtree(16, weight: .semibold, relativeTo: .body)
        return AttributedString("\(context.cutStart ? "\u{2026} " : "")\(context.before)") + quote
            + AttributedString("\(context.after)\(context.cutEnd ? " \u{2026}" : "")")
    }
}
