import Foundation
import Observation
import SwiftUI

/// the letter: read, edit and send one message. nothing goes out without the send button that names the person
/// (LetterSheet.tsx)
@MainActor
@Observable
final class LetterModel: Identifiable {
    enum Busy: Equatable {
        case send, anyway, remove, tier
    }

    /// what was last loaded from the server; the typed words are compared with it
    struct Base: Equatable {
        var id: String
        var revision: String
        var subject: String
        var body: String
    }

    static let editableStates: Set<RequestState> = [.draft, .awaitingApproval, .needsReview]

    /// typed words not yet saved to the server, kept for the app run so closing the sheet loses nothing
    private static var typed: [String: Base] = [:]

    static func clearTyped() { typed = [:] }

    let api: any UrgentAPI
    let title: String
    let lead: String
    let senderEmail: String
    let outbox: Bool
    let careAlias: String?

    private(set) var current: RequestView
    private(set) var base: Base
    private(set) var flags: [String]
    var subject: String
    var body: String
    private(set) var busy: Busy?
    var error: String?
    /// terms the server named when it refused an approval
    private(set) var refused: [String] = []
    /// a tier Alex picked but hasn't applied yet; nothing is rewritten or sent until Alex chooses below the picker
    private(set) var askTier: DisclosureTier?

    private let onUpdate: (RequestView) -> Void
    private let onSent: (RequestView, SendResult) -> Void
    private let reload: (String) async -> RequestView?
    private let onFlags: (String, [String]) -> Void

    nonisolated var id: String { requestId }
    private nonisolated let requestId: String

    init(
        api: any UrgentAPI, request: RequestView, title: String, lead: String, flags: [String], senderEmail: String,
        outbox: Bool, careAlias: String?,
        onUpdate: @escaping (RequestView) -> Void,
        onSent: @escaping (RequestView, SendResult) -> Void,
        reload: @escaping (String) async -> RequestView?,
        onFlags: @escaping (String, [String]) -> Void
    ) {
        self.api = api
        self.requestId = request.id
        self.current = request
        self.title = title
        self.lead = lead
        self.flags = flags
        self.senderEmail = senderEmail
        self.outbox = outbox
        self.careAlias = careAlias
        self.onUpdate = onUpdate
        self.onSent = onSent
        self.reload = reload
        self.onFlags = onFlags
        self.base = Base(id: request.id, revision: request.revision, subject: request.subject, body: request.body)
        if let kept = Self.typed[request.id], kept.revision == request.revision {
            subject = kept.subject
            body = kept.body
        } else {
            subject = request.subject
            body = request.body
        }
    }

    // MARK: - derived

    var dirty: Bool { subject != base.subject || body != base.body }
    var editable: Bool { Self.editableStates.contains(current.state) }
    var name: String { UrgentWords.shortName(current.recipient.name) }

    var terms: [String] {
        var out: [String] = []
        for term in current.healthTermsFound + refused where !out.contains(term) { out.append(term) }
        return out
    }

    /// health words hold the approval back for the minimal and general tiers until Alex removes them or says send anyway
    static func blocks(_ request: RequestView, extra: [String]) -> Bool {
        if request.disclosureTier == .detailed || request.state == .approved || request.healthOverride { return false }
        return !request.healthTermsFound.isEmpty || !extra.isEmpty
    }

    var blocked: Bool { Self.blocks(current, extra: refused) }

    /// a picked level that differs from the saved one
    var pendingTier: DisclosureTier? {
        guard let askTier, askTier != current.disclosureTier else { return nil }
        return askTier
    }

    var shownTier: DisclosureTier { pendingTier ?? current.disclosureTier }

    var flagNotes: [String] { flags.compactMap { UrgentWords.editFlagNote($0, name) } }

    var leadLine: String { editable ? lead : "You approved these exact words. Send them when you\u{2019}re ready." }

    var closeLabel: String { dirty && editable ? "Close and save your changes" : "Close" }

    var tierNote: String {
        if busy == .tier { return "Changing how much it shares" }
        return editable ? "Changing this needs your OK again before it goes." : "Shared at this level when you approved it."
    }

    var tierQuestion: String? {
        guard let pendingTier else { return nil }
        let label = UrgentWords.tierLabel(pendingTier, alias: careAlias)
        if dirty { return "You\u{2019}ve changed the words. Write it again as \u{201C}\(label)\u{201D}, or keep your words?" }
        if UrgentWords.isProposal(current) { return "Share it as \u{201C}\(label)\u{201D}? Your words stay as they are." }
        return "Share it as \u{201C}\(label)\u{201D}? The message is written again at this level."
    }

    /// the note under the send button when health words are allowed through
    var allowedNote: String? {
        guard !blocked, !terms.isEmpty else { return nil }
        let words = UrgentWords.quoted(terms)
        if current.disclosureTier == .detailed {
            if let group = current.defaultDisclosureTier, group != .detailed {
                return "It mentions \(words). You chose to share more detail with \(name), so it can go as written."
            }
            return "It mentions \(words). \(Labels.possessive(name)) group is set to hear more detail, so it can go as written."
        }
        return "It mentions \(words). You chose to send it anyway."
    }

    var sendNote: String {
        outbox
            ? "Goes to the demo outbox from \(senderEmail). No real email is sent."
            : "Sends by email from \(senderEmail)."
    }

    // MARK: - typing

    func setSubject(_ text: String) {
        subject = text.replacingOccurrences(of: "\n", with: " ")
        keep()
    }

    func setBody(_ text: String) {
        body = text
        keep()
    }

    /// every keystroke is kept for the app run until it is saved or sent
    private func keep() {
        Self.typed[current.id] = Base(id: current.id, revision: current.revision, subject: subject, body: body)
    }

    private func load(_ next: RequestView) {
        current = next
        base = Base(id: next.id, revision: next.revision, subject: next.subject, body: next.body)
        subject = next.subject
        body = next.body
    }

    private func announce(_ text: String) {
        AccessibilityNotification.Announcement(text).post()
    }

    private func sendProblem(_ error: APIError) -> String {
        if error.status == 0 || error.status >= 500 {
            return "The mail service didn\u{2019}t answer. Try sending again in a moment."
        }
        return error.userMessage
    }

    // MARK: - closing

    /// the sheet closed: typed changes are saved on the server (or kept here); returns what voiceover says
    func saveOnClose() async -> String {
        guard dirty, editable else { return "Closed. Nothing was sent." }
        let words = Base(id: current.id, revision: current.revision, subject: subject, body: body)
        if subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Self.typed[current.id] = words
            return "Closed. Your changes are kept here. Nothing was sent."
        }
        do throws(APIError) {
            let saved = try await api.editRequest(
                id: current.id, changes: RequestChanges(subject: UrgentWords.oneLine(subject), body: body)
            )
            Self.typed[current.id] = nil
            onUpdate(saved.request)
            load(saved.request)
            return "Your changes are saved. Nothing was sent."
        } catch {
            Self.typed[current.id] = words
            return "Your changes are kept here but weren\u{2019}t saved. \(error.userMessage)"
        }
    }

    // MARK: - sending

    private func staleAgain(_ id: String) async {
        if let fresh = await reload(id) {
            Self.typed[id] = nil
            load(fresh)
        }
        refused = []
        error = "This message changed. Review it again."
    }

    func send(override: Bool) async {
        guard busy == nil else { return }
        // the picker shows a level that isn't saved yet; approving now would approve the old one
        if pendingTier != nil {
            error = "Finish changing how much it shares, or cancel it, before you send."
            return
        }
        if subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = "Add a subject and a message before sending."
            return
        }
        busy = override ? .anyway : .send
        error = nil
        defer { busy = nil }
        var working = current
        var sending = false
        do throws(APIError) {
            // typed changes, a draft or a reply to review go back to the approval queue first
            if Self.editableStates.contains(working.state) && (dirty || working.state != .awaitingApproval) {
                let changes = dirty ? RequestChanges(subject: UrgentWords.oneLine(subject), body: body) : RequestChanges()
                working = try await api.editRequest(id: working.id, changes: changes).request
                Self.typed[working.id] = nil
                onUpdate(working)
                load(working)
                refused = []
                if !override && Self.blocks(working, extra: []) {
                    announce("The message mentions \(UrgentWords.quoted(working.healthTermsFound)). Choose what to do before it goes.")
                    return
                }
            }
            if working.state == .awaitingApproval {
                // the approval names the exact revision on screen; the client sends it as If-Match
                working = try await api.approveRequest(id: working.id, revision: working.revision, healthOverride: override).request
                current = working
                onUpdate(working)
            }
            guard working.state == .approved else {
                error = "This message is now \u{201C}\(Labels.state(working.state))\u{201D}, so it can\u{2019}t be sent from here."
                return
            }
            sending = true
            let result = try await api.sendRequest(id: working.id)
            if case .needsReview = result {
                if let fresh = await reload(working.id) { load(fresh) }
                error = "Nothing was sent. The message changed after you approved it. Review it again."
                return
            }
            Self.typed[working.id] = nil
            onSent(working, result)
        } catch {
            if error.status == 412 || error.status == 428 {
                await staleAgain(working.id)
            } else if error.status == 409 {
                // changed in another screen (sent, withdrawn, answered): show what it is now
                let fresh = await reload(working.id)
                if let fresh, !Self.editableStates.contains(fresh.state) { Self.typed[fresh.id] = nil }
                if let fresh { load(fresh) }
                self.error = fresh.map {
                    "This message changed somewhere else. It\u{2019}s now \u{201C}\(Labels.state($0.state))\u{201D}."
                } ?? "This message changed somewhere else. Close this and check your list."
            } else if error.code == "health_terms" {
                let named = error.terms.isEmpty ? working.healthTermsFound : error.terms
                refused = named
                announce("The message mentions \(UrgentWords.quoted(named)). Choose what to do before it goes.")
            } else if sending {
                // approved, but the send itself failed before anything went out; the same button tries again
                self.error = "It\u{2019}s approved but didn\u{2019}t go out. \(sendProblem(error))"
            } else {
                self.error = error.userMessage
            }
        }
    }

    /// "Remove them": drops the flagged health words from the subject and body and saves
    func strip() async {
        guard busy == nil else { return }
        let words = terms
        let nextSubject = UrgentWords.oneLine(UrgentWords.removeTerms(subject, words)).trimmingCharacters(in: .whitespaces)
        let nextBody = UrgentWords.removeTerms(body, words)
        if nextSubject.isEmpty || nextBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = "Removing those words would leave the message empty. Change it by hand instead."
            return
        }
        busy = .remove
        error = nil
        defer { busy = nil }
        do throws(APIError) {
            let edited = try await api.editRequest(id: current.id, changes: RequestChanges(subject: nextSubject, body: nextBody))
            Self.typed[current.id] = nil
            onUpdate(edited.request)
            load(edited.request)
            refused = []
            let left = edited.request.healthTermsFound
            announce(
                left.isEmpty
                    ? "Removed \(UrgentWords.quoted(words)) from the message."
                    : "Removed \(UrgentWords.quoted(words)). It still mentions \(UrgentWords.quoted(left))."
            )
        } catch {
            self.error = error.userMessage
        }
    }

    // MARK: - how much it shares

    /// picking only marks the level; Alex applies it below the picker
    func pickTier(_ next: DisclosureTier) {
        guard busy == nil, editable else { return }
        error = nil
        if next == current.disclosureTier {
            askTier = nil
            return
        }
        if pendingTier == nil {
            announce(
                dirty
                    ? "You\u{2019}ve changed the words. Choose whether to write it again or keep your words."
                    : "Choose \u{201C}Use this level\u{201D} to change how much it shares."
            )
        }
        askTier = next
    }

    func cancelTier() {
        askTier = nil
    }

    /// "Use this level" rewrites unless it is a proposal; with typed words Alex chooses
    func useTier(rewrite: Bool? = nil) async {
        guard let tier = pendingTier else { return }
        await changeTier(tier, rewrite: rewrite ?? !UrgentWords.isProposal(current))
    }

    func changeTier(_ next: DisclosureTier, rewrite: Bool) async {
        guard busy == nil else { return }
        busy = .tier
        askTier = nil
        error = nil
        defer { busy = nil }
        let label = UrgentWords.tierLabel(next, alias: careAlias)
        var note = "Your words are kept."
        do throws(APIError) {
            var saved: RequestView?
            if rewrite {
                do throws(APIError) {
                    let redrafted = try await api.redraftRequest(id: current.id, tier: next)
                    saved = redrafted.request
                    flags = redrafted.editFlags
                    onFlags(redrafted.request.id, redrafted.editFlags)
                    note = "It was written again at this level."
                } catch {
                    // a changed or missing request stops here; any other failure keeps Alex's words at the new level
                    if error.status == 409 || error.status == 404 { throw error }
                    note = "It couldn\u{2019}t be written again, so your words are kept."
                }
            }
            if saved == nil {
                var changes = dirty ? RequestChanges(subject: UrgentWords.oneLine(subject), body: body) : RequestChanges()
                changes.disclosureTier = next
                saved = try await api.editRequest(id: current.id, changes: changes).request
            }
            guard let saved else { return }
            Self.typed[saved.id] = nil
            onUpdate(saved)
            load(saved)
            refused = []
            announce("Now set to \u{201C}\(label)\u{201D}. \(note) Read the message again before you send.")
        } catch {
            if error.status == 409 {
                if let fresh = await reload(current.id) { load(fresh) }
                self.error = "This message changed somewhere else. Review it again."
            } else {
                self.error = error.userMessage
            }
        }
    }
}
