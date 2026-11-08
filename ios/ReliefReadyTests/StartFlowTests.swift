import Foundation
import Synchronization
import Testing
@testable import ReliefReady

/// a scripted POST /api/intake: answers in order and records every statement sent
nonisolated final class StartIntakeScript: Sendable {
    private let state: Mutex<(replies: [Result<IntakeResponse, APIError>], sent: [String], reloads: Int)>
    let reloadError: APIError?

    init(_ replies: [Result<IntakeResponse, APIError>], reloadError: APIError? = nil) {
        state = Mutex((replies, [], 0))
        self.reloadError = reloadError
    }

    var sent: [String] { state.withLock { $0.sent } }
    var reloads: Int { state.withLock { $0.reloads } }

    func intake(_ statement: String) throws(APIError) -> IntakeResponse {
        let next = state.withLock { state -> Result<IntakeResponse, APIError> in
            state.sent.append(statement)
            return state.replies.isEmpty ? .failure(.network) : state.replies.removeFirst()
        }
        return try next.get()
    }

    func reload() -> APIError? {
        state.withLock { $0.reloads += 1 }
        return reloadError
    }
}

@MainActor
struct StartFlowTests {
    static let episode = EpisodeSummary(id: "e1", startsOn: "2026-11-08", endsOn: "2026-11-14", status: "active")

    static let emptyPartial = IntakePartial(startDate: nil, endDate: nil, recipientAlias: nil, reasonText: nil, helpRequested: [])

    static func clarify(_ questions: [String], partial: IntakePartial = Self.emptyPartial) -> IntakeResponse {
        IntakeResponse(result: .needsClarification(IntakeClarification(clarifyingQuestions: questions, partial: partial)), episodeId: nil)
    }

    static func ready(extra: [String]? = nil, episodeId: String? = "e2") -> IntakeResponse {
        IntakeResponse(
            result: .ready(IntakeReady(
                startDate: "2026-11-15", endDate: "2026-11-21", clarifyingQuestions: extra, recipientAlias: "mom",
                reasonText: "hip surgery", helpRequested: []
            )),
            episodeId: episodeId
        )
    }

    func makeFlow(_ script: StartIntakeScript, current: EpisodeSummary? = nil, welcome: Bool = false) -> (StartFlow, StartRecorder) {
        let spoken = StartRecorder()
        let flow = StartFlow(
            current: current,
            startAtWelcome: welcome,
            intake: { statement throws(APIError) in try script.intake(statement) },
            reload: { script.reload() },
            announce: { text in spoken.items.append(text) }
        )
        return (flow, spoken)
    }

    @Test func blankStatementAsksForASentenceWithoutCalling() async {
        let script = StartIntakeScript([])
        let (flow, _) = makeFlow(script)
        flow.update(statement: "   \n ")
        await flow.submit()
        #expect(flow.error == "Write a sentence about what\u{2019}s happening, or tap the example.")
        #expect(script.sent.isEmpty)
        #expect(flow.stage == .write)
    }

    @Test func statementIsClampedTo2000UTF16Units() {
        let (flow, _) = makeFlow(StartIntakeScript([]))
        flow.update(statement: String(repeating: "a", count: 2100))
        #expect(flow.statement.utf16.count == 2000)
        // an emoji is two utf-16 units and is never split
        #expect(StartFlow.clamped("ab\u{1F600}", to: 3) == "ab")
        #expect(StartFlow.clamped("ab\u{1F600}", to: 4) == "ab\u{1F600}")
    }

    @Test func characterCountShowsFrom1700() {
        #expect(StartFlow.countText(1699) == nil)
        #expect(StartFlow.countText(1700) == "1,700 of 2,000 characters")
        #expect(StartFlow.countText(2000) == "2,000 of 2,000 characters")
    }

    @Test func exampleFillsTheStatementAndHidesItself() {
        let (flow, spoken) = makeFlow(StartIntakeScript([]))
        #expect(flow.showsExample)
        flow.fillExample()
        #expect(flow.statement == "My mom Rosa has hip surgery on Sunday and I\u{2019}m caring for her until Saturday.")
        #expect(!flow.showsExample)
        #expect(spoken.items == ["Example added. Change anything you like, then check your week."])
    }

    @Test func clarificationAppendsTheAnswerAndCountsRounds() async throws {
        let partial = IntakePartial(startDate: nil, endDate: nil, recipientAlias: "mom", reasonText: "hip surgery", helpRequested: [])
        let script = StartIntakeScript([
            .success(Self.clarify(["What day does the caregiving start?", "When does it end?"], partial: partial)),
            .success(Self.clarify(["When does it end?"], partial: partial)),
            .success(Self.ready()),
        ])
        let (flow, spoken) = makeFlow(script)
        flow.update(statement: "  My mom has hip surgery ")
        await flow.submit()
        guard case .clarify(let first) = flow.stage else { Issue.record("expected a clarifying question"); return }
        #expect(first.statement == "My mom has hip surgery")
        #expect(first.questions.count == 2)
        #expect(first.round == 1)
        #expect(spoken.items.last == "2 more details are needed.")

        // an empty answer is refused locally
        await flow.submit()
        #expect(flow.error == "Answer the question above, or edit what you wrote.")
        #expect(script.sent.count == 1)

        flow.update(answer: " It starts today. ")
        await flow.submit()
        #expect(script.sent.last == "My mom has hip surgery It starts today.")
        guard case .clarify(let second) = flow.stage else { Issue.record("expected a second round"); return }
        #expect(second.round == 2)
        #expect(flow.answer.isEmpty)
        #expect(spoken.items.last == "One more detail is needed.")

        flow.update(answer: "Until Saturday.")
        await flow.submit()
        #expect(script.sent.last == "My mom has hip surgery It starts today. Until Saturday.")
        #expect(script.reloads == 1)
        #expect(flow.isFinished)
        #expect(flow.busy == nil)
        #expect(spoken.items.last == "Care week saved, Nov 15 to 21. Opening what it affects.")
    }

    @Test func answerRoomLeavesSpaceForTheJoiningSpace() async {
        let long = String(repeating: "b", count: 1990)
        let script = StartIntakeScript([.success(Self.clarify(["When?"]))])
        let (flow, _) = makeFlow(script)
        flow.update(statement: long)
        await flow.submit()
        #expect(flow.answerRoom == 9)
        flow.update(answer: "0123456789abc")
        #expect(flow.answer == "012345678")
    }

    @Test func emptyQuestionsFallBackToTheDatesQuestion() async {
        let script = StartIntakeScript([.success(Self.clarify([]))])
        let (flow, _) = makeFlow(script)
        flow.update(statement: "Mom needs help")
        await flow.submit()
        guard case .clarify(let clarify) = flow.stage else { Issue.record("expected a clarifying question"); return }
        #expect(clarify.questions == ["When does the care start, and when does it end?"])
    }

    @Test func editWhatIWroteGoesBackWithTheStatement() async {
        let script = StartIntakeScript([.success(Self.clarify(["When?"]))])
        let (flow, _) = makeFlow(script)
        flow.update(statement: "Mom needs help")
        await flow.submit()
        flow.update(statement: "")
        flow.editStatement()
        #expect(flow.stage == .write)
        #expect(flow.statement == "Mom needs help")
        #expect(!flow.movingForward)
    }

    @Test func readyWithExtraQuestionsWaitsOnTheConfirmation() async {
        let script = StartIntakeScript([.success(Self.ready(extra: ["Who drives her home?"]))])
        let (flow, spoken) = makeFlow(script)
        flow.update(statement: "My mom Rosa has hip surgery today until Saturday")
        await flow.submit()
        guard case .confirm(let ready) = flow.stage else { Issue.record("expected the confirmation"); return }
        #expect(ready.clarifyingQuestions == ["Who drives her home?"])
        #expect(StartText.savedReceipt(ready) == "Care week saved: Sunday, Nov 15 to Saturday, Nov 21.")
        #expect(script.reloads == 0)
        #expect(!flow.isFinished)
        #expect(spoken.items.last == "Care week saved, Nov 15 to 21.")

        await flow.openWeek()
        #expect(script.reloads == 1)
        #expect(flow.isFinished)
    }

    @Test func readyWithoutAnEpisodeIsNotSaved() async {
        let script = StartIntakeScript([.success(Self.ready(episodeId: nil))])
        let (flow, _) = makeFlow(script)
        flow.update(statement: "My mom Rosa has hip surgery today until Saturday")
        await flow.submit()
        #expect(flow.error == "Your dates were understood but the care week wasn\u{2019}t saved. Check your week again.")
        #expect(script.reloads == 0)
        #expect(!flow.isFinished)
        #expect(flow.busy == nil)
    }

    @Test func serverErrorsUseTheLiveWording() async {
        let script = StartIntakeScript([.failure(APIError(code: "rate_limited", status: 429))])
        let (flow, _) = makeFlow(script)
        flow.update(statement: "Mom needs help")
        await flow.submit()
        #expect(flow.error == "Too many AI requests in a short time. Wait a few minutes, then try again.")
        #expect(flow.busy == nil)
        #expect(flow.stage == .write)
    }

    @Test func aFailedReloadKeepsTheStartOpen() async {
        let script = StartIntakeScript([.success(Self.ready())], reloadError: .network)
        let (flow, _) = makeFlow(script)
        flow.update(statement: "My mom Rosa has hip surgery today until Saturday")
        await flow.submit()
        #expect(!flow.isFinished)
        #expect(flow.error?.hasPrefix("Your care week was saved, but it didn\u{2019}t load.") == true)
    }

    @Test func welcomeOpensOnlyWithAWeekOnFile() {
        let (none, _) = makeFlow(StartIntakeScript([]), current: nil, welcome: true)
        #expect(none.screen == .intake)
        #expect(!none.canGoBack)
        #expect(none.writeNote == "Nothing is sent without your OK.")

        let (flow, _) = makeFlow(StartIntakeScript([]), current: Self.episode, welcome: true)
        #expect(flow.screen == .welcome)
        flow.startNewWeek()
        #expect(flow.screen == .intake)
        #expect(flow.canGoBack)
        #expect(flow.writeNote == "This replaces your current week, Nov 8 to 14.")
        flow.backToWelcome()
        #expect(flow.screen == .welcome)
    }

    @Test func welcomeLeadFollowsTheWeek() {
        let week = Self.episode
        #expect(StartText.welcomeLead(name: "Rosa", today: "2026-11-10", episode: week) == "You\u{2019}re caring for Rosa.")
        #expect(StartText.welcomeLead(name: "Rosa", today: "2026-11-07", episode: week) == "Rosa\u{2019}s care week starts Sunday, Nov 8.")
        #expect(StartText.welcomeLead(name: "Chris", today: "2026-11-15", episode: week) == "Chris\u{2019} care week ended Saturday, Nov 14.")
    }

    @Test func understoodLinesMatchTheWeb() {
        let full = IntakePartial(startDate: "2026-11-08", endDate: "2026-11-14", recipientAlias: "mom", reasonText: "hip surgery", helpRequested: [])
        #expect(StartText.understood(full).map(\.text) == ["Caring for mom", "Hip surgery", "Sunday, Nov 8 to Saturday, Nov 14"])
        let start = IntakePartial(startDate: "2026-11-08", endDate: nil, recipientAlias: nil, reasonText: nil, helpRequested: [])
        #expect(StartText.understood(start).map(\.text) == ["Starts Sunday, Nov 8"])
        let end = IntakePartial(startDate: nil, endDate: "2026-11-14", recipientAlias: nil, reasonText: nil, helpRequested: [])
        #expect(StartText.understood(end).map(\.text) == ["Until Saturday, Nov 14"])
        #expect(StartText.understood(Self.emptyPartial).isEmpty)
    }
}

/// what a flow announced, in order
@MainActor
final class StartRecorder {
    var items: [String] = []
    var count = 0
}

