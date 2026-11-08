import Foundation
import Testing
@testable import ReliefReady

/// the shell's shared state: the care recipient's name and moving between tabs
@MainActor
struct AppModelTests {
    private static func session(displayName: String?, alias: String) throws -> Session {
        var session = try Fixtures.decode(Session.self, "session")
        session.careRecipient = CareRecipientSummary(id: "r1", alias: alias, displayName: displayName)
        return session
    }

    @Test func recipientNameMatchesTheWeb() throws {
        #expect(AppModel.recipientName(try Self.session(displayName: "Rosa", alias: "Mom")) == "Rosa")
        #expect(AppModel.recipientName(try Self.session(displayName: nil, alias: "Mom")) == "Mom")
        #expect(AppModel.recipientName(try Self.session(displayName: "", alias: "Mom")) == "Mom")
        #expect(AppModel.recipientName(try Self.session(displayName: nil, alias: "")) == "your family member")
        #expect(AppModel.recipientName(nil) == "your family member")
    }

    @Test func showUrgentSwitchesTabAndKeepsTheLink() {
        let model = AppModel()
        model.selectedTab = .recover
        model.showUrgent()
        #expect(model.selectedTab == .urgent)
        #expect(model.urgentLink == nil)

        model.selectedTab = .care
        model.showUrgent(requestId: "r-42")
        #expect(model.selectedTab == .urgent)
        #expect(model.urgentLink?.requestId == "r-42")
        #expect(model.urgentLink?.fromStart == false)

        model.showUrgent(fromStart: true)
        #expect(model.urgentLink?.requestId == nil)
        #expect(model.urgentLink?.fromStart == true)
    }

    @Test func launchTabReadsStartTab() throws {
        let defaults = try #require(UserDefaults(suiteName: "AppModelTests.launchTab"))
        defer { defaults.removePersistentDomain(forName: "AppModelTests.launchTab") }
        #expect(AppTab.launchTab(defaults) == .urgent)
        defaults.set("recover", forKey: "StartTab")
        #expect(AppTab.launchTab(defaults) == .recover)
        defaults.set("nonsense", forKey: "StartTab")
        #expect(AppTab.launchTab(defaults) == .urgent)
    }
}
