import SwiftUI

// small shared pieces of the care screens (care.module.css, passport.module.css)

extension Font {
    /// a care section title, 22 pt semibold
    static var careSection: Font { Fonts.figtree(22, weight: .semibold, relativeTo: .title3) }
    /// the care page title, 32 pt semibold
    static var careTitle: Font { Fonts.figtree(32, weight: .semibold, relativeTo: .largeTitle) }
    /// a quoted fact, 17 pt medium
    static var careQuote: Font { Fonts.figtree(17, weight: .medium, relativeTo: .body) }
}

/// a section of the overview: a hairline above, a title and a muted hint
struct CareSection<Content: View>: View {
    var title: String
    var hint: String?
    var identifier: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Theme.hairline).frame(height: 1).padding(.bottom, 24)
            Text(title)
                .font(.careSection)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let hint {
                Text(hint)
                    .font(Fonts.figtree(15, relativeTo: .subheadline))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 4)
            }
            VStack(alignment: .leading, spacing: 12) { content }
                .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// an icon and a muted line, for where a fact came from or when it happens
struct CareMetaLine: View {
    var systemImage: String
    var text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.rrNote)
        .foregroundStyle(Theme.muted)
    }
}

/// a fact word for word, with a teal rule on the left
struct CareQuote: View {
    var text: String
    var footer: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(Fonts.figtree(17, relativeTo: .body))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let footer {
                Text(footer).font(.rrNote).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .careBox(Theme.radiusSmall)
        .overlay(alignment: .leading) {
            Rectangle().fill(Theme.teal).frame(width: 3)
        }
        .clipShape(.rect(cornerRadius: Theme.radiusSmall))
    }
}

extension View {
    /// a white box with a hairline, for content sitting on the page background
    func careBox(_ radius: CGFloat = Theme.radius) -> some View {
        background(Theme.surface, in: .rect(cornerRadius: radius))
            .overlay { RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.hairline, lineWidth: 1) }
    }
}

/// a muted box for an empty list
struct CareEmptyBox: View {
    var text: String

    var body: some View {
        Text(text)
            .font(Fonts.figtree(15, relativeTo: .subheadline))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .careBox(Theme.radius)
    }
}

/// a compact teal text button for row actions (View source, Edit)
struct CareSmallButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
            .foregroundStyle(isEnabled ? Theme.tealInk : Theme.muted)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(configuration.isPressed ? Theme.selection : Theme.tealTint, in: .rect(cornerRadius: Theme.radiusSmall))
            .contentShape(.rect(cornerRadius: Theme.radiusSmall))
    }
}

extension ButtonStyle where Self == CareSmallButtonStyle {
    static var careSmall: CareSmallButtonStyle { CareSmallButtonStyle() }
}

/// a multi-line text field with a label and hint above it (TextArea in ui.tsx)
struct CareTextArea: View {
    var label: String
    var hint: String?
    @Binding var text: String
    var minLines = 4
    var maxLength: Int
    var isDisabled = false
    var identifier: String
    var focus: FocusState<Bool>.Binding?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.rrLabel).foregroundStyle(Theme.ink)
            if let hint {
                Text(hint).font(.rrNote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            field
                .font(.rrBody)
                .lineLimit(minLines...14)
                .padding(12)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.fieldBorder, lineWidth: 1)
                }
                .disabled(isDisabled)
                .onChange(of: text) { _, value in
                    if value.count > maxLength { text = String(value.prefix(maxLength)) }
                }
                .accessibilityLabel(label)
                .accessibilityHint(hint ?? "")
                .accessibilityIdentifier(identifier)
        }
    }

    @ViewBuilder private var field: some View {
        if let focus {
            TextField("", text: $text, axis: .vertical).focused(focus)
        } else {
            TextField("", text: $text, axis: .vertical)
        }
    }
}

/// a one-line labelled text field (the contact form)
struct CareTextField: View {
    var label: String
    var optional = false
    var hint: String?
    @Binding var text: String
    var error: String?
    var maxLength: Int
    var keyboard: UIKeyboardType = .default
    var contentType: UITextContentType?
    var identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text(label).font(.rrLabel).foregroundStyle(Theme.ink)
                if optional { Text("(optional)").font(.rrNote).foregroundStyle(Theme.muted) }
            }
            if let hint { Text(hint).font(.rrNote).foregroundStyle(Theme.muted) }
            TextField("", text: $text)
                .font(.rrBody)
                .keyboardType(keyboard)
                .textContentType(contentType)
                .autocorrectionDisabled()
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius)
                        .strokeBorder(error == nil ? Theme.fieldBorder : Theme.badInk, lineWidth: error == nil ? 1 : 2)
                }
                .onChange(of: text) { _, value in
                    if value.count > maxLength { text = String(value.prefix(maxLength)) }
                }
                .accessibilityLabel(optional ? "\(label), optional" : label)
                .accessibilityHint([hint, error].compactMap { $0 }.joined(separator: ". "))
                .accessibilityIdentifier(identifier)
            if let error {
                Text(error).font(.rrNote.weight(.semibold)).foregroundStyle(Theme.badInk)
            }
        }
    }
}

/// a chevron that turns when its section opens
struct CareChevron: View {
    var isOpen: Bool

    var body: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 15, weight: .semibold))
            .rotationEffect(.degrees(isOpen ? 180 : 0))
            .animation(.easeOut(duration: 0.15), value: isOpen)
            .accessibilityHidden(true)
    }
}

/// posts a VoiceOver announcement (useAnnounce in ui.tsx)
@MainActor
func careAnnounce(_ text: String) {
    AccessibilityNotification.Announcement(text).post()
}
