import Foundation
import Observation

/// where a typed note, pdf or voice note came from
nonisolated enum AddedFrom: Sendable, Hashable {
    case note, pdf, voice
}

/// the one-at-a-time check that opens after adding something, or from "Review N suggestions"
nonisolated struct ReviewSession: Sendable, Hashable, Identifiable {
    var id = UUID()
    /// fixed when checking starts, so the count does not move
    var steps: [ReviewStep]
    /// what just happened, shown above the first question
    var intro: String?
    /// model notes for conflict steps, by step key
    var notes: [String: String] = [:]
}

/// the pushed care sub-flow (the web's ?step=)
nonisolated enum CareFlow: Sendable, Hashable {
    case add
    case voice
    case review(ReviewSession)
}

/// what came back from adding a source: a message to show where the caregiver is, or a review to open
nonisolated enum AddedOutcome: Sendable, Hashable {
    case message(String)
    case review(ReviewSession)
}

/// the care tab's state: the profile, the receipt on the overview, and the pushed sub-flow (CareScreen.tsx)
@Observable
final class CareModel {
    var api: APIClient
    private(set) var profile: CareProfile?
    private(set) var profileError: String?
    /// goes up each time the profile reloads, so the day refreshes after an approval
    private(set) var version = 0
    var receipt: String?
    /// the sub-flow on screen; kept while it pops so the leaving screen does not blank
    private(set) var flow: CareFlow = .add
    var isFlowPresented = false
    /// an Ask citation asked to show this fact in the passport
    var revealFactId: String?

    @ObservationIgnored private var seq = 0

    init(api: APIClient) {
        self.api = api
    }

    var facts: [CareFact] { profile?.facts ?? [] }

    /// GET /api/care/facts; a late reply never overwrites a newer one
    @discardableResult
    func loadProfile() async -> CareProfile? {
        seq += 1
        let mine = seq
        do {
            let next = try await api.careProfile()
            if mine == seq {
                profile = next
                profileError = nil
                version += 1
            }
            return next
        } catch {
            if mine == seq { profileError = error.userMessage }
            return nil
        }
    }

    func go(_ next: CareFlow) {
        flow = next
        isFlowPresented = true
    }

    func goHome() {
        isFlowPresented = false
    }

    func openAdd() {
        receipt = nil
        go(.add)
    }

    func openVoice() {
        receipt = nil
        go(.voice)
    }

    func openReview(_ steps: [ReviewStep]) {
        receipt = nil
        go(.review(ReviewSession(steps: steps)))
    }

    /// a note, pdf or voice note was read: check what it found, newest first. returns a message when there is
    /// nothing to check
    func added(_ result: CareSourceResult, from: AddedFrom) async -> String? {
        let latest = await loadProfile() ?? profile
        switch Self.outcome(of: result, from: from, latestFacts: latest?.facts ?? []) {
        case .message(let text):
            return text
        case .review(let session):
            receipt = nil
            go(.review(session))
            return nil
        }
    }

    /// POST /api/care/sources kind voice with the confirmed transcript; a failure keeps the transcript on screen
    func saveTranscript(_ text: String) async -> String? {
        do {
            let result = try await api.addCareText(kind: .voice, text: text)
            return await added(result, from: .voice)
        } catch {
            return "\(error.userMessage) Your transcript is still here."
        }
    }

    /// the review ended: the overview shows what changed
    func finished(_ summary: ReviewSummary, name: String) {
        receipt = Self.finishedReceipt(summary, name: name)
        Task { await loadProfile() }
        goHome()
    }

    // MARK: - pure parts, tested

    /// the intro and steps for what a new source found (added() in CareScreen.tsx)
    nonisolated static func outcome(of result: CareSourceResult, from: AddedFrom, latestFacts: [CareFact]) -> AddedOutcome {
        var byId: [String: CareFact] = [:]
        var order: [String] = []
        for fact in latestFacts + result.facts {
            if byId[fact.id] == nil { order.append(fact.id) }
            byId[fact.id] = fact
        }
        let steps = CareData.pendingSteps(order.compactMap { byId[$0] }, firstSourceId: result.source.id)
        let whereText = from == .pdf ? "The PDF" : from == .voice ? "Your voice note" : "Your note"
        let count = Int(result.droppedCount)
        let lines = result.facts.isEmpty
            ? CareData.plural(count, "line", "lines")
            : CareData.plural(count, "other line", "other lines")
        let dropped = count > 0
            ? " \(lines) \(count == 1 ? "was" : "were") already on file or couldn\u{2019}t be kept word for word, so \(count == 1 ? "it was" : "they were") left out."
            : ""

        if result.facts.isEmpty {
            return .message(
                "\(whereText) didn\u{2019}t have anything new to add.\(dropped) Try one thing per sentence, with times where you know them."
            )
        }

        var notes: [String: String] = [:]
        for conflict in result.conflicts {
            guard let note = conflict.modelNote?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else { continue }
            if let step = steps.first(where: { $0.kind == .conflict && $0.factIds.contains(conflict.factId) }), notes[step.key] == nil {
                notes[step.key] = note
            }
        }
        let fresh = CareData.plural(result.facts.count, "new thing", "new things")
        let intro = steps.count > result.facts.count
            ? "\(whereText) has \(fresh) to check, shown first.\(dropped)"
            : "\(whereText) has \(fresh) to check.\(dropped)"
        return .review(ReviewSession(steps: steps, intro: intro, notes: notes))
    }

    /// "Added 3 things to Rosa’s profile. 1 thing is waiting for later."
    nonisolated static func finishedReceipt(_ summary: ReviewSummary, name: String) -> String? {
        let added = summary.approved + summary.kept
        var parts: [String] = []
        if added > 0 { parts.append("Added \(CareData.plural(added, "thing", "things")) to \(Labels.possessive(name)) profile.") }
        if summary.skipped > 0 { parts.append("\(CareData.plural(summary.skipped, "thing is", "things are")) waiting for later.") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}
