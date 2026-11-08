import Foundation
import Testing
@testable import ReliefReady

/// the one-at-a-time check against a stubbed server
@MainActor
struct CareReviewModelTests {
    typealias F = CareFixtures

    private func setUp(_ facts: [CareFact], routes: [String: CareRouteStub.Reply] = [:]) async -> (ReviewModel, CareModel, String) {
        var all = routes
        all["/api/care/facts"] = .init(body: F.profileJSON(facts))
        let (client, host) = CareRouteStub.client(all)
        let care = CareModel(api: client)
        await care.loadProfile()
        let session = ReviewSession(steps: CareData.pendingSteps(facts, firstSourceId: "s1"), intro: "Your note has 4 new things to check.")
        return (ReviewModel(session: session, name: "Rosa", care: care), care, host)
    }

    private func envelope(_ fact: CareFact) -> CareRouteStub.Reply {
        .init(body: F.json(FactEnvelope(fact: fact)))
    }

    @Test func approvingMovesOnWithAReceipt() async {
        let facts = F.demoFacts
        var approved = facts[0]
        approved.status = .approved
        let (model, _, host) = await setUp(facts, routes: ["/api/care/facts/glasses/approve": envelope(approved)])
        #expect(model.receipt == "Your note has 4 new things to check.")
        #expect(model.step?.factId == "glasses")
        #expect(model.labels.first == "Her spare glasses are in the top drawer of the hallway\u{2026}")

        await model.approve(facts[0])
        #expect(model.index == 1)
        #expect(model.outcomes["fact:glasses"] == .approved)
        #expect(model.receipt == "Added to Rosa\u{2019}s profile.")
        #expect(model.announcement == "Added to Rosa\u{2019}s profile.")
        #expect(CareRouteStub.calls(host: host).contains("POST /api/care/facts/glasses/approve"))
    }

    @Test func approvingATimedFactMentionsTheDay() async {
        let facts = F.demoFacts
        let (model, _, _) = await setUp(facts, routes: ["/api/care/facts/breakfast/approve": envelope(facts[1])])
        model.skip()
        #expect(model.receipt == "Left for later. It stays off the profile until you check it.")
        await model.approve(facts[1])
        #expect(model.receipt == "Added to Rosa\u{2019}s profile and day.")
        #expect(model.index == 2)
    }

    @Test func editingSavesANewVersionAndUnchangedWordingIsAPlainApproval() async {
        let facts = F.demoFacts
        let edited = F.fact("lips2", "Speak slowly and face her. She reads lips a bit.", category: "communication", status: .approved, version: 2, supersedes: "lips")
        let (model, _, host) = await setUp(facts, routes: [
            "/api/care/facts/lips/edit": .init(body: F.json(FactEditResult(fact: edited, previous: nil))),
            "/api/care/facts/glasses/approve": envelope(facts[0]),
        ])
        // unchanged wording on the first step goes through approve
        model.startEdit(facts[0])
        #expect(model.draft == facts[0].textExact)
        await model.saveEdit(facts[0])
        #expect(model.outcomes["fact:glasses"] == .approved)
        model.skip()
        // an empty draft is refused without a call
        model.startEdit(facts[2])
        model.draft = "   "
        await model.saveEdit(facts[2])
        #expect(model.error == "Type the wording you want kept, or cancel.")
        model.draft = "Speak slowly and face her. She reads lips a bit."
        await model.saveEdit(facts[2])
        #expect(model.outcomes["fact:lips"] == .edited(factId: "lips2", text: edited.textExact, original: facts[2].textExact))
        #expect(model.receipt == "Added your wording to Rosa\u{2019}s profile. The original wording is kept as an earlier version.")
        #expect(model.draft == nil)
        #expect(!CareRouteStub.calls(host: host).contains("POST /api/care/facts/glasses/edit"))
    }

    @Test func rejectingAndReachingTheEnd() async {
        let facts = F.demoFacts
        let (model, care, _) = await setUp(facts, routes: ["/api/care/facts/radio/reject": envelope(facts[3])])
        model.skip()
        model.skip()
        model.skip()
        await model.reject(facts[3])
        #expect(model.receipt == "Rejected. It won\u{2019}t go on Rosa\u{2019}s profile.")
        #expect(model.atSummary)
        #expect(model.summary.rejected == 1)
        #expect(model.summary.skipped == 3)
        #expect(model.announcement?.hasSuffix("0 approved as written, 0 edited and approved, 1 rejected, 3 left for later.") == true)
        #expect(model.firstLeft == 0)
        model.checkLeftForLater()
        #expect(model.index == 0)
        #expect(model.receipt == nil)
        care.isFlowPresented = true
        model.finish()
        #expect(!care.isFlowPresented)
        #expect(care.receipt == "3 things are waiting for later.")
    }

    @Test func aFailedCallKeepsTheStepAndSaysWhy() async {
        let facts = F.demoFacts
        let (model, _, _) = await setUp(facts, routes: [
            "/api/care/facts/glasses/approve": .init(status: 409, body: #"{"error":{"code":"conflict_unresolved"}}"#),
        ])
        await model.approve(facts[0])
        #expect(model.index == 0)
        #expect(model.error == "This fact conflicts with another one. Choose which version to keep first.")
        #expect(model.busy == nil)
    }

    @Test func keepingOneOfTwoNotes() async {
        let a = F.fact("a", "She has breakfast at 8:00 every morning.", status: .conflicting, conflicts: ["b"])
        let b = F.fact("b", "Breakfast at 8:30 with medication.", status: .conflicting, source: "s2", conflicts: ["a"])
        var kept = a
        kept.status = .approved
        let (model, _, host) = await setUp([a, b], routes: [
            "/api/care/conflicts/resolve": .init(body: F.json(ConflictResolution(kept: kept, superseded: [b]))),
        ])
        #expect(model.step?.kind == .conflict)
        #expect(model.labels == ["Notes that disagree"])
        await model.keep(a)
        #expect(model.outcomes["conflict:a,b"] == .kept(factId: "a"))
        #expect(model.receipt == "Kept \u{201C}She has breakfast at 8:00 every morning.\u{201D} The other is set aside.")
        #expect(model.atSummary)
        #expect(CareRouteStub.calls(host: host).contains("POST /api/care/conflicts/resolve"))
    }

    @Test func aStepLeftForLaterIsNotDoneInTheProgress() async {
        let facts = F.demoFacts
        var approved = facts[1]
        approved.status = .approved
        let (model, _, _) = await setUp(facts, routes: ["/api/care/facts/\(facts[1].id)/approve": envelope(approved)])
        model.skip()
        await model.approve(facts[1])
        #expect(model.index == 2)
        #expect(Array(model.done.prefix(3)) == [false, true, false])
        let progress = StepProgress(total: model.steps.count, current: model.index, labels: model.labels, done: model.done)
        #expect(!progress.isFinished(0))
        #expect(progress.isFinished(1))
        #expect(progress.stepsSummary.contains("\(model.labels[0]), not done yet"))
        // without a done list every earlier step counts as done, as before
        #expect(StepProgress(total: 3, current: 2).isFinished(0))
    }

    @Test func backGoesToThePreviousStep() async {
        let (model, _, _) = await setUp(F.demoFacts)
        model.skip()
        #expect(model.index == 1)
        model.back()
        #expect(model.index == 0)
        #expect(model.receipt == nil)
        #expect(model.moves == 2)
    }

    @Test func savingATranscriptOpensItsReview() async {
        let facts = F.demoFacts.map { fact -> CareFact in
            var copy = fact
            copy.sourceKind = "voice"
            return copy
        }
        let result = CareSourceResult(source: CareSourceRef(id: "s1", kind: "voice"), facts: facts, conflicts: [], droppedCount: 0)
        let (client, _) = CareRouteStub.client([
            "/api/care/sources": .init(body: F.json(result)),
            "/api/care/facts": .init(body: F.profileJSON(facts)),
        ])
        let care = CareModel(api: client)
        #expect(await care.saveTranscript(F.note) == nil)
        #expect(care.isFlowPresented)
        guard case .review(let session) = care.flow else {
            Issue.record("expected the review")
            return
        }
        #expect(session.intro == "Your voice note has 4 new things to check.")
        #expect(session.steps.count == 4)
    }

    @Test func aFailedTranscriptSaveKeepsTheWords() async {
        let (client, _) = CareRouteStub.client([
            "/api/care/sources": .init(status: 503, body: #"{"error":{"code":"model_unavailable"}}"#),
        ])
        let care = CareModel(api: client)
        #expect(await care.saveTranscript("x")
            == "The AI provider is unavailable right now. Nothing was saved; try again shortly. Your transcript is still here.")
        #expect(!care.isFlowPresented)
    }
}
