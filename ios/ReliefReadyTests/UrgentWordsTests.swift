import Foundation
import Testing
@testable import ReliefReady

/// the urgent wording ported from words.ts, smsWords.ts, phone.ts and HelpNearby.tsx
@MainActor
struct UrgentWordsTests {
    @Test func shortNamesKeepTitlesAndAddresses() {
        #expect(UrgentWords.shortName("Jordan Lee") == "Jordan")
        #expect(UrgentWords.shortName("Dr. Sam Brooks") == "Dr. Brooks")
        #expect(UrgentWords.shortName("ta@uni.example") == "ta@uni.example")
        #expect(UrgentWords.shortName("  ") == "them")
    }

    @Test func joinsAndQuotes() {
        #expect(UrgentWords.joinNames(["Jordan"]) == "Jordan")
        #expect(UrgentWords.joinNames(["Jordan", "Sam", "Lucia"]) == "Jordan, Sam and Lucia")
        #expect(UrgentWords.quoted(["hip", "surgery"]) == "\u{201C}hip\u{201D} and \u{201C}surgery\u{201D}")
    }

    @Test func titlesInSentences() throws {
        let commitments = try UrgentFixtures.impact().commitments
        let rosa = try #require(commitments.first { $0.forCareRecipient })
        #expect(UrgentWords.refTitle(rosa, UrgentFixtures.care) == "Rosa\u{2019}s follow-up appointment")
        let group = try #require(commitments.first { $0.id == UrgentFixtures.groupMeetingId })
        #expect(UrgentWords.refTitle(group, UrgentFixtures.care) == "the ENGG 513 group project meeting")
        #expect(UrgentWords.buttonTitle(group, UrgentFixtures.care) == "ENGG 513 group project meeting")
        let dinner = try #require(commitments.first { $0.title.hasPrefix("Family dinner") })
        #expect(UrgentWords.refTitle(dinner, UrgentFixtures.care) == "the family dinner at Lucia\u{2019}s")
    }

    @Test func factAndWhenLines() throws {
        let commitments = try UrgentFixtures.impact().commitments
        let group = try #require(commitments.first { $0.id == UrgentFixtures.groupMeetingId })
        #expect(
            UrgentWords.factLine(group, UrgentFixtures.care, appNow: UrgentFixtures.appNow)
                == "Your ENGG 513 group project meeting is Monday at 10\u{00A0}a.m."
        )
        #expect(UrgentWords.whenLine(group) == "Monday, Nov 9, 10 to 11:30\u{00A0}a.m.")
        let deadline = try #require(commitments.first { $0.title.contains("deadline") })
        #expect(UrgentWords.whenLine(deadline) == "Due Tuesday, Nov 10, 11\u{00A0}p.m.")
        // after it ended, the fact is in the past tense
        #expect(UrgentWords.factLine(group, UrgentFixtures.care, appNow: "2026-11-20T00:00:00Z").contains(" was Monday"))
        #expect(UrgentWords.stamp("2026-11-08T16:00:00.000Z") == "Sun, Nov 8, 10\u{00A0}a.m.")
    }

    @Test func tierLabelsNameFamilyWordsOnly() {
        #expect(UrgentWords.tierLabel(.general, alias: "Mom") == "Say I\u{2019}m caring for my mom")
        #expect(UrgentWords.tierLabel(.general, alias: "my Dad") == "Say I\u{2019}m caring for my dad")
        #expect(UrgentWords.tierLabel(.general, alias: "Rosa") == "Say I\u{2019}m caring for family")
        #expect(UrgentWords.tierLabel(.minimal, alias: "Mom") == "Family matter only")
        #expect(UrgentWords.tierLabel(.detailed, alias: nil) == "Share more detail")
    }

    @Test func removesHealthTermsAndTidiesSpaces() {
        #expect(UrgentWords.removeTerms("Mom had hip surgery today.", ["hip", "surgery"]) == "Mom had today.")
        #expect(UrgentWords.removeTerms("After her surgeries , rest", ["surgery"]) == "After her, rest")
        #expect(UrgentWords.removeTerms("Post-op care and post op checks", ["post-op"]) == "care and checks")
        #expect(UrgentWords.removeTerms("hipster stays", ["hip"]) == "hipster stays")
    }

    @Test func outcomesReadAsPlainSentences() throws {
        var r = try UrgentFixtures.draft()
        #expect(UrgentWords.outcomeLine(r) == "Your message to Jordan is ready for your OK.")
        r.state = .requested
        #expect(UrgentWords.outcomeLine(r) == "You asked Jordan to move it.")
        r.state = .accepted
        #expect(UrgentWords.outcomeLine(r) == "Jordan said yes to moving it.")
        var sam = try UrgentFixtures.draft()
        sam.id = "sam"
        sam.recipient = RequestRecipient(contactId: UrgentFixtures.samId, name: "Sam Patel", email: "sam@example.test")
        #expect(UrgentWords.outcomeLineMany([r, sam]) == "You wrote to Jordan and Sam. One message is ready for your OK.")
    }

    @Test func defaultRecipientsSkipPeopleAlreadyWaiting() throws {
        let group = try #require(try UrgentFixtures.impact().commitments.first { $0.id == UrgentFixtures.groupMeetingId })
        #expect(UrgentWords.defaultRecipients(group, []) == [UrgentFixtures.jordanId, UrgentFixtures.samId])
        var sent = try UrgentFixtures.draft()
        sent.state = .requested
        #expect(UrgentWords.defaultRecipients(group, [sent]) == [UrgentFixtures.samId])
    }

    @Test func openStepPlans() {
        let reschedule = UrgentWeekView.plan(suggested: .reschedule, who: "Jordan and Sam")
        #expect(reschedule.primary == .reschedule)
        #expect(reschedule.ask == "Ask Jordan and Sam to move it?")
        #expect(reschedule.others == [.notify, .defer])
        #expect(reschedule.quiet == .keep)
        let keep = UrgentWeekView.plan(suggested: .keep, who: "them")
        #expect(keep.ask == "Keep it as planned?")
        #expect(keep.quiet == .defer)
        #expect(UrgentWeekView.plan(suggested: nil, who: "Lucia").ask == "Let Lucia know you might miss it?")
    }

    @Test func phonesAndTextParts() {
        #expect(SmsWords.normalizePhone("403-555-0123") == "+14035550123")
        #expect(SmsWords.normalizePhone("+1 (403) 555 0123") == "+14035550123")
        #expect(SmsWords.normalizePhone("+44 20 7946 0958") == nil)
        #expect(SmsWords.normalizePhone("103 555 0123") == nil)
        #expect(SmsWords.normalizePhone("403 555 012a") == nil)
        #expect(SmsWords.formatPhone("+14035550123") == "(403) 555-0123")
        let short = SmsWords.smsParts("Hi Lucia")
        #expect(short.parts == 1 && !short.unicode && short.chars == 8)
        #expect(SmsWords.smsParts(String(repeating: "a", count: 161)).parts == 2)
        #expect(SmsWords.smsParts("I\u{2019}m away").unicode)
        #expect(SmsWords.smsParts("").parts == 0)
        #expect(SmsWords.failureNote("twilio_99999") == "It didn\u{2019}t go out (Twilio error 99999).")
    }

    @Test func helpNearbyWording() throws {
        #expect(HelpNearbyModel.placeName("DOWNTOWN EAST VILLAGE") == "Downtown East Village")
        #expect(HelpNearbyModel.placeName("BRIDGELAND/RIVERSIDE") == "Bridgeland/Riverside")
        #expect(HelpNearbyModel.checkedOn("2026-11-07") == "Nov 7, 2026")
        #expect(HelpNearbyModel.checkedOn("2026-11-07T10:00:00Z") == "Nov 7, 2026")
        #expect(HelpNearbyModel.checkedOn("soon") == nil)
        let guide = try Fixtures.decode(GuideResponse.self, "guide")
        let groups = HelpNearbyModel.group(guide.cards)
        #expect(groups.near.map(\.kind) == ["hospital", "pharmacy", "transit"])
        #expect(groups.work.map(\.kind) == ["leave", "ei"])
        #expect(groups.support.count == 10)
        #expect(groups.other.isEmpty)
        #expect(HelpNearbyModel.usesOSM(guide.cards))
    }
}
