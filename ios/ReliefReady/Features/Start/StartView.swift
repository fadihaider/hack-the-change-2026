import SwiftUI

/// Start: the welcome and the intake ("what's going on?"), shown full screen while the session has no care
/// episode. owns POST /api/intake, the clarifying questions, and calling AppModel.refreshSession() once an
/// episode exists so RootView moves on to the tabs.
struct StartView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        FeaturePlaceholder(
            "What\u{2019}s going on?",
            lead: "Welcome to ReliefReady.",
            detail: "The intake will be here: tell ReliefReady who needs care and for how long. Signed in as \(model.session?.user.email ?? "the demo user")."
        )
        .accessibilityIdentifier("screen.start")
    }
}
