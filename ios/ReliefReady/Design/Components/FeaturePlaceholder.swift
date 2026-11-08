import SwiftUI

/// what a feature stub shows until its screen is built: the title as the question and one muted line
struct FeaturePlaceholder: View {
    var title: String
    var lead: String?
    var detail: String

    init(_ title: String, lead: String? = nil, detail: String) {
        self.title = title
        self.lead = lead
        self.detail = detail
    }

    var body: some View {
        ScreenColumn {
            QuestionHeader(title, lead: lead)
            Card {
                Text(detail)
                    .font(.rrBody)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

#Preview {
    FeaturePlaceholder("Urgent", lead: "Rosa needs you this week.", detail: "This screen is being built.")
}
