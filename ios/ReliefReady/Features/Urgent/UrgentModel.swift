import Foundation
import Observation
import SwiftUI

/// where one commitment stands, from its decision and its messages (statusOf in UrgentFlow.tsx)
enum StepStatus: Equatable {
    case open(requests: [RequestView])
    case decided(decision: Decision, requests: [RequestView])
    case asked(requests: [RequestView], lead: RequestView)

    var isOpen: Bool {
        if case .open = self { return true }
        return false
    }

    var requests: [RequestView] {
        switch self {
        case .open(let list), .decided(_, let list), .asked(let list, _): list
        }
    }
}

/// a calm line about what just happened, with its icon
struct UrgentReceipt: Equatable {
    enum Icon: Equatable {
        case check, send, calendar, refresh

        var systemImage: String {
            switch self {
            case .check: "checkmark"
            case .send: "paperplane"
            case .calendar: "calendar.badge.plus"
            case .refresh: "arrow.clockwise"
            }
        }
    }

    var text: String
    var icon: Icon
}

/// a problem shown under one step, or under the summary ("summary")
struct UrgentStepError: Equatable {
    var at: String
    var message: String
}

/// the urgent flow: one commitment per step, then who was asked (Week in UrgentFlow.tsx)
@MainActor
@Observable
final class UrgentModel {
    static let summaryKey = "summary"

    /// states the letter can open on: it edits, approves and sends from there
    static let reviewable: Set<RequestState> = [.draft, .awaitingApproval, .approved, .needsReview]
    /// requests that cannot be reviewed again; their commitment needs a new choice
    static let chooseAgain: Set<RequestState> = [.failed, .expired, .rejected]

    /// the summary's groups, in order
    static let groups: [(title: String, hint: String?, states: Set<RequestState>)] = [
        (
            "Needs you", "Read these and send them, or choose again.",
            [.awaitingApproval, .draft, .approved, .needsReview, .failed, .expired]
        ),
        ("Waiting", nil, [.sending, .requested]),
        ("Answered", nil, [.accepted, .completed, .rejected]),
    ]

    // kept for the whole app run, so coming back to Urgent does not scan the calendar (a model call) again
    private static var impactCache: [String: ImpactResponse] = [:]
    private static var timelineCache: Set<String> = []
    static var flagsCache: [String: [String]] = [:]

    /// test hook: forget what earlier runs kept
    static func clearCaches() {
        impactCache = [:]
        timelineCache = []
        flagsCache = [:]
    }

    let api: any UrgentAPI
    let episodeId: String
    var care: CareName
    var appNow: String
    var senderEmail: String
    var outbox: Bool
    var aiMode: String

    var impact: ImpactResponse?
    var impactError: String?
    var all: [RequestView]?
    var listError: String?
    /// the step on screen; commitments.count or more is the summary
    var index: Int?
    /// who hears from Alex for a commitment with several contacts, in the server's order
    var picked: [String: [String]] = [:]
    var receipt: UrgentReceipt?
    var busy: String?
    var stepError: UrgentStepError?
    var letter: LetterModel?
    var smsOpen = false
    var added: Set<String>
    var checkedAt: String?
    var texts: [SmsView] = []
    var textsProblem: String?
    /// true once Alex moved between steps, so the new heading takes the voiceover focus
    var moved = false
    var forward = true

    init(
        api: any UrgentAPI, episodeId: String, care: CareName, appNow: String, senderEmail: String = "",
        outbox: Bool = true, aiMode: String = "demo"
    ) {
        self.api = api
        self.episodeId = episodeId
        self.care = care
        self.appNow = appNow
        self.senderEmail = senderEmail
        self.outbox = outbox
        self.aiMode = aiMode
        self.impact = Self.impactCache[episodeId]
        self.added = Self.timelineCache
    }

    // MARK: - derived

    var commitments: [Commitment] {
        (impact?.commitments ?? []).sorted { a, b in
            if a.startsAt == b.startsAt { return a.id < b.id }
            guard let x = a.startsAt else { return false }
            guard let y = b.startsAt else { return true }
            return (UrgentWords.time(x) ?? 0) < (UrgentWords.time(y) ?? 0)
        }
    }

    var total: Int { impact?.commitments.count ?? 0 }

    private var byId: [String: RequestView] {
        Dictionary((all ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    var directory: [String: UrgentPerson] { UrgentWords.buildDirectory(commitments, all ?? []) }

    var isReady: Bool { impact != nil && index != nil }

    var onSummary: Bool { (index ?? 0) >= total }

    func request(_ id: String) -> RequestView? { byId[id] }

    func requestsOf(_ c: Commitment) -> [RequestView] {
        let map = byId
        return c.requests.compactMap { map[$0.id] }.sorted(by: UrgentWords.newestFirst)
    }

    func statusOf(_ c: Commitment) -> StepStatus {
        let list = requestsOf(c)
        if c.reopened { return .open(requests: list) }
        if c.decision == .keep || c.decision == .defer { return .decided(decision: c.decision!, requests: list) }
        let active = list.filter { $0.state != .cancelled }
        if let lead = active.first { return .asked(requests: list, lead: lead) }
        return .open(requests: list)
    }

    func commitmentOf(_ requestId: String) -> Commitment? {
        commitments.first { c in c.requests.contains { $0.id == requestId } }
    }

    /// the requests that belong to this care week's commitments
    var episodeRequests: [RequestView] {
        let ids = Set(commitments.flatMap { $0.requests.map(\.id) })
        return (all ?? []).filter { ids.contains($0.id) }
    }

    var decidedCount: Int { commitments.filter { !statusOf($0).isOpen }.count }

    /// the contacts the next message goes to: Alex's ticks when there are several, else the server's match
    func recipientsOf(_ c: Commitment) -> [String] {
        let known = Set(c.contacts.map(\.contactId))
        if let chosen = picked[c.id] { return chosen.filter { known.contains($0) } }
        return UrgentWords.defaultRecipients(c, requestsOf(c))
    }

    func nextLabel(_ at: Int) -> String {
        let list = commitments
        guard at + 1 < list.count else { return "See who you asked" }
        return "Next: \(UrgentWords.buttonTitle(list[at + 1], care))"
    }

    // MARK: - loading

    func load() async {
        async let scan: Void = loadImpact()
        async let list: [RequestView]? = loadList()
        _ = await (scan, list)
        startIfReady()
        _ = await loadTexts()
    }

    func retryImpact() async {
        impactError = nil
        await loadImpact()
        startIfReady()
    }

    private func loadImpact() async {
        if let cached = Self.impactCache[episodeId] {
            impact = cached
            return
        }
        do throws(APIError) {
            let result = try await api.impact(episodeId: episodeId)
            Self.impactCache[episodeId] = result
            impact = result
            impactError = nil
        } catch {
            impactError = error.userMessage
        }
    }

    @discardableResult
    func loadList() async -> [RequestView]? {
        do throws(APIError) {
            let result = try await api.requests()
            all = result.requests
            listError = nil
            return result.requests
        } catch {
            listError = error.userMessage
            return nil
        }
    }

    /// the first screen: the first step still to decide, else the summary
    func startIfReady() {
        guard index == nil, impact != nil, all != nil || listError != nil else { return }
        let first = commitments.firstIndex { statusOf($0).isOpen }
        index = first ?? total
    }

    @discardableResult
    func loadTexts() async -> [SmsView]? {
        do throws(APIError) {
            let result = try await api.smsList(episodeId: episodeId)
            texts = result.texts
            textsProblem = nil
            return result.texts
        } catch {
            textsProblem = error.userMessage
            return nil
        }
    }

    /// true while a text can still change at the provider
    var textsMoving: Bool { texts.contains { SmsDelivery.moving.contains($0.delivery) } }

    // MARK: - local copies

    func upsert(_ next: RequestView) {
        var list = all ?? []
        if let at = list.firstIndex(where: { $0.id == next.id }) {
            list[at] = next
        } else {
            list.insert(next, at: 0)
        }
        all = list
    }

    /// the server's answer for one commitment goes into the screen and the run's copy of the scan
    private func patchCommitment(_ id: String, decision: Decision?? = nil, reopened: Bool? = nil, requests: [RequestView] = []) {
        guard var next = impact else { return }
        next.commitments = next.commitments.map { k in
            guard k.id == id else { return k }
            var k = k
            if let decision { k.decision = decision }
            if let reopened { k.reopened = reopened }
            let added = requests
                .filter { r in !k.requests.contains { $0.id == r.id } }
                .map { CommitmentRequestRef(id: $0.id, state: $0.state.rawValue, contactId: $0.recipient.contactId) }
            k.requests = added + k.requests
            return k
        }
        Self.impactCache[episodeId] = next
        impact = next
    }

    // MARK: - moving

    func go(_ next: Int, forward: Bool) {
        moved = true
        self.forward = forward
        stepError = nil
        index = max(0, min(total, next))
    }

    func next(from at: Int) {
        receipt = nil
        go(at + 1, forward: true)
    }

    func back() {
        guard let index, index > 0 else { return }
        receipt = nil
        go(index - 1, forward: false)
    }

    func startAgain() {
        receipt = nil
        go(0, forward: false)
    }

    /// moves on after a save, unless Alex already went to another step while it ran
    private func advance(from at: Int) {
        if index == at { go(at + 1, forward: true) }
    }

    private func say(_ text: String, _ icon: UrgentReceipt.Icon = .check) {
        receipt = UrgentReceipt(text: text, icon: icon)
        announce(text)
    }

    func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }

    // MARK: - actions

    func choose(_ c: Commitment, _ decision: Decision) async {
        guard busy == nil else { return }
        let here = index ?? 0
        busy = "\(c.id):\(decision.rawValue)"
        stepError = nil
        defer { busy = nil }
        do throws(APIError) {
            let message = MessageDecision(decision)
            let to = message != nil ? recipientsOf(c) : []
            if message != nil && c.contacts.count > 1 && to.isEmpty {
                stepError = UrgentStepError(at: c.id, message: "Choose at least one person to hear from you.")
                return
            }
            // a new plan withdraws messages for this commitment that were never sent, and any to people no longer chosen
            let unsent = requestsOf(c).filter { $0.state == .awaitingApproval || $0.state == .needsReview }
            let withdraw = message != nil
                ? unsent.filter { $0.action.rawValue != decision.rawValue || (!to.isEmpty && !to.contains($0.recipient.contactId)) }
                : unsent
            for r in withdraw { upsert(try await api.cancelRequest(id: r.id).request) }
            let result = try await api.decide(DecideInput(
                commitmentId: c.id, decision: decision,
                contactId: to.count == 1 ? to[0] : nil,
                contactIds: to.count > 1 ? to : nil
            ))
            let made = !result.requests.isEmpty ? result.requests : result.request.map { [$0] } ?? []
            patchCommitment(c.id, decision: .some(result.commitment.decision), reopened: false, requests: made)
            // ticks belong to this plan; changing it later starts again from who still needs to hear
            picked[c.id] = nil

            if !made.isEmpty {
                for request in made { upsert(request) }
                for draft in result.drafts where !draft.editFlags.isEmpty { Self.flagsCache[draft.requestId] = draft.editFlags }
                if result.drafts.isEmpty, let request = result.request, !result.editFlags.isEmpty {
                    Self.flagsCache[request.id] = result.editFlags
                }
                // each message opens on its own; the first one to review comes first
                if let first = made.first(where: { Self.reviewable.contains($0.state) }) {
                    receipt = nil
                    openLetter(first.id)
                    return
                }
                say("\(made.map(UrgentWords.outcomeLine).joined(separator: " ")) No new message was written.")
                return
            }
            let ref = UrgentWords.refTitle(c, care)
            let names = UrgentWords.joinNames(withdraw.map { UrgentWords.shortName($0.recipient.name) })
            let lead = result.commitment.decision == .defer ? "You\u{2019}ll decide about \(ref) later." : "Keeping \(ref)."
            say(withdraw.isEmpty ? lead : "\(lead) The unsent message to \(names) was withdrawn.")
            advance(from: here)
        } catch {
            stepError = UrgentStepError(at: c.id, message: error.userMessage)
        }
    }

    func addTimeline(_ c: Commitment, advance shouldAdvance: Bool) async {
        guard busy == nil else { return }
        let here = index ?? 0
        busy = "\(c.id):timeline"
        stepError = nil
        defer { busy = nil }
        do throws(APIError) {
            let result = try await api.addToTimeline(commitmentId: c.id)
            Self.timelineCache.insert(c.id)
            added = Self.timelineCache
            if c.decision != .keep {
                let kept = try await api.decide(DecideInput(commitmentId: c.id, decision: .keep))
                patchCommitment(c.id, decision: .some(kept.commitment.decision), reopened: false)
            }
            let whose = UrgentWords.possessive(care.name)
            say(result.created ? "Added to \(whose) timeline in Care." : "It was already on \(whose) timeline.", .calendar)
            if shouldAdvance { advance(from: here) }
        } catch {
            stepError = UrgentStepError(at: c.id, message: error.userMessage)
        }
    }

    func checkReplies() async {
        guard busy == nil else { return }
        busy = "refresh"
        stepError = nil
        defer { busy = nil }
        let before = Dictionary(episodeRequests.map { ($0.id, $0.state) }, uniquingKeysWith: { first, _ in first })
        do throws(APIError) {
            let result = try await api.refreshRequests()
            all = result.requests
            listError = nil
            checkedAt = result.appNow
            let changed = result.requests.filter { r in before[r.id].map { $0 != r.state } ?? false }
            say(changed.isEmpty ? "No new replies yet." : changed.map(UrgentWords.outcomeLine).joined(separator: " "), .refresh)
            _ = await loadTexts()
        } catch {
            stepError = UrgentStepError(at: Self.summaryKey, message: error.userMessage)
        }
    }

    /// "Change the plan": saved on the server, so the step stays open after a reload; no message changes here
    func reopen(_ c: Commitment) async {
        guard busy == nil else { return }
        busy = "\(c.id):reopen"
        stepError = nil
        defer { busy = nil }
        do throws(APIError) {
            _ = try await api.reopen(commitmentId: c.id)
            moved = true
            receipt = nil
            patchCommitment(c.id, reopened: true)
        } catch {
            stepError = UrgentStepError(at: c.id, message: error.userMessage)
        }
    }

    /// "Choose again" from the summary: opens that step again and goes back to it
    func chooseAgain(_ c: Commitment) async {
        guard busy == nil, let at = commitments.firstIndex(where: { $0.id == c.id }) else { return }
        busy = "\(c.id):reopen"
        stepError = nil
        defer { busy = nil }
        do throws(APIError) {
            _ = try await api.reopen(commitmentId: c.id)
            patchCommitment(c.id, reopened: true)
            receipt = nil
            go(at, forward: false)
        } catch {
            stepError = UrgentStepError(at: Self.summaryKey, message: error.userMessage)
        }
    }

    func isPicked(_ c: Commitment, _ contactId: String) -> Bool {
        recipientsOf(c).contains(contactId)
    }

    func togglePick(_ c: Commitment, _ contactId: String, on: Bool) {
        let now = recipientsOf(c)
        let next = on ? now.filter { $0 != contactId } + [contactId] : now.filter { $0 != contactId }
        // keep the server's order, so the first message is always the same person
        picked[c.id] = c.contacts.map(\.contactId).filter { next.contains($0) }
    }

    // MARK: - the letter

    /// opens the letter for one request on screen
    func openLetter(_ requestId: String) {
        guard let request = byId[requestId] else { return }
        let who = UrgentWords.shortName(request.recipient.name)
        let proposal = UrgentWords.isProposal(request)
        let title = proposal
            ? "Write back to \(who)"
            : MessageDecision(request.action).map { UrgentWords.sheetTitle($0, who) } ?? "Let \(who) know"
        let lead: String
        if proposal {
            lead = request.proposedAt.map {
                "\(who) suggested \(UrgentWords.endSentence(UrgentWords.stamp($0))) Change the message to answer, then send it."
            } ?? "\(who) asked for another time. Change the message to answer, then send it."
        } else {
            lead = "Change any words you like. Nothing goes out until you send it."
        }
        letter = LetterModel(
            api: api, request: request, title: title, lead: lead, flags: Self.flagsCache[request.id] ?? [],
            senderEmail: senderEmail, outbox: outbox, careAlias: care.alias,
            onUpdate: { [weak self] in self?.upsert($0) },
            onSent: { [weak self] request, outcome in self?.sent(request, outcome) },
            reload: { [weak self] id in await self?.loadList()?.first(where: { $0.id == id }) },
            onFlags: { id, flags in
                if flags.isEmpty { Self.flagsCache[id] = nil } else { Self.flagsCache[id] = flags }
            }
        )
    }

    /// the letter was swiped or tapped closed; typed words are saved, never sent
    func closeLetter() {
        guard let closing = letter else { return }
        letter = nil
        Task {
            let note = await closing.saveOnClose()
            announce(note)
        }
    }

    /// the send finished: sent, or the mail adapter recorded a failure
    func sent(_ request: RequestView, _ outcome: SendResult) {
        let who = UrgentWords.shortName(request.recipient.name)
        let c = commitmentOf(request.id)
        let at = c.flatMap { c in commitments.firstIndex { $0.id == c.id } } ?? -1
        let fromStep = index.map { $0 < total && at == $0 } ?? false
        letter = nil
        Task { await loadList() }
        if case .failed = outcome {
            receipt = nil
            stepError = UrgentStepError(
                at: fromStep ? (c?.id ?? Self.summaryKey) : Self.summaryKey,
                message: "The message to \(who) didn\u{2019}t send, and it won\u{2019}t retry on its own. Choose again to write a new one."
            )
            return
        }
        // a group commitment: the next person's message waits on this step for its own read and send
        let waiting = c.map { c in
            requestsOf(c).filter { $0.id != request.id && Self.reviewable.contains($0.state) && !UrgentWords.isProposal($0) }
        } ?? []
        if fromStep, let nextOne = waiting.first {
            say("Sent to \(who). \(UrgentWords.possessive(UrgentWords.shortName(nextOne.recipient.name))) message is next.", .send)
            return
        }
        say("Sent to \(who). Waiting for a reply.", .send)
        if fromStep { go((index ?? 0) + 1, forward: true) }
    }

    // MARK: - texts

    /// a text was approved or sent in the sheet; the summary lists it with its status
    func textChanged(_ text: SmsView?) {
        if let text { texts = [text] + texts.filter { $0.id != text.id } }
        Task { await loadTexts() }
    }
}
