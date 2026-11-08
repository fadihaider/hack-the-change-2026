import SwiftUI

/// a white surface with a hairline border and 14 pt corners
struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1)
            }
    }
}

/// a muted note under a question or a set of buttons
struct NoteText: View {
    var text: String
    var alignment: TextAlignment = .center

    init(_ text: String, alignment: TextAlignment = .center) {
        self.text = text
        self.alignment = alignment
    }

    var body: some View {
        Text(text)
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .multilineTextAlignment(alignment)
            .frame(maxWidth: .infinity, alignment: alignment == .center ? .center : .leading)
    }
}

/// the scrolling column a screen sits in: page background, 20 pt gutters, content at most 560 pt wide
struct ScreenColumn<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content }
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Theme.gutter)
                .padding(.top, 12)
                .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .pageBackground()
    }
}

#Preview {
    ScreenColumn {
        Card {
            Text("ENGG 513 group project meeting").font(.rrHeadline)
            Text("Mon, Nov 9, 10:00 a.m.").font(.rrNote).foregroundStyle(Theme.muted)
        }
        NoteText("Nothing is sent until you approve it.")
    }
}
