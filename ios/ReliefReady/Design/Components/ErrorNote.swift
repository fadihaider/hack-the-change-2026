import SwiftUI

/// what went wrong in plain words, with an optional retry (ErrorNote in ui.tsx)
struct ErrorNote: View {
    var message: String
    var retryLabel: String
    var onRetry: (() -> Void)?

    init(_ message: String, retryLabel: String = "Try again", onRetry: (() -> Void)? = nil) {
        self.message = message
        self.retryLabel = retryLabel
        self.onRetry = onRetry
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "exclamationmark.circle")
                    .font(.rrCallout.weight(.semibold))
                    .accessibilityHidden(true)
                Text(message)
                    .font(.rrCallout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Error: \(message)")

            if let onRetry {
                Button(retryLabel, action: onRetry)
                    .font(Fonts.figtree(15, weight: .semibold, relativeTo: .callout))
                    .foregroundStyle(Theme.badInk)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radiusSmall)
                            .strokeBorder(Theme.badInk.opacity(0.35), lineWidth: 1)
                    }
                    .padding(.leading, 28)
                    .accessibilityLabel(retryLabel)
            }
        }
        .foregroundStyle(Theme.badInk)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Theme.badTint, in: .rect(cornerRadius: Theme.radius))
    }
}

#Preview {
    VStack {
        ErrorNote("The live service could not be reached. Refresh before taking another action.") {}
        ErrorNote("Some details were not accepted. Check them and try again.")
    }
    .padding()
}
