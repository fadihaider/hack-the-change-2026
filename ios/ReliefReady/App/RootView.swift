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

/// Urgent, Care, Recover and More
struct MainTabs: View {
    enum TabID: Hashable {
        case urgent, care, recover, more
    }

    @State private var selection: TabID = MainTabs.launchTab

    /// debug builds honour -StartTab urgent|care|recover|more, for screenshots
    private static var launchTab: TabID {
        #if DEBUG
            switch UserDefaults.standard.string(forKey: "StartTab") {
            case "care": return .care
            case "recover": return .recover
            case "more": return .more
            default: return .urgent
            }
        #else
            return .urgent
        #endif
    }

    var body: some View {
        TabView(selection: $selection) {
            Tab("Urgent", systemImage: "exclamationmark.bubble", value: TabID.urgent) {
                NavigationStack { UrgentView() }
            }
            .accessibilityIdentifier("tab.urgent")
            Tab("Care", systemImage: "heart.text.square", value: TabID.care) {
                NavigationStack { CareView() }
            }
            .accessibilityIdentifier("tab.care")
            Tab("Recover", systemImage: "arrow.uturn.backward.circle", value: TabID.recover) {
                NavigationStack { RecoverView() }
            }
            .accessibilityIdentifier("tab.recover")
            Tab("More", systemImage: "ellipsis.circle", value: TabID.more) {
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
