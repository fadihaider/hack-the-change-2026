import Foundation
import Observation

/// the start's state: the welcome back, the intake question, the clarifying detail and the "worth thinking about"
/// confirmation (StartScreen.tsx and Intake.tsx). the view only draws it; every rule lives here so it can be tested
@Observable
final class StartFlow {
    enum Screen: Equatable {
        case welcome, intake
    }

    struct Clarify: Equatable {
        /// everything written so far, sent again with the answer appended
        var statement: String
        /// never empty; the server's questions or the fallback
        var questions: [String]
        var partial: IntakePartial
        /// 1 for the first clarifying question, 2 after a second round, and so on
        var round: Int
    }

    enum Stage: Equatable {
        case write
        case clarify(Clarify)
        case confirm(IntakeReady)
    }

    enum Busy: Equatable {
        case checking, opening
    }

    /// the sentence the example button fills in (EXAMPLE_STATEMENT)
    static let exampleStatement =
        "My mom Rosa has hip surgery on Sunday and I\u{2019}m caring for her until Saturday."
    static let maxChars = 2000
    static let showCountFrom = 1700
    static let slowAfter: Duration = .seconds(5)
    static let fallbackQuestion = "When does the care start, and when does it end?"

    private(set) var screen: Screen
    private(set) var stage: Stage = .write
    /// the first answer; set through update(statement:) so it never passes the limit
    private(set) var statement = ""
    /// the clarifying answer; set through update(answer:)
    private(set) var answer = ""
    private(set) var busy: Busy?
    /// true once a check has run for slowAfter without an answer
    private(set) var slow = false
    private(set) var error: String?
    /// true when the next screen replaced another one, so its heading should take voiceover focus
    private(set) var moved = false
    /// a forward or backward move, for the slide direction
    private(set) var movingForward = true
    /// set once the care week is saved and the session reloaded; whoever presented the start closes it
    private(set) var isFinished = false

    /// the week on file when the start opened; a new intake replaces it, and the copy must not change mid-way
    let replacing: EpisodeSummary?

    @ObservationIgnored private let intake: (String) async throws(APIError) -> IntakeResponse
    @ObservationIgnored private let reload: () async -> APIError?
    @ObservationIgnored private let announce: (String) -> Void
    @ObservationIgnored private var slowTask: Task<Void, Never>?

    /// - intake: POST /api/intake
    /// - reload: reloads the session; nil on success, otherwise why it failed
    /// - announce: a polite voiceover announcement
    init(
        current: EpisodeSummary?,
        startAtWelcome: Bool,
        intake: @escaping (String) async throws(APIError) -> IntakeResponse,
        reload: @escaping () async -> APIError?,
        announce: @escaping (String) -> Void = { _ in }
    ) {
        self.replacing = current
        self.screen = startAtWelcome && current != nil ? .welcome : .intake
        self.intake = intake
        self.reload = reload
        self.announce = announce
    }

    // MARK: - derived text

    var isBusy: Bool { busy != nil }

    var busyLabel: String { busy == .opening ? "Opening your week" : "Checking your week" }

    /// what the first answer left room for, after the statement and the joining space
    var answerRoom: Int {
        guard case .clarify(let clarify) = stage else { return Self.maxChars }
        return max(0, Self.maxChars - clarify.statement.utf16.count - 1)
    }

    /// the note under "Check my week" on the first question
    var writeNote: String {
        if slow { return Self.waitNote }
        if let replacing {
            return "This replaces your current week, \(AlbertaTime.weekRange(replacing.startsOn, replacing.endsOn))."
        }
        return "Nothing is sent without your OK."
    }

    /// the note under "Check my week" on a clarifying question, only while it is slow
    var clarifyNote: String? { slow ? Self.waitNote : nil }

    static let waitNote = "Still reading what you wrote. This can take a little while."

    /// "1,800 of 2,000 characters" once the statement nears the limit
    var countText: String? { Self.countText(statement.utf16.count) }

    var showsExample: Bool { statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// "Back to this week" shows only when a week is on file
    var canGoBack: Bool { replacing != nil }

    // MARK: - actions

    func update(statement text: String) {
        statement = Self.clamped(text, to: Self.maxChars)
    }

    func update(answer text: String) {
        answer = Self.clamped(text, to: answerRoom)
    }

    func fillExample() {
        statement = Self.exampleStatement
        error = nil
        announce("Example added. Change anything you like, then check your week.")
    }

    /// the welcome's "Start a new care week"
    func startNewWeek() {
        moved = true
        movingForward = true
        error = nil
        stage = .write
        screen = .intake
    }

    /// "Back to this week", from the first question to the welcome
    func backToWelcome() {
        guard replacing != nil, !isBusy else { return }
        moved = true
        movingForward = false
        error = nil
        screen = .welcome
    }

    /// "Edit what I wrote": back to the first question with everything written so far
    func editStatement() {
        guard case .clarify(let clarify) = stage, !isBusy else { return }
        statement = clarify.statement
        go(.write, forward: false)
    }

    /// "Check my week" on whichever question is showing
    func submit() async {
        if case .clarify(let clarify) = stage {
            let extra = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !extra.isEmpty else {
                error = "Answer the question above, or edit what you wrote."
                return
            }
            await check("\(clarify.statement) \(extra)")
            return
        }
        await check(statement)
    }

    /// "See what it affects" after the worth-thinking-about list: loads the new week, then the start is done
    func openWeek() async {
        guard case .confirm = stage, !isBusy else { return }
        busy = .opening
        error = nil
        announce("Opening what it affects.")
        await finish()
    }

    // MARK: - the check

    private func check(_ text: String) async {
        guard !isBusy else { return }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            error = "Write a sentence about what\u{2019}s happening, or tap the example."
            return
        }
        guard words.utf16.count <= Self.maxChars else {
            error = "That\u{2019}s longer than 2,000 characters. Shorten it, then check again."
            return
        }
        busy = .checking
        error = nil
        announce("Checking your week.")
        startSlowTimer()
        defer { stopSlowTimer() }

        let response: IntakeResponse
        do {
            response = try await intake(words)
        } catch {
            self.error = error.userMessage
            busy = nil
            return
        }

        switch response.result {
        case .needsClarification(let clarification):
            let questions = clarification.clarifyingQuestions.isEmpty
                ? [Self.fallbackQuestion] : clarification.clarifyingQuestions
            let round: Int
            if case .clarify(let previous) = stage { round = previous.round + 1 } else { round = 1 }
            busy = nil
            go(.clarify(Clarify(statement: words, questions: questions, partial: clarification.partial, round: round)), forward: true)
            answer = ""
            announce(questions.count == 1 ? "One more detail is needed." : "\(questions.count) more details are needed.")
        case .ready(let ready):
            guard response.episodeId != nil else {
                error = "Your dates were understood but the care week wasn\u{2019}t saved. Check your week again."
                busy = nil
                return
            }
            statement = words
            let range = AlbertaTime.weekRange(ready.startDate, ready.endDate)
            let extra = ready.clarifyingQuestions ?? []
            if !extra.isEmpty {
                // the session reload waits for "See what it affects": without an episode on file the app would
                // switch to the tabs at once and the list would never be read
                busy = nil
                go(.confirm(ready), forward: true)
                announce("Care week saved, \(range).")
                return
            }
            stopSlowTimer()
            busy = .opening
            announce("Care week saved, \(range). Opening what it affects.")
            await finish()
        }
    }

    private func finish() async {
        if let failure = await reload() {
            error = "Your care week was saved, but it didn\u{2019}t load. \(failure.userMessage)"
            busy = nil
            return
        }
        busy = nil
        isFinished = true
    }

    private func go(_ next: Stage, forward: Bool) {
        moved = true
        movingForward = forward
        error = nil
        stage = next
    }

    private func startSlowTimer() {
        slow = false
        slowTask?.cancel()
        slowTask = Task { [weak self] in
            try? await Task.sleep(for: Self.slowAfter)
            guard !Task.isCancelled, let self, self.busy == .checking else { return }
            self.slow = true
            self.announce("Still reading what you wrote.")
        }
    }

    private func stopSlowTimer() {
        slowTask?.cancel()
        slowTask = nil
        slow = false
    }

    // MARK: - pure helpers

    /// cuts text to at most limit utf-16 units (the server's zod max counts those), never inside a character
    static func clamped(_ text: String, to limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var out = ""
        var used = 0
        for character in text {
            let size = character.utf16.count
            if used + size > limit { break }
            out.append(character)
            used += size
        }
        return out
    }

    static func countText(_ length: Int) -> String? {
        guard length >= showCountFrom else { return nil }
        return "\(grouped(length)) of \(grouped(maxChars)) characters"
    }

    private static func grouped(_ value: Int) -> String {
        value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_CA")))
    }
}

// MARK: - the lines above the questions

/// one muted line of what the first answer already made clear
nonisolated struct UnderstoodLine: Sendable, Hashable, Identifiable {
    enum Kind: String, Sendable {
        case who, why, when
    }

    var kind: Kind
    var text: String
    var id: Kind { kind }

    var systemImage: String {
        switch kind {
        case .who: "person"
        case .why: "waveform.path.ecg"
        case .when: "calendar"
        }
    }
}

nonisolated enum StartText {
    /// Understood in Intake.tsx
    static func understood(_ partial: IntakePartial) -> [UnderstoodLine] {
        var lines: [UnderstoodLine] = []
        if let who = partial.recipientAlias, !who.isEmpty {
            lines.append(UnderstoodLine(kind: .who, text: "Caring for \(who)"))
        }
        if let why = partial.reasonText, !why.isEmpty {
            lines.append(UnderstoodLine(kind: .why, text: capitalised(why)))
        }
        switch (partial.startDate, partial.endDate) {
        case (let start?, let end?):
            lines.append(UnderstoodLine(kind: .when, text: "\(AlbertaTime.dayLabel(start)) to \(AlbertaTime.dayLabel(end))"))
        case (let start?, nil):
            lines.append(UnderstoodLine(kind: .when, text: "Starts \(AlbertaTime.dayLabel(start))"))
        case (nil, let end?):
            lines.append(UnderstoodLine(kind: .when, text: "Until \(AlbertaTime.dayLabel(end))"))
        case (nil, nil):
            break
        }
        return lines
    }

    /// the welcome's muted lead: before, during or after the week
    static func welcomeLead(name: String, today: String, episode: EpisodeSummary) -> String {
        // YYYY-MM-DD strings order like their dates, as in the web's string comparison
        if today < episode.startsOn { return "\(Labels.possessive(name)) care week starts \(AlbertaTime.dayLabel(episode.startsOn))." }
        if today > episode.endsOn { return "\(Labels.possessive(name)) care week ended \(AlbertaTime.dayLabel(episode.endsOn))." }
        return "You\u{2019}re caring for \(name)."
    }

    static func capitalised(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }

    static func savedReceipt(_ ready: IntakeReady) -> String {
        "Care week saved: \(AlbertaTime.dayLabel(ready.startDate)) to \(AlbertaTime.dayLabel(ready.endDate))."
    }
}
