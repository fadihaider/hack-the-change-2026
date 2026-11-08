import Foundation
import Testing
@testable import ReliefReady

/// the urgent flow's decisions (UrgentModel), the letter (LetterModel) and the text sheet (SmsModel)
@MainActor
@Suite(.serialized)
struct UrgentModelTests {
    init() {
        UrgentModel.clearCaches()
        LetterModel.clearTyped()
    }

    private func loadedModel(_ api: FakeUrgentAPI) async throws -> UrgentModel {
        let impact = try UrgentFixtures.impact()
        api.impactHandler = { _ throws(APIError) in impact }
        let model = UrgentModel(
            api: api, episodeId: "episode-\(UUID().uuidString)", care: UrgentFixtures.care, appNow: UrgentFixtures.appNow,
            senderEmail: "alex@example.test"
        )
        await model.load()
        return model
    }

    // MARK: - steps

    @Test func loadStartsOnTheFirstOpenStepInTimeOrder() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        #expect(model.total == 6)
        #expect(model.index == 0)
        #expect(model.commitments.first?.id == UrgentFixtures.groupMeetingId)
        #expect(model.commitments.last?.forCareRecipient == true)
        #expect(api.calls.contains("impact") && api.calls.contains("requests") && api.calls.contains("smsList"))
    }

    @Test func aFailedScanShowsItsProblemAndRetries() async throws {
        let api = FakeUrgentAPI()
        api.impactHandler = { _ throws(APIError) in throw APIError(code: "model_unavailable", status: 503) }
        let model = UrgentModel(api: api, episodeId: "episode-fail", care: UrgentFixtures.care, appNow: UrgentFixtures.appNow)
        await model.load()
        #expect(model.impactError == APIError.errorText["model_unavailable"])
        #expect(model.index == nil)
        let impact = try UrgentFixtures.impact()
        api.impactHandler = { _ throws(APIError) in impact }
        await model.retryImpact()
        #expect(model.impactError == nil)
        #expect(model.index == 0)
    }

    @Test func aGroupDecisionWritesToEveryTickedPersonAndOpensTheFirstLetter() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        let decided = try UrgentFixtures.decide()
        var sent: DecideInput?
        api.decideHandler = { input throws(APIError) in
            sent = input
            return decided
        }
        let group = model.commitments[0]
        await model.choose(group, .reschedule)
        #expect(sent?.contactIds == [UrgentFixtures.jordanId, UrgentFixtures.samId])
        #expect(sent?.contactId == nil)
        #expect(model.letter?.id == decided.request?.id)
        #expect(model.letter?.title == "Ask Jordan to move it")
        if case .asked(_, let lead) = model.statusOf(model.commitments[0]) {
            #expect(lead.id == decided.request?.id)
        } else {
            Issue.record("the step should show the message it wrote")
        }
    }

    @Test func untickingOnePersonWritesToTheOther() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        let decided = try UrgentFixtures.decide()
        var sent: DecideInput?
        api.decideHandler = { input throws(APIError) in
            sent = input
            return decided
        }
        let group = model.commitments[0]
        model.togglePick(group, UrgentFixtures.jordanId, on: false)
        #expect(model.recipientsOf(group) == [UrgentFixtures.samId])
        await model.choose(group, .reschedule)
        #expect(sent?.contactId == UrgentFixtures.samId)
        #expect(sent?.contactIds == nil)
    }

    @Test func aGroupMessageNeedsSomeoneTicked() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        let group = model.commitments[0]
        model.togglePick(group, UrgentFixtures.jordanId, on: false)
        model.togglePick(group, UrgentFixtures.samId, on: false)
        await model.choose(group, .notify)
        #expect(model.stepError == UrgentStepError(at: group.id, message: "Choose at least one person to hear from you."))
        #expect(!api.calls.contains { $0.hasPrefix("decide") })
    }

    @Test func aNewPlanWithdrawsTheUnsentMessageFirst() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        var impact = try UrgentFixtures.impact()
        let at = try #require(impact.commitments.firstIndex { $0.id == UrgentFixtures.groupMeetingId })
        impact.commitments[at].decision = .reschedule
        impact.commitments[at].reopened = true
        impact.commitments[at].requests = [CommitmentRequestRef(id: draft.id, state: "awaiting_approval", contactId: UrgentFixtures.jordanId)]
        let scan = impact
        api.impactHandler = { _ throws(APIError) in scan }
        api.requestsHandler = { () throws(APIError) in RequestList(requests: [draft], appNow: UrgentFixtures.appNow) }
        api.cancelHandler = { _ throws(APIError) in
            var cancelled = draft
            cancelled.state = .cancelled
            return RequestEnvelope(request: cancelled)
        }
        api.decideHandler = { input throws(APIError) in
            DecideResponse(
                commitment: DecidedCommitment(id: input.commitmentId, decision: .keep), request: nil, existing: false,
                editFlags: [], approvalBlocked: false
            )
        }
        let model = UrgentModel(api: api, episodeId: "episode-withdraw", care: UrgentFixtures.care, appNow: UrgentFixtures.appNow)
        await model.load()
        #expect(model.index == 0)
        await model.choose(model.commitments[0], .keep)
        let cancelAt = try #require(api.calls.firstIndex(of: "cancel:\(draft.id)"))
        let decideAt = try #require(api.calls.firstIndex(of: "decide:keep"))
        #expect(cancelAt < decideAt)
        #expect(model.receipt?.text == "Keeping the ENGG 513 group project meeting. The unsent message to Jordan was withdrawn.")
        #expect(model.index == 1)
    }

    @Test func rosasAppointmentGoesOnHerTimelineAndIsKept() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        api.decideHandler = { input throws(APIError) in
            DecideResponse(
                commitment: DecidedCommitment(id: input.commitmentId, decision: input.decision), request: nil,
                existing: false, editFlags: [], approvalBlocked: false
            )
        }
        model.go(5, forward: true)
        let rosa = model.commitments[5]
        await model.addTimeline(rosa, advance: true)
        #expect(api.calls.suffix(2) == ["timeline:\(UrgentFixtures.rosaId)", "decide:keep"])
        #expect(model.receipt == UrgentReceipt(text: "Added to Rosa\u{2019}s timeline in Care.", icon: .calendar))
        #expect(model.added.contains(rosa.id))
        #expect(model.onSummary)
        #expect(model.statusOf(model.commitments[5]) == .decided(decision: .keep, requests: []))
    }

    @Test func changeThePlanReopensTheStepOnTheServer() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        api.decideHandler = { input throws(APIError) in
            DecideResponse(
                commitment: DecidedCommitment(id: input.commitmentId, decision: .defer), request: nil, existing: false,
                editFlags: [], approvalBlocked: false
            )
        }
        let deadline = model.commitments[1]
        model.go(1, forward: true)
        await model.choose(deadline, .defer)
        #expect(model.receipt?.text == "You\u{2019}ll decide about the ENGG 513 assignment 4 deadline later.")
        #expect(model.index == 2)
        model.back()
        #expect(!model.statusOf(model.commitments[1]).isOpen)
        await model.reopen(model.commitments[1])
        #expect(api.calls.last == "reopen:\(deadline.id)")
        #expect(model.statusOf(model.commitments[1]).isOpen)
    }

    @Test func checkForRepliesSaysWhatChanged() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        let decided = try UrgentFixtures.decide()
        api.decideHandler = { _ throws(APIError) in decided }
        await model.choose(model.commitments[0], .reschedule)
        model.letter = nil
        let refreshed = try UrgentFixtures.refreshed()
        api.refreshHandler = { () throws(APIError) in refreshed }
        await model.checkReplies()
        #expect(model.receipt == UrgentReceipt(text: "Jordan said yes to moving it.", icon: .refresh))
        #expect(model.checkedAt == refreshed.appNow)
    }

    @Test func aFailedSendAsksToChooseAgain() async throws {
        let api = FakeUrgentAPI()
        let model = try await loadedModel(api)
        let decided = try UrgentFixtures.decide()
        api.decideHandler = { _ throws(APIError) in decided }
        await model.choose(model.commitments[0], .reschedule)
        let request = try #require(decided.request)
        model.sent(request, .failed(errorCode: "smtp"))
        #expect(model.letter == nil)
        #expect(model.stepError?.at == UrgentFixtures.groupMeetingId)
        #expect(model.stepError?.message.hasPrefix("The message to Jordan didn\u{2019}t send") == true)
    }

    // MARK: - the letter

    private func letter(_ api: FakeUrgentAPI, request: RequestView) -> (LetterModel, Box) {
        let box = Box()
        let letter = LetterModel(
            api: api, request: request, title: "Ask Jordan to move it", lead: "Change any words you like.",
            flags: [], senderEmail: "alex@example.test", outbox: true, careAlias: "Mom",
            onUpdate: { box.updates.append($0) },
            onSent: { r, outcome in box.sent.append((r, outcome)) },
            reload: { _ in box.reloadWith },
            onFlags: { _, _ in }
        )
        return (letter, box)
    }

    final class Box {
        var updates: [RequestView] = []
        var sent: [(RequestView, SendResult)] = []
        var reloadWith: RequestView?
    }

    @Test func anUntouchedLetterIsApprovedForItsRevisionThenSent() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        let approved = try UrgentFixtures.approved()
        api.approveHandler = { _, revision, _ throws(APIError) in
            #expect(revision == draft.revision)
            return RequestEnvelope(request: approved)
        }
        api.sendHandler = { _ throws(APIError) in .requested(messageId: "m1") }
        let (letter, box) = letter(api, request: draft)
        await letter.send(override: false)
        #expect(api.calls == ["approve:\(draft.revision.prefix(8)):false", "send:\(draft.id)"])
        #expect(box.sent.count == 1)
        #expect(letter.error == nil)
    }

    @Test func anEditIsSavedBeforeTheApprovalSoTheApprovalCoversTheNewWords() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        let edited = try UrgentFixtures.edited()
        var saved: RequestChanges?
        api.editHandler = { _, changes throws(APIError) in
            saved = changes
            return RequestEnvelope(request: edited)
        }
        api.approveHandler = { _, _, _ throws(APIError) in RequestEnvelope(request: try! UrgentFixtures.approved()) }
        api.sendHandler = { _ throws(APIError) in .requested(messageId: "m1") }
        let (letter, _) = letter(api, request: draft)
        letter.setBody(draft.body + " See you soon.")
        letter.setSubject("Moving our\nmeeting")
        #expect(letter.dirty)
        #expect(letter.closeLabel == "Close and save your changes")
        await letter.send(override: false)
        #expect(saved?.body == draft.body + " See you soon.")
        #expect(saved?.subject == "Moving our meeting")
        #expect(api.calls.first == "edit:\(draft.id)")
        #expect(api.calls.contains("approve:\(edited.revision.prefix(8)):false"))
    }

    @Test func healthWordsHoldTheApprovalBack() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        var flagged = try UrgentFixtures.edited()
        flagged.healthTermsFound = ["surgery"]
        let held = flagged
        api.editHandler = { _, _ throws(APIError) in RequestEnvelope(request: held) }
        let (letter, _) = letter(api, request: draft)
        letter.setBody("Mom had surgery.")
        await letter.send(override: false)
        #expect(letter.blocked)
        #expect(letter.terms == ["surgery"])
        #expect(!api.calls.contains { $0.hasPrefix("approve") })
    }

    @Test func aRefusedApprovalNamesTheTermsAndAnOverrideSendsAnyway() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        api.approveHandler = { _, _, override throws(APIError) in
            if !override { throw APIError(code: "health_terms", status: 422, terms: ["hip"]) }
            return RequestEnvelope(request: try! UrgentFixtures.approved())
        }
        api.sendHandler = { _ throws(APIError) in .requested(messageId: "m1") }
        let (letter, box) = letter(api, request: draft)
        await letter.send(override: false)
        #expect(letter.refused == ["hip"])
        #expect(letter.blocked)
        await letter.send(override: true)
        #expect(api.calls.contains("approve:\(draft.revision.prefix(8)):true"))
        #expect(box.sent.count == 1)
    }

    @Test func aStaleApprovalReloadsTheMessage() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        api.approveHandler = { _, _, _ throws(APIError) in throw APIError(code: "precondition_failed", status: 412) }
        let (letter, box) = letter(api, request: draft)
        box.reloadWith = try UrgentFixtures.edited()
        await letter.send(override: false)
        #expect(letter.error == "This message changed. Review it again.")
        #expect(letter.current.revision == box.reloadWith?.revision)
        #expect(!letter.dirty)
    }

    @Test func aSendTheServerHeldBackNeedsAnotherLook() async throws {
        let api = FakeUrgentAPI()
        let approved = try UrgentFixtures.approved()
        api.sendHandler = { _ throws(APIError) in .needsReview }
        let (letter, box) = letter(api, request: approved)
        #expect(letter.leadLine == "You approved these exact words. Send them when you\u{2019}re ready.")
        await letter.send(override: false)
        #expect(letter.error == "Nothing was sent. The message changed after you approved it. Review it again.")
        #expect(box.sent.isEmpty)
    }

    @Test func aTierIsOnlyPickedUntilItIsApplied() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        var general = try UrgentFixtures.edited()
        general.disclosureTier = .general
        let rewritten = general
        api.redraftHandler = { _, tier throws(APIError) in
            #expect(tier == .general)
            return RedraftResult(request: rewritten, editFlags: ["url"], approvalBlocked: false)
        }
        let (letter, _) = letter(api, request: draft)
        letter.pickTier(.general)
        #expect(letter.pendingTier == .general)
        #expect(letter.tierQuestion == "Share it as \u{201C}Say I\u{2019}m caring for my mom\u{201D}? The message is written again at this level.")
        await letter.send(override: false)
        #expect(letter.error == "Finish changing how much it shares, or cancel it, before you send.")
        await letter.useTier()
        #expect(api.calls == ["redraft:general"])
        #expect(letter.current.disclosureTier == .general)
        #expect(letter.pendingTier == nil)
        #expect(letter.flagNotes == ["It has a web link. Check it before sending."])
    }

    @Test func removeThemDropsTheWordsAndSaves() async throws {
        let api = FakeUrgentAPI()
        var draft = try UrgentFixtures.draft()
        draft.healthTermsFound = ["surgery"]
        draft.body = "Mom had surgery today."
        var saved: RequestChanges?
        let clean = try UrgentFixtures.edited()
        api.editHandler = { _, changes throws(APIError) in
            saved = changes
            return RequestEnvelope(request: clean)
        }
        let (letter, _) = letter(api, request: draft)
        #expect(letter.blocked)
        await letter.strip()
        #expect(saved?.body == "Mom had today.")
        #expect(!letter.blocked)
    }

    @Test func closingKeepsOrSavesTypedWords() async throws {
        let api = FakeUrgentAPI()
        let draft = try UrgentFixtures.draft()
        api.editHandler = { _, _ throws(APIError) in throw APIError(code: "network_error", status: 0) }
        let (first, _) = letter(api, request: draft)
        first.setBody("Typed but not saved")
        let note = await first.saveOnClose()
        #expect(note.hasPrefix("Your changes are kept here but weren\u{2019}t saved."))
        // opening the same request again brings the typed words back
        let (second, _) = letter(api, request: draft)
        #expect(second.body == "Typed but not saved")
    }

    // MARK: - texts

    @Test func aTextIsApprovedForItsExactWordsThenSent() async throws {
        let api = FakeUrgentAPI()
        let recipients = try Fixtures.decode(SmsRecipients.self, "sms-recipients")
        let draft = try Fixtures.decode(SmsDraft.self, "sms-draft")
        api.smsRecipientsHandler = { () throws(APIError) in recipients }
        api.smsDraftHandler = { input throws(APIError) in
            #expect(input.recipientName == "Aunt Lucia")
            #expect(input.senderName == "Alex")
            return draft
        }
        var approvedInput: SmsApproveInput?
        let text = SmsView(
            id: "sms-1", episodeId: "e", state: .approved, delivery: .notSent,
            recipient: SmsRecipient(label: "Aunt Lucia", phoneMasked: "(\u{2022}\u{2022}\u{2022}) \u{2022}\u{2022}\u{2022}-0142"),
            senderName: "Alex", body: draft.text, disclosureTier: .minimal, healthTermsFound: [], healthOverride: false,
            provider: .demo, providerMessageId: nil, providerStatus: nil, errorCode: nil, submittedAt: nil, statusAt: nil,
            approvedAt: "2026-11-08T08:00:00.000Z", updatedAt: "2026-11-08T08:00:00.000Z"
        )
        api.smsApproveHandler = { input throws(APIError) in
            approvedInput = input
            return SmsEnvelope(text: text)
        }
        var simulated = text
        simulated.delivery = .simulated
        let done = simulated
        api.smsSendHandler = { _ throws(APIError) in SmsEnvelope(text: done) }
        var changes: [SmsView?] = []
        let sms = SmsModel(api: api, episodeId: "e", careAlias: "Mom", aiMode: "demo") { changes.append($0) }
        await sms.loadRecipients()
        #expect(sms.choice.hasPrefix("care:"))
        #expect(sms.draftLabel == "Write a draft (demo rules)")
        await sms.writeDraft()
        #expect(sms.body == draft.text)
        #expect(!sms.canSend)
        sms.approved = true
        #expect(sms.canSend)
        await sms.send()
        #expect(approvedInput?.to == .careContact(id: "ab9d0d57-1e1d-4c45-b8d3-256b0d7901a6"))
        #expect(approvedInput?.body == draft.text)
        #expect(sms.result?.delivery == .simulated)
        #expect(changes.count == 2)
        // any change to the words needs a fresh tick
        sms.editBody("Changed")
        #expect(!sms.approved)
        #expect(sms.result == nil)
    }

    @Test func aTypedNumberMustBeNorthAmerican() {
        let sms = SmsModel(api: FakeUrgentAPI(), episodeId: nil, careAlias: nil, aiMode: "demo") { _ in }
        sms.otherPhone = "12"
        #expect(sms.phoneInvalid)
        #expect(sms.to == nil)
        sms.otherPhone = "403 555 0142"
        sms.otherName = "Lucia"
        #expect(sms.to == .phone("+14035550142", label: "Lucia"))
        #expect(sms.approveLine == "I approve sending exactly this text to Lucia at (403) 555-0142.")
    }
}
