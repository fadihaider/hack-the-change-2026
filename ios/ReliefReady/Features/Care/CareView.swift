import SwiftUI

/// Care tab: the care passport (/api/care/facts with PassportSection groups), adding notes, voice notes
/// (/api/stt) and pdfs (/api/care/sources), approving, editing, rejecting and resolving facts, the day's
/// timeline (/api/care/timeline, /api/care/events/*/complete), Ask (/api/care/ask) and care contacts.
/// embeds NearbySection.
struct CareView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        FeaturePlaceholder(
            "Care",
            lead: "Everything about \(model.careRecipientName), in one place.",
            detail: "The care passport, today\u{2019}s timeline and Ask will be here."
        )
        .navigationTitle("Care")
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.care")
    }
}
