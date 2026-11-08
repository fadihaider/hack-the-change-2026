import SwiftUI

/// a rounded status word with a tone (TonePill in ui.tsx)
struct TonePill: View {
    var text: String
    var tone: StateTone
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(_ text: String, tone: StateTone) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        let colors = Theme.colors(for: tone)
        // at accessibility sizes the words wrap instead of ending in an ellipsis beside a name
        let wraps = dynamicTypeSize.isAccessibilitySize
        Text(text)
            .font(.rrPill)
            .lineLimit(wraps ? nil : 1)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(colors.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, wraps ? 4 : 0)
            .frame(minHeight: 26)
            .background(colors.tint, in: .rect(cornerRadius: wraps ? Theme.radiusSmall : 13))
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
