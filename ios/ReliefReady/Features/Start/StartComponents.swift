import SwiftUI

/// a labelled multi-line field with a hint (TextArea in ui.tsx); grows with its text and with Dynamic Type
struct StartTextArea: View {
    enum Size {
        case regular, large
    }

    var label: String
    var hint: String?
    var size: Size = .regular
    var minLines: Int
    @Binding var text: String
    var isReadOnly: Bool
    var focus: FocusState<Bool>.Binding
    var identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.rrLabel)
                .foregroundStyle(Theme.ink)
                .accessibilityHidden(true)
            if let hint {
                Text(hint)
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
            TextField("", text: $text, axis: .vertical)
                .font(size == .large ? Fonts.figtree(18, relativeTo: .body) : .rrBody)
                .foregroundStyle(isReadOnly ? Theme.muted : Theme.ink)
                .lineLimit(minLines...14)
                .lineSpacing(3)
                .focused(focus)
                .disabled(isReadOnly)
                .padding(.horizontal, size == .large ? 18 : 14)
                .padding(.vertical, size == .large ? 16 : 12)
                .background(isReadOnly ? Theme.page : Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius)
                        .strokeBorder(focus.wrappedValue ? Theme.teal : Theme.fieldBorder, lineWidth: 1)
                }
                .background {
                    if focus.wrappedValue {
                        RoundedRectangle(cornerRadius: Theme.radius + 3)
                            .stroke(Theme.tealTint, lineWidth: 6)
                    }
                }
                .contentShape(.rect)
                .simultaneousGesture(TapGesture().onEnded { focus.wrappedValue = true })
                .accessibilityLabel(label)
                .accessibilityHint(hint ?? "")
                .accessibilityIdentifier(identifier)
                .toolbar {
                    if focus.wrappedValue {
                        ToolbarItemGroup(placement: .keyboard) {
                            Spacer()
                            Button("Done") { focus.wrappedValue = false }
                                .font(.rrBodyMedium)
                                .accessibilityLabel("Done typing")
                                .accessibilityIdentifier("start.keyboardDone")
                        }
                    }
                }
        }
    }
}

/// the tap-to-fill example: a quoted sentence that reads like something Alex might say
struct ExampleButton: View {
    var text: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Tap to use an example")
                    .font(Fonts.figtree(13, weight: .semibold, relativeTo: .caption))
                    .foregroundStyle(Theme.tealInk)
                Text("\u{201C}\(text)\u{201D}")
                    .font(.rrBody)
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Theme.tealTint, in: .rect(cornerRadius: Theme.radius))
            .contentShape(.rect(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Use an example: \(text)")
        .accessibilityHint("Fills in the field. You can change it before checking your week.")
        .accessibilityIdentifier("start.example")
    }
}

/// the muted lines with an icon above a question
struct MetaLines: View {
    var lines: [(id: String, systemImage: String, text: String)]
    var label: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(lines, id: \.id) { line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: line.systemImage)
                        .font(Fonts.figtree(14, weight: .medium, relativeTo: .callout))
                        .frame(minWidth: 16)
                        .accessibilityHidden(true)
                    Text(line.text)
                        .font(Fonts.figtree(15, relativeTo: .callout))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let joined = lines.map(\.text).joined(separator: ". ")
        guard let label else { return joined }
        return "\(label): \(joined)"
    }
}

/// a plain bulleted list
struct BulletList: View {
    var items: [String]
    var font: Font = .rrBody

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\u{2022}").accessibilityHidden(true)
                    Text(item).fixedSize(horizontal: false, vertical: true)
                }
                .font(font)
                .foregroundStyle(Theme.ink)
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
