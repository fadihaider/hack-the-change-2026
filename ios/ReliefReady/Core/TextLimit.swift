import Foundation

/// the web's maxLength on a text field: longer input is cut to the limit as it is typed or pasted
nonisolated enum TextLimit {
    static func cut(_ text: String, max: Int) -> String {
        text.count > max ? String(text.prefix(max)) : text
    }

    /// writes text cut to max characters. an over-long paste is written whole first, so the stored value changes
    /// and the field redraws with the cut text even when the cut text equals what was there before
    static func assign(_ text: String, max: Int, _ write: (String) -> Void) {
        if text.count > max { write(text) }
        write(cut(text, max: max))
    }
}
