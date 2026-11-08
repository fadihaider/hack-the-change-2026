import SwiftUI

extension View {
    /// names the screen for the back button and voiceover, but leaves the bar's title empty because the
    /// QuestionHeader already says it in big type
    func screenTitle(_ title: String) -> some View {
        navigationTitle(title)
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityHidden(true)
                }
                .sharedBackgroundVisibility(.hidden)
            }
    }
}
