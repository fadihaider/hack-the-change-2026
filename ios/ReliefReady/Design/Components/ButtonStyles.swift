import SwiftUI

// buttons stack primary, then secondary, then quiet (ui.module.css)

/// teal fill, full width, at least 52 pt
struct PrimaryButtonStyle: ButtonStyle {
    var isBusy = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 10) {
            if isBusy {
                ProgressView().tint(.white)
            }
            configuration.label
        }
        .font(.rrButton)
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 52)
        .padding(.horizontal, 24)
        .padding(.vertical, 4)
        .background(fill(pressed: configuration.isPressed), in: .rect(cornerRadius: Theme.radius))
        .contentShape(.rect(cornerRadius: Theme.radius))
        .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }

    private func fill(pressed: Bool) -> Color {
        if !isEnabled && !isBusy { return Theme.tealDisabled }
        return pressed || isBusy ? Theme.tealInk : Theme.teal
    }
}

/// surface with a hairline, full width, at least 52 pt
struct SecondaryButtonStyle: ButtonStyle {
    var isBusy = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 10) {
            if isBusy {
                ProgressView().tint(Theme.ink)
            }
            configuration.label
        }
        .font(.rrButtonSecondary)
        .foregroundStyle(isEnabled ? Theme.ink : Theme.muted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 52)
        .padding(.horizontal, 20)
        .padding(.vertical, 4)
        .background(configuration.isPressed ? Theme.page : Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(configuration.isPressed ? Color(hex: 0xC9CED7) : Theme.hairline, lineWidth: 1)
        }
        .shadow(color: Theme.ink.opacity(0.06), radius: 1, y: 1)
        .contentShape(.rect(cornerRadius: Theme.radius))
    }
}

/// muted underlined text, centred, at least 44 pt
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Fonts.figtree(16, weight: .medium, relativeTo: .body))
            .foregroundStyle(configuration.isPressed ? Theme.ink : Theme.muted)
            .underline(true, color: Theme.muted.opacity(0.45))
            .multilineTextAlignment(.center)
            .frame(minHeight: 44)
            .padding(.horizontal, 12)
            .contentShape(.rect(cornerRadius: Theme.radiusSmall))
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
    static func primary(busy: Bool) -> PrimaryButtonStyle { PrimaryButtonStyle(isBusy: busy) }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
    static func secondary(busy: Bool) -> SecondaryButtonStyle { SecondaryButtonStyle(isBusy: busy) }
}

extension ButtonStyle where Self == QuietButtonStyle {
    static var quiet: QuietButtonStyle { QuietButtonStyle() }
}

/// the vertical stack of actions under a question, 12 pt apart
struct ButtonStack<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 12) { content }
            .frame(maxWidth: .infinity)
    }
}

#Preview {
    ButtonStack {
        Button("Check my week") {}.buttonStyle(.primary)
        Button("Checking") {}.buttonStyle(.primary(busy: true))
        Button("Type it instead") {}.buttonStyle(.secondary)
        Button("Not now") {}.buttonStyle(.quiet)
        Button("Disabled") {}.buttonStyle(.primary).disabled(true)
    }
    .padding()
    .pageBackground()
}
