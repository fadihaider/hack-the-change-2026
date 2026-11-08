import SwiftUI

/// a centred spinner with what is happening in words
struct LoadingView: View {
    var label: String

    init(_ label: String = "Loading") {
        self.label = label
    }

    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
                .tint(Theme.teal)
            Text(label)
                .font(.rrCallout)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Theme.gutter)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

#Preview {
    LoadingView("Checking your week")
}
