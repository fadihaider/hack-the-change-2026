import CoreText
import SwiftUI
import UIKit

/// Figtree (OFL, Resources/Fonts) with the system font as a fallback. every size scales with Dynamic Type
enum Fonts {
    static let fileName = "Figtree-Variable"

    /// true when the bundled font is usable; checked once
    static let isFigtreeAvailable: Bool = {
        // UIAppFonts registers the font at launch; this covers hosts that skip Info.plist, such as previews
        if UIFont(name: "Figtree-Regular", size: 12) == nil,
            let url = Bundle.main.url(forResource: fileName, withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        return UIFont(name: "Figtree-Regular", size: 12) != nil
    }()

    /// call once at launch so the first screen already knows which font to use
    static func registerIfNeeded() {
        _ = isFigtreeAvailable
    }

    /// the named instance of the variable font for a weight
    static func postScriptName(for weight: Font.Weight) -> String {
        switch weight {
        case .ultraLight, .thin, .light: "Figtree-Light"
        case .medium: "Figtree-Medium"
        case .semibold: "Figtree-SemiBold"
        case .bold: "Figtree-Bold"
        case .heavy: "Figtree-ExtraBold"
        case .black: "Figtree-Black"
        default: "Figtree-Regular"
        }
    }

    /// a Figtree size that scales relative to a text style
    static func figtree(_ size: CGFloat, weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        if isFigtreeAvailable {
            return .custom(postScriptName(for: weight), size: size, relativeTo: style)
        }
        return .system(style).weight(weight)
    }
}

extension Font {
    /// the big question, 34 pt semibold
    static var rrQuestion: Font { Fonts.figtree(34, weight: .semibold, relativeTo: .largeTitle) }
    /// a sheet or section title, 24 pt semibold
    static var rrTitle: Font { Fonts.figtree(24, weight: .semibold, relativeTo: .title2) }
    /// a card heading, 18 pt semibold
    static var rrHeadline: Font { Fonts.figtree(18, weight: .semibold, relativeTo: .headline) }
    /// body text, 16 pt
    static var rrBody: Font { Fonts.figtree(16, weight: .regular, relativeTo: .body) }
    /// body text with weight, 16 pt medium
    static var rrBodyMedium: Font { Fonts.figtree(16, weight: .medium, relativeTo: .body) }
    /// the primary button, 17 pt semibold
    static var rrButton: Font { Fonts.figtree(17, weight: .semibold, relativeTo: .body) }
    /// a secondary button, 16 pt semibold
    static var rrButtonSecondary: Font { Fonts.figtree(16, weight: .semibold, relativeTo: .body) }
    /// a field label, 15 pt semibold
    static var rrLabel: Font { Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline) }
    /// a receipt or error line, 15 pt medium
    static var rrCallout: Font { Fonts.figtree(15, weight: .medium, relativeTo: .callout) }
    /// muted notes and hints, 14 pt
    static var rrNote: Font { Fonts.figtree(14, weight: .regular, relativeTo: .footnote) }
    /// pills, 13 pt semibold
    static var rrPill: Font { Fonts.figtree(13, weight: .semibold, relativeTo: .caption) }
}
