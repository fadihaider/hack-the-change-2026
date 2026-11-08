import SwiftUI

// small pieces the urgent screens share: busy buttons, the meta lines, message rows and the tier picker

/// a button that shows what it is doing while busy (Button busy/busyLabel in ui.tsx)
struct UrgentButton: View {
    enum Kind {
        case primary, secondary, quiet
    }

    var title: String
    var kind: Kind = .secondary
    var systemImage: String?
    var isBusy = false
    var busyTitle: String?
    var identifier: String
    var accessibilityLabel: String?
    var action: () -> Void

    var body: some View {
        let shown = isBusy ? (busyTitle ?? title) : title
        let button = Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage, !isBusy {
                    Image(systemName: systemImage).accessibilityHidden(true)
                }
                Text(shown).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: kind == .quiet ? nil : .infinity)
        }
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(accessibilityLabel ?? shown)
        Group {
            switch kind {
            case .primary: button.buttonStyle(.primary(busy: isBusy))
            case .secondary: button.buttonStyle(.secondary(busy: isBusy))
            case .quiet:
                HStack(spacing: 8) {
                    if isBusy { ProgressView().tint(Theme.muted) }
                    button.buttonStyle(.quiet)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// two or three secondary choices side by side when there is room, stacked otherwise (Choices in ui.tsx)
struct ChoiceRow<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { content }
            VStack(spacing: 10) { content }
        }
    }
}

/// one muted line with an icon: when, why it clashes, where, with whom
struct MetaLine: View {
    var systemImage: String
    var text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .font(Fonts.figtree(14, weight: .medium, relativeTo: .subheadline))
                .frame(width: 18)
                .accessibilityHidden(true)
            Text(text)
                .font(Fonts.figtree(15, relativeTo: .subheadline))
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Theme.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// a section title inside a screen (groupTitle in urgent.module.css)
struct GroupTitle: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(Fonts.figtree(16, weight: .semibold, relativeTo: .headline))
            .foregroundStyle(Theme.ink)
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// a thin rule between rows
struct Hairline: View {
    var body: some View {
        Rectangle().fill(Theme.hairline).frame(height: 1).accessibilityHidden(true)
    }
}

/// how much one message shares: three choices, the contact group's usual tier marked (TierPicker.tsx)
struct TierPicker: View {
    var value: DisclosureTier
    var groupTier: DisclosureTier?
    var alias: String?
    var disabled: Bool
    var identifierPrefix: String
    var onChange: (DisclosureTier) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            GroupTitle("How much to share")
            ForEach(UrgentWords.tiers, id: \.self) { tier in
                RadioRow(
                    title: UrgentWords.tierLabel(tier, alias: alias),
                    hint: UrgentWords.tierHint(tier),
                    badge: groupTier == tier ? "Usual for this group" : nil,
                    selected: value == tier,
                    identifier: "\(identifierPrefix).tier.\(tier.rawValue)"
                ) { onChange(tier) }
                .disabled(disabled)
            }
        }
    }
}

/// one choice of several: a ring that fills when chosen, the name and a hint
struct RadioRow: View {
    var title: String
    var hint: String?
    var badge: String?
    var selected: Bool
    var checkbox = false
    var identifier: String
    var action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                mark.padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.rrBodyMedium)
                        .foregroundStyle(Theme.ink)
                    if let hint {
                        Text(hint).font(.rrNote).foregroundStyle(Theme.muted)
                    }
                    if let badge {
                        Text(badge)
                            .font(.rrPill)
                            .foregroundStyle(Theme.tealInk)
                            .padding(.top, 2)
                    }
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? Theme.tealTint : Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .strokeBorder(selected ? Theme.teal : Theme.hairline, lineWidth: selected ? 1.5 : 1)
            }
            .opacity(isEnabled ? 1 : 0.6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([title, hint, badge].compactMap { $0 }.joined(separator: ". "))
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityValue(checkbox ? (selected ? "Checked" : "Not checked") : "")
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder private var mark: some View {
        if checkbox {
            Image(systemName: selected ? "checkmark.square.fill" : "square")
                .font(.system(size: 20))
                .foregroundStyle(selected ? Theme.teal : Theme.fieldBorder)
        } else {
            ZStack {
                Circle().strokeBorder(selected ? Theme.teal : Theme.fieldBorder, lineWidth: 2)
                if selected { Circle().fill(Theme.teal).padding(5) }
            }
            .frame(width: 20, height: 20)
        }
    }
}

/// a warning box: the words that hold a message back and what to do (warn in urgent.module.css)
struct WarnBox<Content: View>: View {
    var title: String
    var text: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.shield").accessibilityHidden(true)
                Text(title).font(.rrBodyMedium)
            }
            .foregroundStyle(Theme.warnInk)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Text(text).font(.rrNote).foregroundStyle(Theme.ink)
            content
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.warnInk.opacity(0.3), lineWidth: 1)
        }
    }
}

/// a muted note with an info icon
struct InfoLine: View {
    var text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "info.circle").accessibilityHidden(true)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(.rrNote)
        .foregroundStyle(Theme.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// the paper a message sits on: a white surface with a hairline
struct Paper<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
            .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
            .shadow(color: Theme.ink.opacity(0.05), radius: 1, y: 1)
    }
}

/// a small label above a field on the paper
struct PaperLabel: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(Fonts.figtree(13, weight: .semibold, relativeTo: .caption))
            .foregroundStyle(Theme.muted)
    }
}
