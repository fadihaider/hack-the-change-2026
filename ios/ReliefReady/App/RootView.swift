import SwiftUI

/// the shell: Start full screen until there is a care episode, then the four tabs
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let session = model.session {
                if session.episode == nil {
                    StartView()
                } else {
                    MainTabs()
                }
            } else if let error = model.sessionError {
                ConnectionProblemView(error: error)
            } else {
                LoadingView("Connecting to ReliefReady")
                    .pageBackground()
            }
        }
        .task { await model.refreshSession() }
    }
}

/// Urgent, Care, Recover and More; the selection lives on AppModel so features can switch tabs
struct MainTabs: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            Tab("Urgent", systemImage: "exclamationmark.bubble", value: AppTab.urgent) {
                NavigationStack { UrgentView() }
            }
            .accessibilityIdentifier("tab.urgent")
            Tab("Care", systemImage: "heart.text.square", value: AppTab.care) {
                NavigationStack { CareView() }
            }
            .accessibilityIdentifier("tab.care")
            Tab("Recover", systemImage: "arrow.uturn.backward.circle", value: AppTab.recover) {
                NavigationStack { RecoverView() }
            }
            .accessibilityIdentifier("tab.recover")
            Tab("More", systemImage: "ellipsis.circle", value: AppTab.more) {
                NavigationStack { MoreView() }
            }
            .accessibilityIdentifier("tab.more")
        }
        .tint(Theme.teal)
    }
}

/// the session could not load: say why, retry, or change the server address
struct ConnectionProblemView: View {
    @Environment(AppModel.self) private var model
    var error: APIError

    var body: some View {
        ScreenColumn {
            QuestionHeader("ReliefReady can\u{2019}t reach its server.", lead: "Nothing was loaded.")
            ErrorNote(error.userMessage, retryLabel: "Try again") {
                Task { await model.refreshSession() }
            }
            Text("Trying \(model.config.baseURL.absoluteString)")
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
            Card { ServerURLForm() }
        }
        .accessibilityIdentifier("connectionProblem")
    }
}
