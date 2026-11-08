import SwiftUI

/// Urgent tab: the care week's impact on commitments (POST /api/impact), one decision at a time
/// (/api/commitments/*), the request editor, approve and send (/api/requests/*), "Send a text" (/api/sms/*),
/// and the summary of who was asked. embeds HelpNearbyView for supports near the care recipient.
struct UrgentView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        Group {
            if let session = model.session, let episode = session.episode {
                UrgentWeekView(api: model.api, session: session)
                    .id("\(model.config.baseURL.absoluteString)|\(episode.id)")
            } else {
                ScreenColumn {
                    QuestionHeader("Start by telling ReliefReady what\u{2019}s happening.", lead: "There\u{2019}s no care week yet.")
                    NoteText("It takes a sentence or two. Nothing is sent without your OK.")
                }
                .accessibilityIdentifier("screen.urgent")
            }
        }
        .screenTitle("Urgent")
    }
}

/// one care week: the steps, the letter and text sheets, and the summary
struct UrgentWeekView: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var flow: UrgentModel
    @State private var sms: SmsModel?
    @AccessibilityFocusState private var headingFocused: Bool
    private let session: Session

    init(api: APIClient, session: Session) {
        self.session = session
        let care = CareName(name: AppModel.recipientName(session), alias: session.careRecipient?.alias)
        _flow = State(initialValue: UrgentModel(
            api: api, episodeId: session.episode?.id ?? "", care: care, appNow: session.appNow,
            senderEmail: session.user.email, outbox: session.mode.mail == "outbox", aiMode: session.mode.ai
        ))
    }

    var body: some View {
        content
            .task { await flow.load() }
            .task(id: flow.textsMoving) {
                // while a text is still on its way, ask again every few seconds for up to three minutes
                guard flow.textsMoving else { return }
                let started = Date()
                while !Task.isCancelled, Date().timeIntervalSince(started) < 180 {
                    try? await Task.sleep(for: .seconds(4))
                    if Task.isCancelled { return }
                    await flow.loadTexts()
                }
            }
            .onChange(of: appModel.session?.appNow) { _, now in
                // a moved demo clock can expire requests, so the list follows the app time
                guard let now, now != flow.appNow else { return }
                flow.appNow = now
                Task { await flow.loadList() }
            }
            .onChange(of: LinkWait(link: appModel.urgentLink?.id, ready: flow.isReady, listed: flow.isListed), initial: true) {
                consumeLink()
            }
            .onChange(of: flow.index) { _, _ in
                guard flow.moved else { return }
                focusHeadingSoon()
            }
            .onChange(of: flow.focusSummary) { _, _ in
                // a send from the summary: its heading takes the focus once the letter has gone
                focusHeadingSoon()
            }
            .sheet(item: Binding(get: { flow.letter }, set: { if $0 == nil { flow.closeLetter() } })) { letter in
                // the stack gives the keyboard its Done bar; its own bar stays hidden
                NavigationStack {
                    LetterSheet(letter: letter) { flow.closeLetter() }
                        .toolbar(.hidden, for: .navigationBar)
                }
                .interactiveDismissDisabled(letter.busy != nil)
                .presentationDetents([.large])
                .rrSheet()
            }
            .sheet(item: $sms, onDismiss: { flow.smsOpen = false }) { model in
                NavigationStack {
                    SmsSheet(sms: model) { sms = nil }
                        .toolbar(.hidden, for: .navigationBar)
                }
                .interactiveDismissDisabled(model.busy != nil)
                    .presentationDetents([.large])
                    .rrSheet()
            }
    }

    private func focusHeadingSoon() {
        Task {
            try? await Task.sleep(for: .milliseconds(350))
            headingFocused = true
        }
    }

    /// a link from another tab, once the week and the list have loaded (an unloaded list drops the message part)
    private func consumeLink() {
        guard let link = appModel.urgentLink, flow.isReady else { return }
        if link.requestId != nil, !flow.isListed { return }
        appModel.urgentLink = nil
        if let requestId = link.requestId, flow.all != nil {
            Task { await flow.openLinked(requestId) }
        } else if link.fromStart {
            focusHeadingSoon()
        }
    }

    @ViewBuilder private var content: some View {
        if let error = flow.impactError, flow.impact == nil {
            ScreenColumn {
                QuestionHeader("Your week didn\u{2019}t load.")
                ErrorNote(error) { Task { await flow.retryImpact() } }
            }
            .accessibilityIdentifier("screen.urgent")
        } else if !flow.isReady {
            LoadingView("Checking your week")
                .pageBackground()
                .accessibilityIdentifier("screen.urgent")
        } else if flow.total == 0 {
            ScreenColumn {
                QuestionHeader(
                    "No one needs a message.",
                    lead: "Nothing in your calendar clashes with \(Labels.possessive(flow.care.name)) care week."
                )
                HelpNearbyView(address: session.careRecipient?.address)
            }
            .accessibilityIdentifier("screen.urgent")
        } else {
            ScrollViewReader { proxy in
                steps
                    // a new step, or a receipt above the same one, starts at the top
                    .onChange(of: flow.index) { _, _ in proxy.scrollTo("urgent.top", anchor: .top) }
                    .onChange(of: flow.receipt) { _, receipt in
                        if receipt != nil { withAnimation { proxy.scrollTo("urgent.top", anchor: .top) } }
                    }
            }
        }
    }

    private var steps: some View {
        Group {
            ScreenColumn {
                StepProgress(
                    total: flow.total,
                    current: flow.index ?? 0,
                    labels: flow.commitments.map(\.title),
                    onBack: (flow.index ?? 0) > 0 ? { flow.back() } : nil
                )
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("urgent.progress")
                .id("urgent.top")
                if flow.onSummary {
                    Text("\(flow.decidedCount) of \(flow.total) decided")
                        .font(.rrNote)
                        .foregroundStyle(Theme.muted)
                        .padding(.top, -14)
                        .accessibilityIdentifier("urgent.decidedCount")
                }
                Group {
                    if let index = flow.index, index < flow.total {
                        let c = flow.commitments[index]
                        stepView(c, flow.statusOf(c), at: index)
                            .id("\(c.id):\(flow.statusOf(c).kindKey)")
                    } else {
                        summaryView.id("summary")
                    }
                }
                .transition(stepTransition)
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.26), value: flow.index)
            .accessibilityIdentifier("screen.urgent")
        }
    }

    private var stepTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .move(edge: flow.forward ? .trailing : .leading).combined(with: .opacity),
            removal: .opacity
        )
    }

    // MARK: - pieces

    private var receiptView: some View {
        Group {
            if let receipt = flow.receipt {
                Receipt(receipt.text, systemImage: receipt.icon.systemImage)
                    .accessibilityIdentifier("urgent.receipt")
            }
        }
    }

    @ViewBuilder private var listProblem: some View {
        if let error = flow.listError {
            ErrorNote("Your messages didn\u{2019}t load. \(error)") { Task { await flow.loadList() } }
        }
    }

    @ViewBuilder private func errorFor(_ at: String) -> some View {
        if let error = flow.stepError, error.at == at {
            ErrorNote(error.message).accessibilityIdentifier("urgent.error")
        }
    }

    private func question(_ text: String, lead: String?) -> some View {
        QuestionHeader(text, lead: lead)
            .accessibilityFocused($headingFocused)
            .accessibilityIdentifier("urgent.question")
            .padding(.bottom, -8)
    }

    private func meta(_ c: Commitment) -> some View {
        let people = UrgentWords.withNames(c, flow.directory)
        // the code rule's own reason, never the model's
        let conflict = c.ruleConflicts.first ?? c.conflictReason
        return VStack(alignment: .leading, spacing: 6) {
            MetaLine(systemImage: "clock", text: UrgentWords.whenLine(c))
            if let conflict { MetaLine(systemImage: "calendar.badge.exclamationmark", text: conflict) }
            if let location = c.location, !location.isEmpty { MetaLine(systemImage: "mappin.and.ellipse", text: location) }
            if !people.isEmpty { MetaLine(systemImage: "person.2", text: "With \(UrgentWords.joinNames(people))") }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("urgent.meta")
    }

    private func busy(_ c: Commitment, _ what: String) -> Bool { flow.busy == "\(c.id):\(what)" }

    private func otherBusy(_ c: Commitment, _ what: String) -> Bool {
        flow.busy != nil && flow.busy != "\(c.id):\(what)"
    }

    private func changePlanButton(_ c: Commitment) -> some View {
        UrgentButton(
            title: "Change the plan", kind: .quiet, isBusy: busy(c, "reopen"), busyTitle: "Opening",
            identifier: "urgent.changePlan"
        ) { Task { await flow.reopen(c) } }
        .disabled(otherBusy(c, "reopen"))
    }

    private func nextButton(_ at: Int, kind: UrgentButton.Kind) -> some View {
        UrgentButton(title: flow.nextLabel(at), kind: kind, identifier: "urgent.next") { flow.next(from: at) }
    }

    private func proposalView(_ r: RequestView) -> some View {
        Group {
            if UrgentWords.isProposal(r) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(r.proposedAt.map { "Suggested \(UrgentWords.stamp($0))" } ?? "Asked for another time")
                        .font(.rrBodyMedium)
                        .foregroundStyle(Theme.ink)
                    if let note = r.proposedNote, !note.isEmpty {
                        Text("\u{201C}\(note)\u{201D}").font(.rrNote).foregroundStyle(Theme.muted)
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radiusSmall))
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private func messagesSoFar(_ list: [RequestView]) -> some View {
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                GroupTitle("Messages so far").padding(.bottom, 4)
                ForEach(Array(list.enumerated()), id: \.element.id) { offset, r in
                    if offset > 0 { Hairline() }
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.recipient.name).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                            if let at = UrgentWords.changedAt(r) {
                                Text(UrgentWords.stamp(at)).font(.rrNote).foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer(minLength: 8)
                        StatePill(state: r.state)
                    }
                    .padding(.vertical, 12)
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 12)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("urgent.messagesSoFar")
        }
    }

    // MARK: - a step

    @ViewBuilder private func stepView(_ c: Commitment, _ status: StepStatus, at: Int) -> some View {
        let fact = UrgentWords.factLine(c, flow.care, appNow: flow.appNow)
        let whose = Labels.possessive(flow.care.name)
        VStack(alignment: .leading, spacing: 16) {
            receiptView
            switch status {
            case .decided(let decision, let requests):
                let onTimeline = flow.added.contains(c.id)
                let outcome = decision == .keep
                    ? (c.forCareRecipient && onTimeline ? "You\u{2019}re keeping it. It\u{2019}s on \(whose) timeline." : "You\u{2019}re keeping it.")
                    : "You\u{2019}ll decide later."
                meta(c)
                question(outcome, lead: fact)
                ButtonStack {
                    nextButton(at, kind: .primary)
                    if c.forCareRecipient && !onTimeline {
                        UrgentButton(
                            title: "Add to \(whose) timeline", kind: .secondary, systemImage: "calendar.badge.plus",
                            isBusy: busy(c, "timeline"), busyTitle: "Adding it", identifier: "urgent.addTimeline"
                        ) { Task { await flow.addTimeline(c, advance: false) } }
                    }
                    if !c.forCareRecipient { changePlanButton(c) }
                }
                errorFor(c.id)
                messagesSoFar(requests)

            case .asked(let requests, let lead):
                let who = UrgentWords.shortName(lead.recipient.name)
                // one message per person on a group commitment, the newest for each
                let active = UrgentWords.newestPerPerson(requests).latest.filter { $0.action == lead.action }
                let several = active.count > 1
                let reviewable = several
                    ? active.contains { UrgentModel.reviewable.contains($0.state) }
                    : UrgentModel.reviewable.contains(lead.state)
                meta(c)
                question(several ? UrgentWords.outcomeLineMany(active) : UrgentWords.outcomeLine(lead), lead: fact)
                if several {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(active.enumerated()), id: \.element.id) { offset, r in
                            if offset > 0 { Hairline() }
                            requestRow(r, commitment: nil)
                        }
                    }
                } else {
                    proposalView(lead)
                }
                ButtonStack {
                    if reviewable && !several {
                        UrgentButton(
                            title: UrgentWords.isProposal(lead) ? "Write back to \(who)" : "Review and send",
                            kind: .primary, identifier: "urgent.review"
                        ) { flow.openLetter(lead.id) }
                    }
                    nextButton(at, kind: reviewable ? .secondary : .primary)
                    changePlanButton(c)
                }
                errorFor(c.id)
                messagesSoFar(several ? requests.filter { r in !active.contains { $0.id == r.id } } : requests)

            case .open(let requests):
                if c.forCareRecipient {
                    meta(c)
                    question("You\u{2019}re keeping it. Add it to \(whose) timeline?", lead: fact)
                    ButtonStack {
                        UrgentButton(
                            title: "Add to \(whose) timeline", kind: .primary, systemImage: "calendar.badge.plus",
                            isBusy: busy(c, "timeline"), busyTitle: "Adding it", identifier: "urgent.addTimeline"
                        ) { Task { await flow.addTimeline(c, advance: true) } }
                        .disabled(otherBusy(c, "timeline"))
                        NoteText("It\u{2019}s \(whose) own appointment, so no message goes out.")
                        UrgentButton(
                            title: Labels.decisionChoice(.keep), kind: .quiet, isBusy: busy(c, "keep"), busyTitle: "Saving",
                            identifier: "urgent.decision.keep"
                        ) { Task { await flow.choose(c, .keep) } }
                        .disabled(otherBusy(c, "keep"))
                    }
                    errorFor(c.id)
                } else {
                    openStep(c, requests: requests, fact: fact)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// open: the suggested decision first, the sensible others beside it, keeping it last
    @ViewBuilder private func openStep(_ c: Commitment, requests: [RequestView], fact: String) -> some View {
        // a saved message decision leads; after keeping or deferring, changing the plan starts from the suggestion again
        let suggested: Decision? = UrgentWords.isMessageDecision(c.decision) ? c.decision : c.suggestedAction
        let to = flow.recipientsOf(c)
        let names = to.compactMap { flow.directory[$0] }.map { UrgentWords.shortName($0.name) }
        let who = names.isEmpty ? "them" : UrgentWords.joinNames(names)
        let plan = Self.plan(suggested: suggested, who: who)

        if flow.impact?.modelStatus == .unavailable {
            NoteText("Suggestions aren\u{2019}t available right now, so pick what fits.", alignment: .leading)
        }
        meta(c)
        question(plan.ask, lead: fact)
        if c.contacts.count > 1 {
            VStack(alignment: .leading, spacing: 8) {
                GroupTitle("Who hears from you")
                Text("Each person gets their own message. You\u{2019}ll read and send each one.")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                ForEach(c.contacts, id: \.contactId) { contact in
                    RadioRow(
                        title: contact.name, hint: contact.group, selected: flow.isPicked(c, contact.contactId),
                        checkbox: true, identifier: "urgent.pick.\(contact.contactId)"
                    ) { flow.togglePick(c, contact.contactId, on: !flow.isPicked(c, contact.contactId)) }
                    .disabled(flow.busy != nil)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("urgent.pick")
        }
        ButtonStack {
            decisionButton(c, plan.primary, kind: .primary)
            if MessageDecision(plan.primary) != nil {
                NoteText(
                    to.count > 1
                        ? "You\u{2019}ll read each message before anything is sent."
                        : "You\u{2019}ll read the message before anything is sent."
                )
            }
            ChoiceRow {
                ForEach(plan.others, id: \.self) { decisionButton(c, $0, kind: .secondary) }
            }
            decisionButton(c, plan.quiet, kind: .quiet)
        }
        errorFor(c.id)
        messagesSoFar(requests)
    }

    /// the ask and the buttons for an open step
    static func plan(suggested: Decision?, who: String) -> (primary: Decision, ask: String, others: [Decision], quiet: Decision) {
        if suggested == .keep {
            return (.keep, "Keep it as planned?", [.notify, .reschedule], .defer)
        }
        if suggested == .defer {
            return (.defer, "Decide about it later?", [.notify, .reschedule], .keep)
        }
        let primary = MessageDecision(suggested) ?? .notify
        return (primary.decision, UrgentWords.askLine(primary, who), UrgentWords.alternatives(primary), .keep)
    }

    private func decisionButton(_ c: Commitment, _ decision: Decision, kind: UrgentButton.Kind) -> some View {
        UrgentButton(
            title: Labels.decisionChoice(decision), kind: kind, isBusy: busy(c, decision.rawValue),
            busyTitle: MessageDecision(decision) != nil ? "Writing the message" : "Saving",
            identifier: "urgent.decision.\(decision.rawValue)"
        ) { Task { await flow.choose(c, decision) } }
        .disabled(otherBusy(c, decision.rawValue))
    }

    // MARK: - rows

    private func rowTime(_ r: RequestView) -> String? {
        let at = UrgentWords.changedAt(r)
        if r.state == .requested {
            var out = ""
            if let at {
                let stamp = UrgentWords.stamp(at)
                out += "Sent \(stamp)\(stamp.hasSuffix(".") ? " " : ". ")"
            }
            if let by = r.respondBy {
                let stamp = UrgentWords.stamp(by)
                out += "Reply by \(stamp)\(stamp.hasSuffix(".") ? "" : ".")"
            }
            return out.isEmpty ? nil : out.trimmingCharacters(in: .whitespaces)
        }
        guard let at else { return nil }
        var word = "Changed"
        switch r.state {
        case .accepted, .completed, .rejected: word = "Answered"
        case .awaitingApproval, .draft: word = "Written"
        case .approved: word = "Approved"
        case .expired: word = "Ran out of time"
        case .failed: word = "Tried"
        default: if UrgentWords.isProposal(r) { word = "Answered" }
        }
        return "\(word) \(UrgentWords.stamp(at))"
    }

    /// one message with its own review button; commitment is set where "Choose again" belongs (the summary)
    private func requestRow(_ r: RequestView, commitment c: Commitment?) -> some View {
        let who = UrgentWords.shortName(r.recipient.name)
        let reviewable = UrgentModel.reviewable.contains(r.state)
        let again = c != nil && UrgentModel.chooseAgain.contains(r.state)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                InitialsAvatar(name: r.recipient.name, size: .small)
                Text(r.recipient.name).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                StatePill(state: r.state)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(r.subject).font(.rrBody).foregroundStyle(Theme.ink)
                if let time = rowTime(r) {
                    Text(time).font(.rrNote).foregroundStyle(Theme.muted)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            proposalView(r)
            if reviewable || again {
                HStack(spacing: 10) {
                    if reviewable {
                        UrgentButton(
                            title: UrgentWords.isProposal(r) ? "Write back to \(who)" : "Review and send", kind: .secondary,
                            identifier: "urgent.row.review.\(r.id)",
                            accessibilityLabel: UrgentWords.isProposal(r) ? nil : "Review and send to \(who)"
                        ) { flow.openLetter(r.id) }
                    }
                    if again, let c {
                        UrgentButton(
                            title: "Choose again", kind: .quiet, isBusy: flow.busy == "\(c.id):reopen", busyTitle: "Opening",
                            identifier: "urgent.row.again.\(r.id)"
                        ) { Task { await flow.chooseAgain(c) } }
                    }
                }
            }
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("urgent.row.\(r.id)")
    }

    private func textRow(_ t: SmsView) -> some View {
        let time = SmsWords.deliveryTime(t)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                InitialsAvatar(name: t.recipient.label, size: .small)
                VStack(alignment: .leading, spacing: 0) {
                    Text(t.recipient.label).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                    Text(t.recipient.phoneMasked).font(.rrNote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                TonePill(SmsWords.deliveryLabel(t.delivery), tone: SmsWords.deliveryTone(t.delivery))
            }
            Text(t.body).font(.rrBody).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            Text([SmsWords.deliveryNote(t), time.map { "\($0.word) \(UrgentWords.stamp($0.at))" }].compactMap { $0 }.joined(separator: " "))
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("urgent.text.\(t.id)")
    }

    // MARK: - the summary

    private var summaryView: some View {
        let visible = flow.episodeRequests.filter { $0.state != .cancelled }
        let waiting = visible.contains { $0.state == .requested }
        let anything = visible.count + flow.texts.count
        let first = flow.commitments.first?.startsAt.map(UrgentWords.weekday) ?? "the first one"
        return VStack(alignment: .leading, spacing: 16) {
            receiptView
            listProblem
            if let problem = flow.linkProblem {
                ErrorNote(problem).accessibilityIdentifier("urgent.linkProblem")
            }
            question(
                anything == 0 ? "You haven\u{2019}t asked anyone." : "Here\u{2019}s who you asked",
                lead: anything == 0 ? "Nothing has gone out yet." : nil
            )
            UrgentButton(title: "Send a text", kind: .primary, systemImage: "message", identifier: "urgent.sendText") {
                openSms()
            }
            if anything == 0 {
                NoteText("Go back to a step and choose who to ask, or send someone a text.", alignment: .leading)
            }
            ForEach(UrgentModel.groups, id: \.title) { group in
                let rows = visible.filter { group.states.contains($0.state) }.sorted(by: UrgentWords.newestFirst)
                if !rows.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        GroupTitle(group.title)
                        if let hint = group.hint {
                            Text(hint).font(.rrNote).foregroundStyle(Theme.muted).padding(.top, 2)
                        }
                        ForEach(Array(rows.enumerated()), id: \.element.id) { offset, r in
                            if offset > 0 { Hairline() }
                            requestRow(r, commitment: flow.commitmentOf(r.id))
                        }
                    }
                    .padding(.top, 12)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("urgent.group.\(group.title)")
                }
            }
            if !flow.texts.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    GroupTitle("Texts")
                    Text("Delivery updates on their own while a text is on its way.")
                        .font(.rrNote).foregroundStyle(Theme.muted).padding(.top, 2)
                    ForEach(Array(flow.texts.enumerated()), id: \.element.id) { offset, t in
                        if offset > 0 { Hairline() }
                        textRow(t)
                    }
                }
                .padding(.top, 12)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("urgent.group.Texts")
            }
            if let problem = flow.textsProblem { ErrorNote(problem) }
            ButtonStack {
                if !visible.isEmpty {
                    UrgentButton(
                        title: "Check for replies", kind: .secondary, systemImage: "arrow.clockwise",
                        isBusy: flow.busy == "refresh", busyTitle: "Checking", identifier: "urgent.checkReplies"
                    ) { Task { await flow.checkReplies() } }
                }
                if let checked = flow.checkedAt {
                    NoteText("Checked \(UrgentWords.stamp(checked))").accessibilityIdentifier("urgent.checkedAt")
                }
                if flow.outbox && waiting {
                    NoteText("Replies come through the links in each email. In this demo, answer as them from the outbox.")
                }
                errorFor(UrgentModel.summaryKey)
                UrgentButton(title: "Start again from \(first)", kind: .quiet, identifier: "urgent.startAgain") {
                    flow.startAgain()
                }
            }
            .padding(.top, 8)
            HelpNearbyView(address: session.careRecipient?.address)
                .padding(.top, 20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func openSms() {
        flow.smsOpen = true
        sms = SmsModel(
            api: flow.api, episodeId: flow.episodeId, careAlias: flow.care.alias, aiMode: flow.aiMode,
            onChange: { [flow] text in flow.textChanged(text) }
        )
    }
}

extension StepStatus {
    /// changes when a step's kind changes, so its view is rebuilt
    var kindKey: String {
        switch self {
        case .open: "open"
        case .decided: "decided"
        case .asked: "asked"
        }
    }
}

extension SmsModel: Identifiable {
    nonisolated var id: ObjectIdentifier { ObjectIdentifier(self) }
}

/// what a pending link waits on before Urgent can open it
private struct LinkWait: Equatable {
    var link: UUID?
    var ready: Bool
    var listed: Bool
}
