import SwiftUI

/// Near Rosa: the embeddable nearby section for Care, built on GET /api/care-access/nearby (type and radius
/// filters, the inline map with community outlines, straight-line distances and the limits under the map).
struct NearbySection: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        Card {
            Text("Near \(model.careRecipientName)")
                .font(.rrHeadline)
                .accessibilityAddTraits(.isHeader)
            Text("Pharmacies, clinics and stops nearby will be listed here.")
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
        }
        .accessibilityIdentifier("section.nearby")
    }
}
