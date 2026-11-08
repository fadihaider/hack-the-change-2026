import SwiftUI

/// Help nearby: the tenure question ("do you rent or own?") and the GET /api/guide cards (leave rules, EI,
/// supports, nearest hospital, pharmacy, stops) with their sources. used inside Urgent and Recover.
struct HelpNearbyView: View {
    @Environment(AppModel.self) private var model
    /// a typed address; nil uses the care recipient's saved address on the server
    var address: String?

    init(address: String? = nil) {
        self.address = address
    }

    var body: some View {
        Card {
            Text("Help nearby")
                .font(.rrHeadline)
                .accessibilityAddTraits(.isHeader)
            Text("Supports near \(model.careRecipientName) will be listed here.")
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
        }
        .accessibilityIdentifier("section.helpNearby")
    }
}
