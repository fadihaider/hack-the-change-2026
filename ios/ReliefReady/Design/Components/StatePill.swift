import SwiftUI

/// a rounded status word with a tone (TonePill in ui.tsx)
struct TonePill: View {
    var text: String
    var tone: StateTone

    init(_ text: String, tone: StateTone) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        let colors = Theme.colors(for: tone)
        Text(text)
            .font(.rrPill)
            .lineLimit(1)
            .foregroundStyle(colors.ink)
            .padding(.horizontal, 10)
            .frame(minHeight: 26)
            .background(colors.tint, in: .capsule)
            .accessibilityLabel(text)
    }
}

/// a request state in its own words and tone (StatePill in ui.tsx)
struct StatePill: View {
    var state: RequestState

    var body: some View {
        TonePill(Labels.state(state), tone: Labels.tone(state))
            .accessibilityLabel("Status: \(Labels.state(state))")
    }
}

#Preview {
    VStack(alignment: .leading) {
        ForEach(RequestState.allCases, id: \.self) { StatePill(state: $0) }
    }
    .padding()
}
