import SwiftUI

/// initials in a circle; decorative, so always put the name in text next to it (Avatar in ui.tsx)
struct InitialsAvatar: View {
    enum Size {
        case small, medium

        var side: CGFloat { self == .small ? 30 : 40 }
        var fontSize: CGFloat { self == .small ? 13 : 15 }
    }

    var name: String
    var size: Size = .medium

    var body: some View {
        Text(Labels.initials(name))
            .font(Fonts.figtree(size.fontSize, weight: .semibold, relativeTo: .caption))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .foregroundStyle(.white)
            .frame(width: size.side, height: size.side)
            .background(Theme.avatarTones[Labels.avatarToneIndex(name, count: Theme.avatarTones.count)], in: .circle)
            .accessibilityHidden(true)
            // the circle has a fixed size and the name sits in text beside it, so the initials stop growing here
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}

#Preview {
    HStack {
        InitialsAvatar(name: "Jordan Lee")
        InitialsAvatar(name: "Dr. Sam Patel", size: .small)
        InitialsAvatar(name: "Lucia")
    }
}
