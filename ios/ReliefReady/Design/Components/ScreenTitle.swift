import SwiftUI

extension View {
    /// names the screen for the back button and voiceover without showing it in the bar, because the QuestionHeader
    /// already says it in big type. a tab's first screen hides its empty bar so the header starts at the top; a
    /// pushed or presented screen keeps the bar for its back or close button
    func screenTitle(_ title: String) -> some View {
        modifier(ScreenTitle(title: title))
    }
}

private struct ScreenTitle: ViewModifier {
    var title: String
    /// true for a screen pushed onto a stack or shown in a sheet, false for a tab's root screen
    @Environment(\.isPresented) private var isPresented

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .toolbarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Color.clear
                        .frame(width: 1, height: 1)
                        .accessibilityHidden(true)
                }
                .sharedBackgroundVisibility(.hidden)
            }
            .toolbar(isPresented ? .automatic : .hidden, for: .navigationBar)
            // every screen, pushed ones too: the bar itself has no background, so without the band scrolled text runs
            // under the clock and behind the floating back button
            .overlay(alignment: .top) { StatusBarFade() }
    }
}

/// the page colour behind the status bar, and behind the bar on a pushed screen (the top safe area covers both),
/// fading out just below it, so scrolled text stays clear of the clock and the back button
private struct StatusBarFade: View {
    var body: some View {
        LinearGradient(colors: [Theme.page, Theme.page.opacity(0)], startPoint: .top, endPoint: .bottom)
            .frame(height: 14)
            .background(alignment: .top) {
                // a zero-height strip at the top of the safe area grows up over the status bar
                Theme.page.ignoresSafeArea(edges: .top).frame(height: 0)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
