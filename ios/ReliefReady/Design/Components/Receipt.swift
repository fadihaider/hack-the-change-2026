import SwiftUI

/// a calm confirmation of what just happened, shown above the next question
struct Receipt: View {
    var text: String
    var systemImage: String

    init(_ text: String, systemImage: String = "checkmark") {
        self.text = text
        self.systemImage = systemImage
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .font(.rrCallout.weight(.semibold))
                .accessibilityHidden(true)
            Text(text)
                .font(.rrCallout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Theme.goodInk)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.goodTint, in: .rect(cornerRadius: Theme.radius))
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    Receipt("Saved. Jordan will get the request once you approve it.").padding()
}
