import SwiftUI

// the filter controls the nearby section and the access explorer share (chips, segments and check rows in
// NearbyResourcesAndMap.module.css and AccessMap.module.css). every control is at least 44 pt tall

/// lays its children out in rows, wrapping to the next row when one is full
struct AccessFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = arrange(width: width, subviews: subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let used = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? used, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(width: bounds.width, subviews: subviews)
        for row in rows {
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y),
                    proposal: ProposedViewSize(width: item.size.width, height: row.height)
                )
            }
        }
    }

    private struct Item {
        var index: Int
        var x: CGFloat
        var size: CGSize
    }

    private struct Row {
        var y: CGFloat
        var height: CGFloat = 0
        var width: CGFloat = 0
        var items: [Item] = []
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row(y: 0)
        for index in subviews.indices {
            // a child never gets more than the whole width, so a long label wraps inside its chip
            var size = subviews[index].sizeThatFits(ProposedViewSize(width: nil, height: nil))
            if size.width > width {
                size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            }
            let x = row.items.isEmpty ? 0 : row.width + spacing
            if !row.items.isEmpty && x + size.width > width {
                rows.append(row)
                row = Row(y: row.y + row.height + lineSpacing)
                row.items.append(Item(index: index, x: 0, size: size))
                row.width = size.width
            } else {
                row.items.append(Item(index: index, x: x, size: size))
                row.width = x + size.width
            }
            row.height = max(row.height, size.height)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// a field's bold label, read as a header
struct AccessFieldLabel: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.rrLabel)
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
    }
}

/// a toggle chip: teal tint and border when on
struct AccessChip: View {
    var title: String
    var isOn: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .frame(minHeight: 44)
                .foregroundStyle(isOn ? Theme.tealInk : Theme.ink)
                .background(isOn ? Theme.tealTint : Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radiusSmall)
                        .strokeBorder(isOn ? Theme.teal : Theme.hairline, lineWidth: isOn ? 2 : 1)
                }
                .contentShape(.rect(cornerRadius: Theme.radiusSmall))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityHint(isOn ? "Ticked. Double-tap to leave it out." : "Not ticked. Double-tap to include it.")
    }
}

/// one choice from a short row of equal segments (radio buttons on the web)
struct AccessSegments<Value: Hashable>: View {
    var label: String
    var values: [Value]
    var selection: Value
    var title: (Value) -> String
    var identifier: (Value) -> String
    var isEnabled: (Value) -> Bool = { _ in true }
    var onSelect: (Value) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(AccessFlowLayout(spacing: 6, lineSpacing: 6)) : AnyLayout(HStackLayout(spacing: 6))
        layout {
            ForEach(values, id: \.self) { value in
                let isOn = value == selection
                let enabled = isEnabled(value)
                Button {
                    onSelect(value)
                } label: {
                    Text(title(value))
                        .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline).monospacedDigit())
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 6)
                        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? nil : .infinity, minHeight: 44)
                        .padding(.horizontal, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
                        .foregroundStyle(isOn ? Theme.tealInk : enabled ? Theme.ink : Theme.muted)
                        .background(
                            isOn ? Theme.tealTint : enabled ? Theme.surface : Theme.page,
                            in: .rect(cornerRadius: Theme.radiusSmall)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: Theme.radiusSmall)
                                .strokeBorder(
                                    isOn ? Theme.teal : Theme.hairline,
                                    style: StrokeStyle(lineWidth: isOn ? 2 : 1, dash: enabled ? [] : [4, 3])
                                )
                        }
                        .contentShape(.rect(cornerRadius: Theme.radiusSmall))
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .accessibilityLabel(title(value))
                .accessibilityValue(isOn ? "Chosen" : "")
                .accessibilityAddTraits(isOn ? .isSelected : [])
                .accessibilityHint("\(label), one of \(values.count)")
                .accessibilityIdentifier(identifier(value))
            }
        }
        .frame(maxWidth: 400, alignment: .leading)
    }
}

/// a checkbox row: a square tick and a bold label
struct AccessCheckRow: View {
    var title: String
    var isOn: Bool
    var isEnabled = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 21, weight: .regular))
                    .foregroundStyle(isOn ? Theme.teal : Theme.fieldBorder)
                    .accessibilityHidden(true)
                Text(title)
                    .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                    .foregroundStyle(isEnabled ? Theme.ink : Theme.muted)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(title)
        .accessibilityValue(isOn ? "Ticked" : "Not ticked")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

/// a warm notice under a filter (notice in the web css)
struct AccessNotice: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.rrNote)
            .foregroundStyle(Theme.warnInk)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radiusSmall))
    }
}

/// a muted hint line
struct AccessHint: View {
    var text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// a quiet grey panel for loading and empty states
struct AccessStatePanel: View {
    var text: String
    var isEmpty = false

    var body: some View {
        Text(text)
            .font(Fonts.figtree(15, weight: .regular, relativeTo: .subheadline))
            .foregroundStyle(isEmpty ? Theme.ink : Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(Theme.page, in: .rect(cornerRadius: Theme.radius))
    }
}

/// text with tappable links: each part is plain or a link
nonisolated struct AccessLinkPart: Sendable, Hashable {
    var text: String
    var url: URL?

    static func plain(_ text: String) -> AccessLinkPart { AccessLinkPart(text: text, url: nil) }
    static func link(_ text: String, _ url: URL?) -> AccessLinkPart { AccessLinkPart(text: text, url: url) }
}

extension Text {
    /// one Text from plain and linked parts; links are teal and underlined
    init(accessParts parts: [AccessLinkPart]) {
        var string = AttributedString()
        for part in parts {
            var run = AttributedString(part.text)
            if let url = part.url {
                run.link = url
                run.foregroundColor = Theme.tealInk
                run.underlineStyle = .single
            }
            string += run
        }
        self.init(string)
    }
}

extension View {
    /// a filter panel (filters in the web css): grey inside a white card, white with a hairline on the grey page
    func accessFilterPanel(on fill: Color = Theme.page) -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: .rect(cornerRadius: Theme.radius))
            .overlay {
                if fill == Theme.surface {
                    RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
                }
            }
    }
}
