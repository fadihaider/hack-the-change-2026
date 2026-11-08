import SwiftUI

/// Urgent tab: the care week's impact on commitments (POST /api/impact), one decision at a time
/// (/api/commitments/*), the request editor, approve and send (/api/requests/*), "Send a text" (/api/sms/*),
/// and the summary of who was asked. embeds HelpNearbyView for supports near the care recipient.
struct UrgentView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        FeaturePlaceholder(
            "Urgent",
            lead: weekLead,
            detail: "Commitments that clash with the care week, and who to tell, will be here."
        )
        .navigationTitle("Urgent")
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.urgent")
    }

    private var weekLead: String? {
        guard let episode = model.session?.episode else { return nil }
        return "Care week \(AlbertaTime.weekRange(episode.startsOn, episode.endsOn))."
    }
}
