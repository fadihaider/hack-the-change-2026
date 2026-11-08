import SwiftUI

/// the letter sheet: the exact recipient and words, how much it shares, and the send button that names the person
struct LetterSheet: View {
    @Bindable var letter: LetterModel
    var onClose: () -> Void
    @FocusState private var typing: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    StatePill(state: letter.current.state)
                        .accessibilityIdentifier("letter.state")
                    SheetHeader(
                        title: letter.title, closeLabel: letter.closeLabel, closeDisabled: letter.busy != nil, onClose: onClose
                    )
                        .accessibilityIdentifier("letter.close")
                        .padding(.bottom, -12)
                    Text(letter.leadLine)
                        .font(.rrBody)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    paper
                    privacy

                    if let error = letter.error {
                        ErrorNote(error)
                            .id("letter.error")
                            .accessibilityIdentifier("letter.error")
                    }

                    if !letter.flagNotes.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(letter.flagNotes, id: \.self) { InfoLine(text: $0) }
                        }
                    }

                    if letter.blocked {
                        blockedBox
                    } else {
                        sendArea
                    }

                    NoteText(letter.sendNote, alignment: .leading)
                        .accessibilityIdentifier("letter.sendNote")
                }
                .padding(Theme.gutter)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: letter.error) { _, error in
                if error != nil { withAnimation { proxy.scrollTo("letter.error", anchor: .center) } }
            }
        }
        .background(Theme.surface)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { typing = false }.accessibilityIdentifier("keyboard.done")
            }
        }
        .accessibilityIdentifier("screen.letter")
    }

    private var paper: some View {
        Paper {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                PaperLabel("To").frame(width: 64, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(letter.current.recipient.name).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                    Text(letter.current.recipient.email).font(.rrNote).foregroundStyle(Theme.muted)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("letter.to")
            }
            .padding(.vertical, 12)
            Hairline()
            VStack(alignment: .leading, spacing: 4) {
                PaperLabel("Subject")
                if letter.editable {
                    TextField("Subject", text: Binding(get: { letter.subject }, set: { letter.setSubject($0) }), axis: .vertical)
                        .font(.rrBodyMedium)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1...4)
                        .focused($typing)
                        .accessibilityLabel("Subject")
                        .accessibilityIdentifier("letter.subject")
                } else {
                    Text(letter.subject).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                        .accessibilityIdentifier("letter.subject")
                }
            }
            .padding(.vertical, 12)
            Hairline()
            VStack(alignment: .leading, spacing: 4) {
                PaperLabel("Message")
                if letter.editable {
                    TextField("Message", text: Binding(get: { letter.body }, set: { letter.setBody($0) }), axis: .vertical)
                        .font(.rrBody)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(8...)
                        .focused($typing)
                        .accessibilityLabel("Message")
                        .accessibilityIdentifier("letter.body")
                } else {
                    Text(letter.body).font(.rrBody).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("letter.body")
                }
            }
            .padding(.vertical, 12)
        }
    }

    private var privacy: some View {
        VStack(alignment: .leading, spacing: 10) {
            TierPicker(
                value: letter.shownTier,
                groupTier: letter.current.defaultDisclosureTier,
                alias: letter.careAlias,
                disabled: !letter.editable || letter.busy != nil,
                identifierPrefix: "letter"
            ) { letter.pickTier($0) }

            if let question = letter.tierQuestion, let pending = letter.pendingTier {
                VStack(alignment: .leading, spacing: 10) {
                    Text(question)
                        .font(.rrBody)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if letter.dirty {
                        UrgentButton(title: "Write it again", kind: .primary, identifier: "letter.rewrite") {
                            Task { await letter.changeTier(pending, rewrite: true) }
                        }
                        UrgentButton(title: "Keep my words", kind: .secondary, identifier: "letter.keepWords") {
                            Task { await letter.changeTier(pending, rewrite: false) }
                        }
                    } else {
                        UrgentButton(title: "Use this level", kind: .primary, identifier: "letter.useTier") {
                            Task { await letter.useTier() }
                        }
                    }
                    UrgentButton(title: "Cancel", kind: .quiet, identifier: "letter.cancelTier") { letter.cancelTier() }
                }
                .padding(14)
                .background(Theme.page, in: .rect(cornerRadius: Theme.radius))
            }

            HStack(spacing: 8) {
                if letter.busy == .tier { ProgressView().tint(Theme.muted) }
                Text(letter.tierNote).font(.rrNote).foregroundStyle(Theme.muted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("letter.tierNote")
        }
    }

    private var blockedBox: some View {
        WarnBox(
            title: "This message mentions \(UrgentWords.quoted(letter.terms)).",
            text: "Health details stay private unless you choose to share them."
        ) {
            UrgentButton(
                title: "Remove them", kind: .primary, isBusy: letter.busy == .remove, busyTitle: "Removing them",
                identifier: "letter.remove"
            ) { Task { await letter.strip() } }
            .disabled(letter.busy != nil && letter.busy != .remove)
            UrgentButton(
                title: "Send anyway to \(letter.name)", kind: .secondary, isBusy: letter.busy == .anyway,
                busyTitle: "Sending to \(letter.name)", identifier: "letter.sendAnyway"
            ) { Task { await letter.send(override: true) } }
            .disabled((letter.busy != nil && letter.busy != .anyway) || letter.pendingTier != nil)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("letter.warn")
    }

    @ViewBuilder private var sendArea: some View {
        if let note = letter.allowedNote {
            InfoLine(text: note).accessibilityIdentifier("letter.allowed")
        }
        VStack(spacing: 12) {
            UrgentButton(
                title: "Send to \(letter.name)", kind: .primary, systemImage: "paperplane", isBusy: letter.busy == .send,
                busyTitle: "Sending to \(letter.name)", identifier: "letter.send"
            ) { Task { await letter.send(override: false) } }
            .disabled((letter.busy != nil && letter.busy != .send) || letter.pendingTier != nil)
            if !letter.terms.isEmpty && letter.editable {
                UrgentButton(
                    title: "Remove them", kind: .quiet, isBusy: letter.busy == .remove, busyTitle: "Removing them",
                    identifier: "letter.remove"
                ) { Task { await letter.strip() } }
                .disabled(letter.busy != nil && letter.busy != .remove)
            }
        }
    }
}
