import SwiftUI

/// back button, "2 of 5" and one segment per step (Progress in ui.tsx)
struct StepProgress: View {
    var total: Int
    /// zero-based; total or more means finished
    var current: Int
    /// one per step, read by VoiceOver
    var labels: [String] = []
    var backLabel = "Back"
    var onBack: (() -> Void)?

    private var countText: String {
        current >= total ? "\(total) of \(total)" : "\(current + 1) of \(total)"
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack {
                if let onBack {
                    Button(action: onBack) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left").accessibilityHidden(true)
                            Text(backLabel)
                        }
                        .font(Fonts.figtree(15, weight: .medium, relativeTo: .callout))
                        .foregroundStyle(Theme.muted)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(backLabel)
                }
                Spacer()
                Text(countText)
                    .font(.rrNote.monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .accessibilityLabel("Step \(countText)")
            }
            .frame(minHeight: 44)

            HStack(spacing: 6) {
                ForEach(0..<max(total, 1), id: \.self) { index in
                    Capsule()
                        .fill(fill(index))
                        .frame(height: 4)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(stepsSummary)
        }
        .padding(.bottom, 20)
    }

    private func fill(_ index: Int) -> Color {
        if index == current { return Theme.ink }
        return index < current ? Theme.teal : Theme.hairline
    }

    private var stepsSummary: String {
        (0..<max(total, 1)).map { index in
            let name = labels.indices.contains(index) ? labels[index] : "Step \(index + 1)"
            let status = index == current ? "on screen now" : index < current ? "done" : "not done yet"
            return "\(name), \(status)"
        }
        .joined(separator: "; ")
    }
}

#Preview {
    StepProgress(total: 5, current: 2, onBack: {}).padding()
}
