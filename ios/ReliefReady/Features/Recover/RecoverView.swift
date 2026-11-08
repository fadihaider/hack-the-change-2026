import SwiftUI

/// Recover tab: after the care week, GET and POST /api/recover grouped into handled, waiting, needs follow-up,
/// not sent and new, with follow-ups through the request editor. embeds HelpNearbyView.
struct RecoverView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        FeaturePlaceholder(
            "Recover",
            lead: "When the week is over.",
            detail: "What was handled, what is still waiting and what needs a follow-up will be here."
        )
        .navigationTitle("Recover")
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.recover")
    }
}
