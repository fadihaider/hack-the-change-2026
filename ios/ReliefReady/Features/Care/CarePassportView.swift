import SwiftUI

// the care passport (CarePassport.tsx, PRD 5): seven collapsed sections of approved facts with provenance. only
// approved facts read as settled; suggestions, conflicts and open questions live in the last section

/// a fact's wording is capped at this length on the server
private let maxFactChars = 1000

struct CarePassportView: View {
    var name: String
    var profile: CareProfile
    @Binding var expanded: Set<PassportSectionID>
    var onReview: ([ReviewStep]) -> Void
    var onChanged: () async -> Void
    var onAdd: () -> Void
    var onSource: (SourceRequest) -> Void

    var body: some View {
        let groups = CareData.passportGroups(profile.facts)
        let open = CareData.openItems(profile.facts)
        let questions = CareData.uniqueOpenQuestions(profile.openQuestions)
        let approved = groups.reduce(0) { $0 + $1.facts.count }
        let openCount = questions.count + open.conflicts.count + open.suggested
        let isEmpty = approved == 0 && open.steps.isEmpty && questions.isEmpty

        if isEmpty {
            CareSection(title: "Care passport", identifier: "care.passport") {
                Text("Nothing is in \(CareData.possessive(name)) passport yet. Start with what a helper would need to know on day one.")
                    .font(.rrBody)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Tell ReliefReady about \(name)", action: onAdd).buttonStyle(.primary)
                    .accessibilityIdentifier("care.passport.tell")
            }
        } else {
            CareSection(
                title: "Care passport",
                hint: "Only what you\u{2019}ve approved about \(name), word for word from your notes.",
                identifier: "care.passport"
            ) {
                if !open.steps.isEmpty {
                    Button(
                        open.conflicts.isEmpty
                            ? "Review \(CareData.plural(open.steps.count, "suggestion", "suggestions"))"
                            : "Review \(CareData.plural(open.steps.count, "item", "items"))"
                    ) { onReview(open.steps) }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("care.passport.review")
                }
                VStack(spacing: 0) {
                    ForEach(groups) { group in
                        PassportAccordion(
                            id: group.section.id, title: group.section.title, count: "\(group.facts.count) approved",
                            hint: group.section.hint, isOpen: expanded.contains(group.section.id)
                        ) {
                            toggle(group.section.id)
                        } content: {
                            if group.section.id == .contacts {
                                EmergencyHelpInline(name: name)
                            }
                            if group.facts.isEmpty {
                                Text("Nothing approved here yet.").font(.rrBody).foregroundStyle(Theme.muted)
                            } else {
                                ForEach(group.facts) { fact in
                                    PassportFactRow(
                                        fact: fact,
                                        earlier: CareData.earlierVersions(fact, in: profile.facts),
                                        onSource: onSource,
                                        onChanged: onChanged
                                    )
                                    .id("fact-\(fact.id)")
                                }
                            }
                        }
                        Rectangle().fill(Theme.hairline).frame(height: 1)
                    }
                    if let section = PassportSection.all.first(where: { $0.id == .open }) {
                        PassportAccordion(
                            id: .open, title: section.title, count: openCount == 0 ? "nothing open" : "\(openCount) open",
                            hint: section.hint, isOpen: expanded.contains(.open)
                        ) {
                            toggle(.open)
                        } content: {
                            OpenItemsPanel(
                                name: name, questions: questions, conflicts: open.conflicts, suggested: open.suggested,
                                onReviewSuggested: { onReview(open.steps.filter { $0.kind == .fact }) },
                                onAdd: onAdd, onChanged: onChanged
                            )
                        }
                    }
                }
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
            }
        }
    }

    private func toggle(_ id: PassportSectionID) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }
}

private struct PassportAccordion<Content: View>: View {
    var id: PassportSectionID
    var title: String
    var count: String
    var hint: String
    var isOpen: Bool
    var onToggle: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(alignment: .center, spacing: 12) {
                    Text("\(Text(title).font(.rrBodyMedium).foregroundStyle(Theme.ink)) \(Text("(\(count))").font(.rrNote).foregroundStyle(Theme.muted))")
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    CareChevron(isOpen: isOpen).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 56)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title), \(count)")
            .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("passport.section.\(id.rawValue)")
            if isOpen {
                VStack(alignment: .leading, spacing: 14) {
                    Text(hint).font(.rrNote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
    }
}

// MARK: - one approved fact

private struct PassportFactRow: View {
    @Environment(AppModel.self) private var app
    var fact: CareFact
    /// the versions this fact replaced, newest first
    var earlier: [CareFact]
    var onSource: (SourceRequest) -> Void
    var onChanged: () async -> Void
    @State private var showFull = false
    @State private var showEarlier = false
    @State private var editing = false
    @State private var draft = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        // medication, dose and wound wording is locked whatever its category: never shortened, never edited here
        let written = LockedWording.isLocked(category: fact.category, text: fact.textExact)
        let summary = written ? fact.textExact : CareData.factSummary(fact)
        let named = CareData.shorten(summary, 48)
        VStack(alignment: .leading, spacing: 10) {
            if written {
                Text("Written care instruction, exact wording").font(.rrPill).foregroundStyle(Theme.warnInk)
            }
            Text(summary)
                .font(written ? .careQuote : .rrBody)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("passport.fact.text")

            if !written && summary != fact.textExact {
                disclosure("Full wording", isOpen: $showFull)
                if showFull { CareQuote(text: fact.textExact) }
            }

            VStack(alignment: .leading, spacing: 4) {
                if let when = CareData.timeLine(fact) { CareMetaLine(systemImage: "clock", text: when) }
                CareMetaLine(systemImage: "doc.text", text: CareData.provenanceLine(fact))
                if let version = CareData.versionLabel(fact) { CareMetaLine(systemImage: "clock.arrow.circlepath", text: version) }
            }

            if !earlier.isEmpty {
                disclosure("Earlier wording", isOpen: $showEarlier)
                if showEarlier {
                    ForEach(Array(earlier.enumerated()), id: \.element.id) { index, previous in
                        VStack(alignment: .leading, spacing: 6) {
                            CareQuote(text: previous.textExact)
                            Text("\(previous.version > 1 ? "Version \(previous.version)" : "Original"). \(CareData.provenanceLine(previous))")
                                .font(.rrNote)
                                .foregroundStyle(Theme.muted)
                            if previous.sourceId != nil {
                                Button(index == earlier.count - 1 ? "View original source" : "View its source") {
                                    onSource(SourceRequest(fact: previous))
                                }
                                .buttonStyle(.careSmall)
                                .accessibilityIdentifier("passport.fact.earlierSource")
                            }
                        }
                    }
                }
            }

            if editing && !written {
                CareTextArea(
                    label: "Change the wording", hint: "Saving makes a new approved version. The earlier wording is kept.",
                    text: $draft, maxLength: maxFactChars, isDisabled: busy, identifier: "passport.fact.editField",
                    focus: $fieldFocused
                )
                if let error { ErrorNote(error) }
                ButtonStack {
                    Button("Save as new version") { Task { await save() } }
                        .buttonStyle(.primary(busy: busy))
                        .disabled(busy)
                        .accessibilityIdentifier("passport.fact.save")
                    Button("Cancel") {
                        editing = false
                        error = nil
                    }
                    .buttonStyle(.secondary)
                    .disabled(busy)
                    .accessibilityIdentifier("passport.fact.cancel")
                }
            } else {
                HStack(spacing: 8) {
                    if fact.sourceId != nil {
                        Button("View source") { onSource(SourceRequest(fact: fact)) }
                            .buttonStyle(.careSmall)
                            .accessibilityLabel("View source for \u{201C}\(named)\u{201D}")
                            .accessibilityIdentifier("passport.fact.viewSource")
                    }
                    if !written {
                        Button("Edit") {
                            draft = fact.textExact
                            error = nil
                            editing = true
                            fieldFocused = true
                        }
                        .buttonStyle(.careSmall)
                        .accessibilityLabel("Edit \u{201C}\(named)\u{201D}")
                        .accessibilityIdentifier("passport.fact.edit")
                    }
                }
            }
            if written {
                Text("Written care instructions stay word for word. Add the corrected document instead.")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.page, in: .rect(cornerRadius: Theme.radius))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("passport.fact.\(fact.id)")
    }

    private func disclosure(_ title: String, isOpen: Binding<Bool>) -> some View {
        Button {
            isOpen.wrappedValue.toggle()
        } label: {
            HStack(spacing: 6) {
                Text(title)
                CareChevron(isOpen: isOpen.wrappedValue)
            }
            .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
            .foregroundStyle(Theme.tealInk)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOpen.wrappedValue ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("passport.fact.\(title == "Full wording" ? "full" : "earlier")")
    }

    private func save() async {
        guard !busy else { return }
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            error = "Write the wording first, or cancel."
            return
        }
        if value.count > maxFactChars {
            error = "Keep it under \(maxFactChars) characters. Split longer notes into separate facts."
            return
        }
        if value == fact.textExact {
            error = "Nothing changed yet. Change the wording, or cancel."
            return
        }
        busy = true
        error = nil
        do {
            let result = try await app.api.editFact(id: fact.id, text: value)
            careAnnounce("Saved as version \(result.fact.version). The earlier wording is kept.")
            editing = false
            busy = false
            await onChanged()
        } catch {
            self.error = error.userMessage
            busy = false
        }
    }
}

// MARK: - open questions & conflicts

private struct OpenItemsPanel: View {
    var name: String
    var questions: [OpenQuestion]
    var conflicts: [[CareFact]]
    var suggested: Int
    var onReviewSuggested: () -> Void
    var onAdd: () -> Void
    var onChanged: () async -> Void

    var body: some View {
        if questions.isEmpty && conflicts.isEmpty && suggested == 0 {
            Text("Nothing open. Questions asked about \(name) that the passport can\u{2019}t answer show up here.")
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            if !conflicts.isEmpty {
                subhead("Notes that disagree")
                ForEach(conflicts, id: \.self) { group in
                    ConflictGroupView(group: group, onChanged: onChanged)
                }
            }
            if suggested > 0 {
                subhead("Waiting for your check")
                Text(
                    "\(CareData.plural(suggested, "suggestion is", "suggestions are")) waiting. Nothing is part of the passport until you approve it."
                )
                .font(.rrBody)
                .fixedSize(horizontal: false, vertical: true)
                Button("Review \(CareData.plural(suggested, "suggestion", "suggestions"))", action: onReviewSuggested)
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("passport.open.review")
            }
            if !questions.isEmpty {
                subhead("Still to find out")
                ForEach(questions) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Label(item.question, systemImage: "questionmark.circle")
                            .font(.rrBody)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Answer by adding a note", action: onAdd)
                            .buttonStyle(.careSmall)
                            .accessibilityLabel("Answer by adding a note: \(CareData.shorten(item.question, 48))")
                            .accessibilityIdentifier("passport.open.answer")
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.page, in: .rect(cornerRadius: Theme.radiusSmall))
                }
            }
        }
    }

    private func subhead(_ text: String) -> some View {
        Text(text).font(.rrLabel).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader).padding(.top, 4)
    }
}

private struct ConflictGroupView: View {
    @Environment(AppModel.self) private var app
    var group: [CareFact]
    var onChanged: () async -> Void
    @State private var busy: String?
    @State private var error: String?
    @State private var later = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(lead).font(.rrBodyMedium).fixedSize(horizontal: false, vertical: true)
            ForEach(group) { fact in
                VStack(alignment: .leading, spacing: 8) {
                    CareQuote(text: fact.textExact)
                    CareMetaLine(systemImage: "doc.text", text: CareData.provenanceLine(fact))
                    if let when = CareData.timeLine(fact) { CareMetaLine(systemImage: "clock", text: when) }
                    Button("Keep this one") { Task { await keep(fact) } }
                        .buttonStyle(.secondary(busy: busy == fact.id))
                        .disabled(busy != nil)
                        .accessibilityLabel("Keep this one: \u{201C}\(CareData.shorten(fact.textExact, 48))\u{201D}")
                        .accessibilityIdentifier("passport.conflict.keep")
                }
            }
            if let error { ErrorNote(error) }
            if later {
                NoteText("Left for later. Neither note is used in the day or in answers until you choose.", alignment: .leading)
            } else {
                Button("Decide later") {
                    later = true
                    careAnnounce("Left for later. Neither note is used until you choose.")
                }
                .buttonStyle(.quiet)
                .disabled(busy != nil)
                .accessibilityIdentifier("passport.conflict.later")
            }
        }
        .padding(12)
        .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
    }

    private var lead: String {
        if group.count == 1 { return "This note disagreed with one that has changed. Keep it?" }
        if group.count > 2 { return "\(group.count) notes disagree. Which one is right?" }
        return "Two notes disagree. Which one is right?"
    }

    private func keep(_ fact: CareFact) async {
        guard busy == nil else { return }
        busy = fact.id
        error = nil
        do {
            _ = try await app.api.resolveConflict(keepFactId: fact.id)
            careAnnounce(
                group.count > 1 ? "Kept. The other \(group.count > 2 ? "notes are" : "note is") set aside, not deleted." : "Kept."
            )
            await onChanged()
        } catch {
            self.error = error.userMessage
        }
        busy = nil
    }
}
