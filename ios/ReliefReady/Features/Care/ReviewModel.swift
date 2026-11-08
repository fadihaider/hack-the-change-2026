import Foundation
import Observation

/// checking suggestions one at a time (ReviewSteps.tsx): approve, edit and approve, reject, or leave for later; when
/// notes disagree, keep one or decide later. a summary of what changed comes at the end
@Observable
final class ReviewModel {
    enum Busy: Equatable {
        case approve, edit, reject
        case keep(String)
    }

    enum SourceState: Equatable {
        case loading, failed
        case loaded(CareSourceDetail)
    }

    /// the server keeps exact text up to this length
    static let editMax = 1000
    /// a short fact sits inside the big question; a long one gets its own quote under it
    static let inlineMax = 150

    let session: ReviewSession
    let name: String
    private(set) var index = 0
    private(set) var outcomes: [String: ReviewOutcome] = [:]
    private(set) var receipt: String?
    private(set) var busy: Busy?
    private(set) var error: String?
    /// the wording being edited for the fact on screen, or nil when not editing
    var draft: String?
    private(set) var sources: [String: SourceState] = [:]
    private(set) var announcement: String?
    /// bumps on every move, so the screen can scroll to the top and focus the question
    private(set) var moves = 0

    @ObservationIgnored private let care: CareModel

    init(session: ReviewSession, name: String, care: CareModel) {
        self.session = session
        self.name = name
        self.care = care
        receipt = session.intro
    }

    var steps: [ReviewStep] { session.steps }
    var facts: [CareFact] { care.facts }
    var byId: [String: CareFact] { Dictionary(facts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) }
    var atSummary: Bool { !steps.isEmpty && index >= steps.count }
    var step: ReviewStep? { atSummary || steps.isEmpty ? nil : steps[index] }
    var isLast: Bool { index >= steps.count - 1 }
    var isWorking: Bool { busy != nil }
    var summary: ReviewSummary { ReviewData.summarize(steps, outcomes: outcomes, facts: facts) }

    /// the progress labels, one per step
    var labels: [String] {
        let byId = byId
        return steps.map { item in
            if item.kind == .conflict { return "Notes that disagree" }
            return byId[item.factId].map { ReviewData.stepLabel($0) } ?? "A suggestion"
        }
    }

    /// the first step still waiting, for "Check the ones left for later"
    var firstLeft: Int? {
        steps.firstIndex { item in
            switch outcomes[item.key] {
            case nil, .skipped: true
            default: false
            }
        }
    }

    private func say(_ text: String) { announcement = text }

    private func go(_ next: Int) {
        error = nil
        draft = nil
        index = next
        moves += 1
    }

    func back() {
        guard index > 0 else { return }
        receipt = nil
        go(index - 1)
    }

    /// "Next" or "See what changed" on a step that already has an outcome
    func advance(said: String? = nil) {
        if isLast {
            let end = ReviewData.summarySentence(ReviewData.summarize(steps, outcomes: outcomes, facts: facts))
            say(said.map { "\($0) \(end)" } ?? end)
        } else if let said {
            say(said)
        }
        go(index + 1)
    }

    func checkLeftForLater() {
        guard let first = firstLeft else { return }
        receipt = nil
        go(first)
    }

    private func record(_ key: String, _ outcome: ReviewOutcome, _ text: String) {
        outcomes[key] = outcome
        receipt = text
        advance(said: text)
    }

    private func run(_ kind: Busy, _ work: () async throws(APIError) -> Void) async {
        guard busy == nil else { return }
        busy = kind
        error = nil
        do {
            try await work()
        } catch {
            self.error = error.userMessage
            Task { await care.loadProfile() }
        }
        busy = nil
    }

    func approve(_ fact: CareFact) async {
        guard let key = step?.key else { return }
        await run(.approve) { () throws(APIError) in
            _ = try await care.api.approveFact(id: fact.id)
            Task { await care.loadProfile() }
            let target = CareData.timeLine(fact) != nil
                ? "\(CareData.possessive(name)) profile and day" : "\(CareData.possessive(name)) profile"
            record(key, .approved, "Added to \(target).")
        }
    }

    func startEdit(_ fact: CareFact) {
        error = nil
        draft = fact.textExact
    }

    func cancelEdit() {
        error = nil
        draft = nil
    }

    func saveEdit(_ fact: CareFact) async {
        guard let key = step?.key, let value = draft else { return }
        let wording = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if wording.isEmpty {
            error = "Type the wording you want kept, or cancel."
            return
        }
        // unchanged wording is a plain approval
        if wording == fact.textExact.trimmingCharacters(in: .whitespacesAndNewlines) {
            await approve(fact)
            return
        }
        await run(.edit) { () throws(APIError) in
            let result = try await care.api.editFact(id: fact.id, text: wording)
            Task { await care.loadProfile() }
            record(
                key, .edited(factId: result.fact.id, text: result.fact.textExact, original: fact.textExact),
                "Added your wording to \(CareData.possessive(name)) profile. The original wording is kept as an earlier version."
            )
        }
    }

    func reject(_ fact: CareFact) async {
        guard let key = step?.key else { return }
        await run(.reject) { () throws(APIError) in
            _ = try await care.api.rejectFact(id: fact.id)
            Task { await care.loadProfile() }
            record(key, .rejected(text: fact.textExact), "Rejected. It won\u{2019}t go on \(CareData.possessive(name)) profile.")
        }
    }

    func keep(_ fact: CareFact) async {
        guard let key = step?.key else { return }
        await run(.keep(fact.id)) { () throws(APIError) in
            _ = try await care.api.resolveConflict(keepFactId: fact.id)
            Task { await care.loadProfile() }
            let quoted = ReviewData.quoteOf(fact, max: 70)
            let stop = quoted.last.map { ".!?\u{2026}".contains($0) } == true ? "" : "."
            record(key, .kept(factId: fact.id), "Kept \u{201C}\(quoted)\u{201D}\(stop) The other is set aside.")
        }
    }

    func skip() {
        guard busy == nil, let item = step else { return }
        let text = item.kind == .conflict
            ? "Left for later. Neither note is on the profile until you pick one."
            : "Left for later. It stays off the profile until you check it."
        record(item.key, .skipped, text)
    }

    /// the source behind the suggestion on screen, for its sentence in context; a failure is not retried
    func loadSource(_ sourceId: String) async {
        guard sources[sourceId] == nil else { return }
        sources[sourceId] = .loading
        do {
            sources[sourceId] = .loaded(try await care.api.careSource(id: sourceId))
        } catch {
            sources[sourceId] = .failed
        }
    }

    func finish() {
        care.finished(summary, name: name)
    }
}
