import SwiftUI

/// the web's design tokens (app/globals.css), light only
enum Theme {
    static let page = Color(hex: 0xF3F4F7)
    static let surface = Color(hex: 0xFFFFFF)
    static let ink = Color(hex: 0x1D2433)
    static let muted = Color(hex: 0x5E6677)
    static let hairline = Color(hex: 0xE3E6EC)
    static let teal = Color(hex: 0x0E7C86)
    static let tealInk = Color(hex: 0x0A6670)
    static let tealTint = Color(hex: 0xE6F3F4)
    static let selection = Color(hex: 0xCFE8EA)
    /// the disabled primary fill
    static let tealDisabled = Color(hex: 0x8FB9BD)
    /// a text field border
    static let fieldBorder = Color(hex: 0x8A92A0)

    static let warnInk = Color(hex: 0x8A4B00)
    static let warnTint = Color(hex: 0xFFF4E5)
    static let goodInk = Color(hex: 0x157F3D)
    static let goodTint = Color(hex: 0xE8F5EC)
    static let badInk = Color(hex: 0xA1260D)
    static let badTint = Color(hex: 0xFDECEA)

    static let radiusSmall: CGFloat = 10
    static let radius: CGFloat = 14
    static let radiusLarge: CGFloat = 20

    /// the side gutter of a screen column
    static let gutter: CGFloat = 20

    /// muted avatar tones, each 5.5:1 or more against white initials (ui.tsx)
    static let avatarTones: [Color] = [
        Color(hex: 0x46597F), Color(hex: 0x2F6B57), Color(hex: 0x8C4A5E),
        Color(hex: 0x7A5A1E), Color(hex: 0x5B5F6B), Color(hex: 0x5C6630),
    ]

    /// text and background for a status tone
    static func colors(for tone: StateTone) -> (ink: Color, tint: Color) {
        switch tone {
        case .good: (goodInk, goodTint)
        case .warn: (warnInk, warnTint)
        case .bad: (badInk, badTint)
        case .ask: (tealInk, tealTint)
        case .plain: (muted, page)
        }
    }
}

extension Color {
    /// 0xRRGGBB in srgb
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

extension View {
    /// the page background behind a whole screen
    func pageBackground() -> some View {
        background(Theme.page.ignoresSafeArea())
    }
}
