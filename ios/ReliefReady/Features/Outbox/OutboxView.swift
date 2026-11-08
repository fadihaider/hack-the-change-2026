import SwiftUI

/// Outbox: the demo outbox from More (GET /api/outbox, plus simulated texts from GET /api/sms). each message
/// shows its reply links (OutboxMessage.responseLinks), which open ResponseView.
struct OutboxView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        FeaturePlaceholder(
            "Outbox",
            lead: "Nothing here was really sent.",
            detail: "Messages the demo stored, with their reply links, will be here."
        )
        .screenTitle("Outbox")
        .accessibilityIdentifier("screen.outbox")
    }
}
