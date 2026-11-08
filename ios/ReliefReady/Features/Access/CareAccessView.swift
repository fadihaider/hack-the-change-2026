import SwiftUI

/// Care access map: the Calgary explorer from More. owns GET /api/care-access/home, /basemap, and
/// /api/care-access?view=scores and ?area=ID (mode, threshold, categories and step-free filters).
struct CareAccessView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        FeaturePlaceholder(
            "Care access map",
            lead: "Calgary communities, by what\u{2019}s in reach.",
            detail: "The map and the community scores will be here."
        )
        .navigationTitle("Care access")
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.careAccess")
    }
}
