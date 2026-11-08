import SwiftUI

/// the recipient's reply page (/r/[token] on the web), opened from an Outbox link: confirm accept or decline,
/// or propose another time, with POST /api/responses/[token]. nothing is recorded until the confirm.
struct ResponseView: View {
    @Environment(AppModel.self) private var model
    var link: ResponseLink

    init(link: ResponseLink) {
        self.link = link
    }

    var body: some View {
        FeaturePlaceholder(
            "Answer this request",
            lead: "Nothing is recorded until you confirm.",
            detail: "The reply page for this link will be here."
        )
        .screenTitle("Reply")
        .accessibilityIdentifier("screen.response")
    }
}
