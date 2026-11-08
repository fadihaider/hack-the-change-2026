import SwiftUI

/// the one big question on a screen, with an optional muted lead before it (Question in ui.tsx)
struct QuestionHeader: View {
    var lead: String?
    var question: String

    init(_ question: String, lead: String? = nil) {
        self.question = question
        self.lead = lead
    }

    var body: some View {
        heading
            .font(.rrQuestion)
            .foregroundStyle(Theme.ink)
            .tracking(-0.34)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 28)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
    }

    private var heading: Text {
        if let lead, !lead.isEmpty {
            let muted = Text(lead).foregroundStyle(Theme.muted).font(Fonts.figtree(34, weight: .medium, relativeTo: .largeTitle))
            return Text("\(muted) \(question)")
        }
        return Text(question)
    }
}

#Preview {
    VStack {
        QuestionHeader("Who should hear about it?", lead: "Your shift on Tuesday is during the care week.")
        QuestionHeader("What's going on?")
    }
    .padding()
    .pageBackground()
}
