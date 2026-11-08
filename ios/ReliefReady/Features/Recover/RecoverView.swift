import SwiftUI

/// Recover tab: after the care week, GET and POST /api/recover grouped into handled, waiting, needs follow-up,
/// not sent and new, with follow-ups through the request editor. embeds HelpNearbyView.
struct RecoverView: View {
    @Environment(AppModel.self) private var model
    @State private var recover = RecoverModel()

    init() {}

    var body: some View {
        content
            .screenTitle("Recover")
            .accessibilityIdentifier("screen.recover")
            // a moved demo clock reloads the session; ask again so deadlines and replies match the new time.
            // swiftui runs .task again each time the tab appears, so every visit also asks again, as the web does
            .task(id: model.session?.appNow) {
                guard model.session?.episode != nil else { return }
                recover.announce = { text in AccessibilityNotification.Announcement(text).post() }
                await recover.load(api: model.api)
            }
    }

    @ViewBuilder
    private var content: some View {
        if let session = model.session {
            if let episode = session.episode {
                if let data = recover.data {
                    RecoverList(recover: recover, data: data, session: session, episode: episode)
                } else if let error = recover.loadError {
                    ScreenColumn {
                        QuestionHeader("What\u{2019}s left didn\u{2019}t load.")
                        ErrorNote(error) { Task { await recover.load(api: model.api) } }
                            .accessibilityIdentifier("recover.loadError")
                    }
                } else {
                    LoadingView("Loading what\u{2019}s left").pageBackground()
                }
            } else {
                ScreenColumn {
                    QuestionHeader("Start one, then come back here after it?", lead: "There\u{2019}s no care week on file yet.")
                }
            }
        } else if let error = model.sessionError {
            ScreenColumn {
                QuestionHeader("Your week didn\u{2019}t load.")
                ErrorNote(error.userMessage) { Task { await model.refreshSession() } }
            }
        } else {
            LoadingView("Loading your week").pageBackground()
        }
    }
}

/// the loaded list: receipt, heading, summary, the five groups, the check button and help nearby
private struct RecoverList: View {
    @Environment(AppModel.self) private var model
    var recover: RecoverModel
    var data: RecoverResponse
    var session: Session
    var episode: EpisodeSummary

    private static let topID = "recover.top"

    var body: some View {
        let sorted = RecoverLines.sort(data.groups)
        let mail = session.mode.mail
        let name = model.careRecipientName
        let heading = RecoverLines.heading(sorted, name: name, today: session.today, episode: episode)
        let everyone = data.groups.handled + data.groups.waiting + data.groups.needsFollowUp + data.groups.notSent
        let withNewTime = Set(sorted.newTimes.compactMap(\.requestId))

        ScrollViewReader { proxy in
            ScreenColumn {
                Color.clear.frame(height: 0).id(Self.topID)
                if let done = recover.done, done.good {
                    Receipt(done.text, systemImage: done.systemImage)
                        .accessibilityIdentifier("recover.receipt")
                }
                QuestionHeader(heading.question, lead: heading.lead)
                    .padding(.bottom, sorted.total > 0 ? -16 : 0)
                    .accessibilityIdentifier("recover.heading")
                if sorted.total > 0 {
                    Text(RecoverLines.summaryLine(sorted))
                        .font(.rrBody)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("recover.summary")
                }
                if let done = recover.done, !done.good {
                    ErrorNote(done.text).accessibilityIdentifier("recover.actionError")
                }
                if let error = recover.loadError {
                    ErrorNote(error) { Task { await recover.load(api: model.api) } }
                        .accessibilityIdentifier("recover.loadError")
                }

                if sorted.total == 0 {
                    ButtonStack {
                        Button("Go to Urgent") { model.showUrgent() }
                            .buttonStyle(.primary)
                            .accessibilityIdentifier("recover.goUrgent")
                        NoteText("Messages you send from Urgent show up here with who answered.")
                    }
                }

                RecoverGroup(
                    title: "Needs follow-up", hint: "Each one needs a next step from you.", id: "followUp",
                    isEmpty: sorted.followUp.isEmpty, dropdownCount: sorted.followUp.count
                ) {
                    ForEach(sorted.followUp) { request in
                        RecoverRequestRow(
                            recover: recover, request: request, mail: mail, hasNewTime: withNewTime.contains(request.id)
                        )
                        RowDivider(isLast: request.id == sorted.followUp.last?.id)
                    }
                }

                RecoverGroup(title: "Not sent", hint: "Nothing here has gone out.", id: "notSent", isEmpty: sorted.notSent.isEmpty) {
                    ForEach(sorted.notSent) { request in
                        RecoverRequestRow(recover: recover, request: request, mail: mail, allowsActions: true)
                        RowDivider(isLast: request.id == sorted.notSent.last?.id)
                    }
                }

                RecoverGroup(
                    title: "New", hint: "Times people asked for on their reply links.", id: "new",
                    isEmpty: sorted.newTimes.isEmpty
                ) {
                    ForEach(sorted.newTimes) { time in
                        RecoverNewTimeRow(time: time, from: everyone.first { $0.id == time.requestId })
                        RowDivider(isLast: time.id == sorted.newTimes.last?.id)
                    }
                }

                RecoverGroup(
                    title: "Waiting", hint: RecoverLines.waitingHint(mail: mail), id: "waiting", isEmpty: sorted.waiting.isEmpty
                ) {
                    ForEach(sorted.waiting) { request in
                        RecoverRequestRow(recover: recover, request: request, mail: mail)
                        RowDivider(isLast: request.id == sorted.waiting.last?.id)
                    }
                }

                RecoverGroup(
                    title: "Handled", hint: "They said yes. That isn\u{2019}t the same as done.", id: "handled",
                    isEmpty: sorted.handled.isEmpty
                ) {
                    ForEach(sorted.handled) { request in
                        RecoverRequestRow(recover: recover, request: request, mail: mail)
                        RowDivider(isLast: request.id == sorted.handled.last?.id)
                    }
                }

                if sorted.total > 0 {
                    foot(mail: mail)
                }

                DropdownSection(
                    "Help nearby", hint: "Hospitals, pharmacies, transit, time off and support.",
                    identifier: "recover.helpNearby"
                ) {
                    HelpNearbyView(address: session.careRecipient?.address, usesDropdowns: true)
                }
                .padding(.top, 24)
            }
            .refreshable { await recover.check(api: model.api) }
            .onChange(of: recover.actionCount) {
                withAnimation { proxy.scrollTo(Self.topID, anchor: .top) }
            }
        }
    }

    private func foot(mail: String) -> some View {
        VStack(spacing: 8) {
            Button {
                Task { await recover.check(api: model.api) }
            } label: {
                HStack(spacing: 8) {
                    if recover.checking {
                        ProgressView().tint(Theme.muted)
                    } else {
                        Image(systemName: "arrow.clockwise").accessibilityHidden(true)
                    }
                    Text(recover.checking ? "Checking for replies" : "Check for new replies")
                }
            }
            .buttonStyle(.quiet)
            .disabled(recover.checking)
            .accessibilityLabel(recover.checking ? "Checking for replies" : "Check for new replies")
            .accessibilityIdentifier("recover.check")
            if let checked = recover.checked {
                Text(checked)
                    .font(.rrNote)
                    .foregroundStyle(Theme.tealInk)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("recover.checked")
            }
            NoteText(RecoverLines.recordNote(mail: mail))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
    }
}

/// one titled group with its hint, shown only when it has rows
private struct RecoverGroup<Rows: View>: View {
    var title: String
    var hint: String
    var id: String
    var isEmpty: Bool
    /// set to show the group as a dropdown with this many rows in its header; it starts open
    var dropdownCount: Int?
    @ViewBuilder var rows: Rows

    var body: some View {
        if !isEmpty, let count = dropdownCount {
            DropdownSection(title, hint: hint, count: count, startsOpen: true, identifier: "recover.group.\(id)") {
                Card(padding: 0) {
                    VStack(alignment: .leading, spacing: 0) { rows }
                }
            }
            .padding(.top, 12)
        } else if !isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                    .foregroundStyle(Theme.muted)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityHint(hint)
                Text(hint)
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
                Card(padding: 0) {
                    VStack(alignment: .leading, spacing: 0) { rows }
                }
                .padding(.top, 6)
            }
            .padding(.top, 12)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("recover.group.\(id)")
        }
    }
}

private struct RowDivider: View {
    var isLast: Bool

    var body: some View {
        if !isLast {
            Rectangle().fill(Theme.hairline).frame(height: 1).accessibilityHidden(true)
        }
    }
}

/// one message: who, its state, the subject, where it stands, what's on record and its next steps
private struct RecoverRequestRow: View {
    @Environment(AppModel.self) private var model
    var recover: RecoverModel
    var request: RequestView
    var mail: String
    var hasNewTime = false
    /// only the not-sent group offers send and cancel
    var allowsActions = false

    private var name: String { request.recipient.name }
    private var canSend: Bool { allowsActions && request.state == .approved }
    private var canCancel: Bool { allowsActions && request.state == .awaitingApproval }
    private var isConfirming: Bool { canCancel && recover.confirming == request.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                InitialsAvatar(name: name, size: .small)
                Text(name)
                    .font(.rrBodyMedium.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                pill
            }
            .accessibilityElement(children: .combine)
            Text(request.subject)
                .font(Fonts.figtree(15, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(RecoverLines.statusLine(request, mail: mail))
                .font(.rrNote.monospacedDigit())
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("recover.status.\(request.id)")
            if request.state == .needsReview, let note = request.proposedNote, !note.isEmpty {
                Text("\u{201C}\(note)\u{201D}")
                    .font(Fonts.figtree(15, relativeTo: .subheadline))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 14)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Theme.hairline).frame(width: 3)
                    }
                    .padding(.vertical, 2)
            }
            if hasNewTime {
                Label("The new time is under New below.", systemImage: "calendar.badge.clock")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
            }
            RecoverRecord(request: request, mail: mail)
            actions
        }
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recover.row.\(request.id)")
    }

    @ViewBuilder
    private var pill: some View {
        if let label = RecoverLines.pillLabel(request) {
            TonePill(label, tone: .warn)
        } else {
            StatePill(state: request.state)
        }
    }

    @ViewBuilder
    private var actions: some View {
        if isConfirming {
            VStack(alignment: .leading, spacing: 10) {
                Text("Cancel the message to \(name)? It won\u{2019}t be sent, and this can\u{2019}t be undone.")
                    .font(Fonts.figtree(15, weight: .medium, relativeTo: .subheadline))
                    .foregroundStyle(Theme.warnInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("recover.confirmAsk.\(request.id)")
                let cancelling = recover.isBusy(request.id, .cancel)
                Button {
                    Task { await recover.cancel(request, api: model.api) }
                } label: {
                    Text(cancelling ? "Cancelling" : "Yes, don\u{2019}t send it")
                }
                .buttonStyle(.secondary(busy: cancelling))
                .disabled(recover.busy != nil)
                .accessibilityLabel(cancelling ? "Cancelling" : "Yes, don\u{2019}t send it")
                .accessibilityIdentifier("recover.confirmCancel.\(request.id)")
                Button("Keep it") { recover.confirming = nil }
                    .buttonStyle(.quiet)
                    .frame(maxWidth: .infinity)
                    .disabled(recover.busy != nil)
                    .accessibilityIdentifier("recover.keep.\(request.id)")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
            .padding(.top, 6)
        } else {
            VStack(spacing: 8) {
                if canSend {
                    let sending = recover.isBusy(request.id, .send)
                    Button {
                        Task { await recover.send(request, api: model.api, mail: mail) }
                    } label: {
                        HStack(spacing: 8) {
                            if !sending { Image(systemName: "paperplane").accessibilityHidden(true) }
                            Text(sending ? "Sending to \(name)" : "Send to \(name)")
                        }
                    }
                    .buttonStyle(.secondary(busy: sending))
                    .disabled(recover.busy != nil)
                    .accessibilityLabel(sending ? "Sending to \(name)" : "Send to \(name)")
                    .accessibilityIdentifier("recover.send.\(request.id)")
                }
                urgentButton
                if canCancel {
                    Button("Don\u{2019}t send it") { recover.confirming = request.id }
                        .buttonStyle(.quiet)
                        .disabled(recover.busy != nil)
                        .accessibilityIdentifier("recover.cancel.\(request.id)")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 6)
        }
    }

    @ViewBuilder
    private var urgentButton: some View {
        let label = RecoverLines.urgentLabel(request.state)
        let button = Button(label) { model.showUrgent(requestId: request.id) }
            .accessibilityIdentifier("recover.urgent.\(request.id)")
        if RecoverLines.urgentStep(request.state) != nil {
            button.buttonStyle(.secondary)
        } else {
            button.buttonStyle(.quiet)
        }
    }
}

/// "What's on record": the recorded state and every evidence row behind it, oldest first
private struct RecoverRecord: View {
    var request: RequestView
    var mail: String
    @State private var isOpen = false

    var body: some View {
        DisclosureGroup(isExpanded: $isOpen) {
            VStack(alignment: .leading, spacing: 10) {
                let code = Text(request.state.rawValue).font(.system(.footnote, design: .monospaced))
                Text("Recorded state: \(Labels.state(request.state)) \(code)")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                let events = Array(request.evidence.reversed())
                if events.isEmpty {
                    Text("No events recorded yet.").font(.rrNote).foregroundStyle(Theme.muted)
                } else {
                    ForEach(events) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(AlbertaTime.format(event.at))
                                .font(.rrNote.monospacedDigit())
                                .foregroundStyle(Theme.muted)
                            Text(RecoverLines.evidenceLine(event, request: request, mail: mail))
                                .font(.rrNote)
                                .foregroundStyle(Theme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .padding(.top, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text("What\u{2019}s on record")
                .font(Fonts.figtree(14, weight: .medium, relativeTo: .footnote))
                .foregroundStyle(Theme.tealInk)
                .frame(minHeight: 44, alignment: .leading)
        }
        .tint(Theme.tealInk)
        .accessibilityIdentifier("recover.record.\(request.id)")
    }
}

/// a time someone asked for on their reply link
private struct RecoverNewTimeRow: View {
    @Environment(AppModel.self) private var model
    var time: RecoverNewItem
    var from: RequestView?

    var body: some View {
        let name = from?.recipient.name
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "calendar.badge.clock")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.tealInk)
                    .frame(width: 30, height: 30)
                    .background(Theme.tealTint, in: .circle)
                    .accessibilityHidden(true)
                Text(RecoverLines.newTimeTitle(time.title))
                    .font(.rrBodyMedium.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(time.startsAt.map { AlbertaTime.format($0) } ?? "No time given yet")
                .font(.rrNote.monospacedDigit())
                .foregroundStyle(Theme.muted)
            Text(name.map { "\($0) asked for this time on their reply link." } ?? "From a reply link.")
                .font(Fonts.figtree(15, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let requestId = time.requestId {
                Button(name.map { "See the message to \($0) in Urgent" } ?? "See the message in Urgent") {
                    model.showUrgent(requestId: requestId)
                }
                .buttonStyle(.quiet)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("recover.newTime.urgent.\(time.id)")
            }
        }
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recover.newTime.\(time.id)")
    }
}

#Preview {
    NavigationStack { RecoverView() }
        .environment(AppModel())
}
