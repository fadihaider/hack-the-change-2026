import Foundation
import Testing
@testable import ReliefReady

// ports of care-data, review-data, today-data and care-help; expectations follow the TypeScript helpers and the
// live demo server's replies for the docs/DEMO.md note
struct CareDataTests {
    typealias F = CareFixtures

    @Test func pendingStepsPutConflictsFirstThenTheNewSourceInWrittenOrder() {
        let older = F.fact("old", "Older thing.", source: "s0", createdAt: "2026-11-07T10:00:00.000Z")
        let a = F.fact("a8", "She has breakfast at 8:00 every morning.", status: .conflicting, createdAt: "2026-11-08T08:00:00.000Z", conflicts: ["b"])
        let b = F.fact("b", "Breakfast at 8:30 with medication.", status: .conflicting, source: "s2", createdAt: "2026-11-08T09:00:00.000Z", conflicts: ["a8"])
        let facts = [older] + F.demoFacts.reversed() + [a, b, F.fact("done", "x", status: .approved)]
        let steps = CareData.pendingSteps(facts, firstSourceId: "s1")
        #expect(steps.first == ReviewStep.conflict(["a8", "b"]))
        #expect(steps.first?.factIds == ["a8", "b"])
        #expect(steps.dropFirst().map(\.factId) == ["glasses", "breakfast", "lips", "radio", "old"])
        #expect(steps.first?.key == "conflict:a8,b")
    }

    @Test func passportGroupsShowOnlyApprovedInTheirSectionsByTimeOfDay() {
        let late = F.fact("late", "Walk at 4", category: "routine", status: .approved, events: [F.event("2026-11-08T22:00:00Z")])
        let early = F.fact("early", "Breakfast", category: "routine", status: .approved, events: [F.event("2026-11-08T14:00:00Z")])
        let untimed = F.fact("untimed", "Likes tea", category: "routine", status: .approved)
        let groups = CareData.passportGroups([late, untimed, early, F.fact("s", "pending", category: "routine"), F.fact("m", "x", category: "mobility", status: .approved)])
        #expect(groups.map(\.section.id) == [.routine, .communication, .preferences, .practical, .contacts, .instructions])
        #expect(groups[0].facts.map(\.id) == ["early", "late", "untimed"])
        #expect(groups[1].facts.map(\.id) == ["m"])
        #expect(PassportSection.section(of: "unknown") == .practical)
    }

    @Test func openItemsCountSuggestionsAndGroupConflicts() {
        let a = F.fact("a", "8:00", status: .conflicting, conflicts: ["b"])
        let b = F.fact("b", "8:30", status: .conflicting, conflicts: ["a"])
        let items = CareData.openItems([a, b, F.fact("s", "pending")])
        #expect(items.suggested == 1)
        #expect(items.conflicts.map { $0.map(\.id) } == [["a", "b"]])
        #expect(items.steps.count == 2)
    }

    @Test func sourcePartsTrustTheSpanOnlyWhenItMatches() throws {
        let breakfast = F.demoFacts[1]
        let parts = try #require(CareData.sourceParts(F.note, fact: breakfast))
        #expect(parts.match == breakfast.textExact)
        #expect(parts.before == "Her spare glasses are in the top drawer of the hallway dresser. ")
        var shifted = breakfast
        shifted.spanStart = 0
        #expect(CareData.sourceParts(F.note, fact: shifted)?.match == breakfast.textExact)
        var missing = breakfast
        missing.textExact = "not in the note"
        #expect(CareData.sourceParts(F.note, fact: missing) == nil)
    }

    @Test func sourceContextShowsTheSentenceWithANeighbourEachSide() throws {
        let context = try #require(ReviewData.sourceContext(F.note, fact: F.demoFacts[1]))
        #expect(context.before == "Her spare glasses are in the top drawer of the hallway dresser. ")
        #expect(context.quote == "She has breakfast at 8:00 every morning.")
        #expect(context.after == " Speak slowly and face her, she reads lips a bit.")
        #expect(!context.cutStart)
        #expect(context.cutEnd)
        let first = try #require(ReviewData.sourceContext(F.note, fact: F.demoFacts[0]))
        #expect(first.before.isEmpty)
        #expect(first.after == " She has breakfast at 8:00 every morning.")
    }

    @Test func linesShownNextToAFact() {
        let breakfast = F.demoFacts[1]
        #expect(ReviewData.consequenceLine(name: "Rosa", fact: breakfast)
            == "Approving adds it to Rosa\u{2019}s day at 8:00 a.m. every day, with a reminder at 7:45 a.m.")
        let once = F.fact("o", "Pickup", events: [F.event("2026-11-14T17:00:00Z")])
        #expect(ReviewData.consequenceLine(name: "Rosa", fact: once) == "Approving adds it to Rosa\u{2019}s day on Sat, Nov 14 at 11:00 a.m.")
        #expect(ReviewData.consequenceLine(name: "Rosa", fact: F.demoFacts[0]) == nil)
        #expect(CareData.timeLine(breakfast) == "Every day at 8:00 a.m.")
        #expect(ReviewData.reviewSourceLine(breakfast) == "Typed note from you, Nov 8")
        #expect(CareData.provenanceLine(breakfast) == "From a typed note, added Nov 8 by you")
        #expect(ReviewData.sectionTitle("practical") == "Practical needs & belongings")
        #expect(ReviewData.sectionTitle(nil) == "Contacts & logistics")
        #expect(CareData.versionLabel(F.fact("v", "x", version: 2)) == "Edited \u{2014} version 2")
        #expect(ReviewData.noteLabel("demo") == "Demo rules note")
        #expect(ReviewData.noteLabel("gemini") == nil)
    }

    @Test func lockedWordingIsNeverShortenedOrEdited() {
        #expect(LockedWording.isLocked(category: "routine", text: "Breakfast at 8:30 with medication."))
        #expect(LockedWording.isLocked(category: "medical_instruction", text: "Rest"))
        #expect(LockedWording.isLocked(category: "routine", text: "Change the DRESSING daily"))
        #expect(!LockedWording.isLocked(category: "preference", text: "She likes the radio on in the afternoon."))
        let long = String(repeating: "word ", count: 40) + "insulin"
        #expect(ReviewData.stepLabel(F.fact("l", long)) == "Written care instruction")
        #expect(ReviewData.quoteOf(F.fact("l", long), max: 20) == long)
    }

    @Test func shortenCutsAtAWord() {
        #expect(CareData.shorten("short", 10) == "short")
        #expect(CareData.shorten("Her spare glasses are in the top drawer", 20) == "Her spare glasses\u{2026}")
    }

    @Test func earlierVersionsFollowSupersedes() {
        let v1 = F.fact("v1", "one", status: .superseded)
        let v2 = F.fact("v2", "two", status: .superseded, version: 2, supersedes: "v1")
        let v3 = F.fact("v3", "three", status: .approved, version: 3, supersedes: "v2")
        #expect(CareData.earlierVersions(v3, in: [v1, v2, v3]).map(\.id) == ["v2", "v1"])
        #expect(CareData.earlierVersions(v1, in: [v1]).isEmpty)
    }

    @Test func uniqueOpenQuestionsIgnoreCaseAndTrailingMarks() {
        let questions = [
            OpenQuestion(id: "1", question: "What is her pharmacy\u{2019}s phone number?", askedBy: nil),
            OpenQuestion(id: "2", question: "what is her pharmacy\u{2019}s phone number", askedBy: nil),
            OpenQuestion(id: "3", question: "Who drives her?", askedBy: nil),
        ]
        #expect(CareData.uniqueOpenQuestions(questions).map(\.id) == ["1", "3"])
        #expect(CareHelp.uniqueQuestions(questions).map(\.id) == ["1", "3"])
    }

    // MARK: - review summary

    @Test func summaryCountsEveryStep() {
        let steps = ["a", "b", "c", "d", "e"].map(ReviewStep.fact) + [ReviewStep.conflict(["x", "y"])]
        let outcomes: [String: ReviewOutcome] = [
            "fact:a": .approved, "fact:b": .edited(factId: "b2", text: "B", original: "b"), "fact:c": .rejected(text: "c"),
            "fact:d": .skipped, "conflict:x,y": .kept(factId: "x"),
        ]
        let facts = [F.fact("e", "still waiting")]
        let summary = ReviewData.summarize(steps, outcomes: outcomes, facts: facts)
        #expect(summary == ReviewSummary(approved: 2, kept: 1, skipped: 2, edited: 1, rejected: 1))
        #expect(ReviewData.summaryRows(summary).map(\.label)
            == ["Approved as written", "Edited and approved", "Picked from notes that disagreed", "Rejected", "Left for later"])
        #expect(ReviewData.summarySentence(summary)
            == "1 approved as written, 1 edited and approved, 1 picked from notes that disagreed, 1 rejected, 2 left for later.")
        #expect(CareModel.finishedReceipt(summary, name: "Rosa") == "Added 3 things to Rosa\u{2019}s profile. 2 things are waiting for later.")
        #expect(CareModel.finishedReceipt(ReviewSummary(), name: "Rosa") == nil)
    }

    // MARK: - what a new source found

    @Test func addedSourceOpensAReviewWithTheNewThingsFirst() {
        let result = CareSourceResult(source: CareSourceRef(id: "s1", kind: "note"), facts: F.demoFacts, conflicts: [], droppedCount: 0)
        let older = F.fact("old", "Older", source: "s0", createdAt: "2026-11-07T00:00:00Z")
        guard case .review(let session) = CareModel.outcome(of: result, from: .note, latestFacts: [older]) else {
            Issue.record("expected a review")
            return
        }
        #expect(session.intro == "Your note has 4 new things to check, shown first.")
        #expect(session.steps.map(\.factId) == ["glasses", "breakfast", "lips", "radio", "old"])
    }

    @Test func addedConflictCarriesTheModelNote() {
        let a = F.fact("a", "She has breakfast at 8:00 every morning.", status: .conflicting, source: "s1", conflicts: ["b"])
        let b = F.fact("b", "Breakfast at 8:30 with medication.", status: .conflicting, source: "s2", conflicts: ["a"])
        let result = CareSourceResult(
            source: CareSourceRef(id: "s2", kind: "note"), facts: [b],
            conflicts: [FactConflict(factId: "b", existingFactId: "a", modelNote: "Times differ: 08:00 in the profile and 08:30 in this source.")],
            droppedCount: 1
        )
        guard case .review(let session) = CareModel.outcome(of: result, from: .voice, latestFacts: [a]) else {
            Issue.record("expected a review")
            return
        }
        #expect(session.intro == "Your voice note has 1 new thing to check. 1 other line was already on file or couldn\u{2019}t be kept word for word, so it was left out.")
        #expect(session.notes["conflict:a,b"] == "Times differ: 08:00 in the profile and 08:30 in this source.")
    }

    @Test func addedSourceWithNothingNewSaysSo() {
        let result = CareSourceResult(source: CareSourceRef(id: "s9", kind: "document"), facts: [], conflicts: [], droppedCount: 2)
        #expect(CareModel.outcome(of: result, from: .pdf, latestFacts: [])
            == .message("The PDF didn\u{2019}t have anything new to add. 2 lines were already on file or couldn\u{2019}t be kept word for word, so they were left out. Try one thing per sentence, with times where you know them."))
    }

    // MARK: - the day

    @Test func dayPreviewKeepsRecentMissedItemsThenWhatIsNext() {
        let items = (6...11).map { hour in F.item("e\(hour)", String(format: "2026-11-08T%02d:00:00Z", hour + 6)) }
        let now = AlbertaTime.parse("2026-11-08T15:30:00Z")
        let preview = TodayData.preview(items, now: now)
        // overdue 6,7,8,9 (latest two kept: 8,9), next 10,11 -> shown in time order
        #expect(preview.shown.map(\.eventId) == ["e8", "e9", "e10", "e11"])
        #expect(preview.hidden == 2)
        #expect(TodayData.preview(items, now: nil).shown.map(\.eventId) == ["e6", "e7", "e8", "e9"])
        let summary = TodayData.summary(items, now: now)
        #expect(TodayData.overviewLine(summary) == "6 things on this day. 4 earlier items aren\u{2019}t marked done. Next: 10:00 a.m.")
    }

    @Test func dayItemStatusAndText() {
        let soon = F.item("a", "2026-11-08T14:00:00Z", remind: 15, highlight: true)
        #expect(TodayData.status(soon) == .reminder)
        #expect(TodayData.status(F.item("b", "2026-11-08T14:00:00Z", completedAt: "2026-11-08T14:01:00Z")) == .done)
        #expect(TodayData.status(F.item("c", "2026-11-08T14:00:00Z")) == .planned)
        #expect(TodayData.reminderAt(soon).map { AlbertaTime.format($0, style: .time) } == "7:45 a.m.")
        let locked = F.item("d", "2026-11-08T14:00:00Z", title: "Breakfast", fullText: "Breakfast at 8:30 with medication.")
        #expect(TodayData.itemText(locked) == "Breakfast at 8:30 with medication.")
        #expect(TodayData.itemText(F.item("e", "2026-11-08T14:00:00Z", title: "Walk", fullText: "Walk around the block")) == "Walk")
        let updated = TodayData.withCompletion([soon, locked], eventId: "a", completedAt: "x")
        #expect(updated.map(\.completedAt) == ["x", nil])
    }

    // MARK: - emergency / help and ask

    @Test func phoneNumbersBecomeTelLinks() {
        #expect(CareHelp.telURL("403-555-0142")?.absoluteString == "tel:4035550142")
        #expect(CareHelp.telURL("+1 (403) 555.0142")?.absoluteString == "tel:+14035550142")
        #expect(CareHelp.telURL("call me") == nil)
        #expect(CareHelp.telURL("12") == nil)
    }

    @Test func contactDraftsAreCheckedBeforeSending() {
        var draft = CareHelp.ContactDraft(name: "  Aunt   Lucia ", relationship: "Sister", phone: "403-555-0142", kind: .trusted)
        #expect(CareHelp.check(draft) == .ok(NewCareContact(name: "Aunt Lucia", relationship: "Sister", phone: "403-555-0142", kind: .trusted)))
        draft.relationship = " "
        #expect(CareHelp.check(draft) == .ok(NewCareContact(name: "Aunt Lucia", relationship: nil, phone: "403-555-0142", kind: .trusted)))
        draft.phone = "four oh three"
        #expect(CareHelp.check(draft) == .invalid(.phone, "Use digits only, for example 403-555-0142."))
        draft.name = ""
        #expect(CareHelp.check(draft) == .invalid(.name, "Add their name."))
    }

    @Test func contactsListEmergencyFirst() {
        let contacts = [
            CareContact(id: "1", name: "Lucia", relationship: nil, phone: "1", kind: .trusted, createdAt: "2026-11-08T01:00:00Z"),
            CareContact(id: "2", name: "Sam", relationship: nil, phone: "1", kind: .emergency, createdAt: "2026-11-08T02:00:00Z"),
            CareContact(id: "3", name: "Jo", relationship: nil, phone: "1", kind: .emergency, createdAt: "2026-11-08T00:00:00Z"),
        ]
        #expect(CareHelp.orderContacts(contacts).map(\.id) == ["3", "2", "1"])
    }

    @Test func askLabelsAreHonestAboutWhoAnswered() throws {
        #expect(CareHelp.answeredByLabel(.demoRules) == "Answered by demo rules (offline), exact facts only")
        #expect(CareHelp.answeredByLabel(.none) == nil)
        #expect(CareHelp.retrievalLine(AskRetrieval(method: .keyword, considered: 3)) == "Looked through 3 approved facts, matched by words")
        #expect(CareHelp.retrievalLine(AskRetrieval(method: .keyword, considered: 0)) == "No approved facts to look through yet")
        #expect(CareHelp.retrievalLine(.none) == nil)
        let medical = try Fixtures.decode(AskResponse.self, "ask-medical")
        #expect(CareHelp.redirectText(medical).contains("811"))
        let cited = CitedFact(id: "f", category: "practical", textExact: "x", sourceKind: "voice", sourceCreatedAt: "2026-11-08T08:54:41.551Z")
        #expect(CareHelp.citationFromLine(cited, fact: nil) == "From a voice note, Nov 8")
        #expect(CareHelp.citationFromLine(CitedFact(id: "f", category: "x", textExact: "x"), fact: nil) == "Source not recorded")
    }
}
