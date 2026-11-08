import SwiftUI

/// Settings and demo, from More: the server address, what's running (Labels.modes from the session), and the
/// demo clock (GET /api/clock, POST /api/clock/jump and /api/clock/reset, admin only).
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    init() {}

    var body: some View {
        ScreenColumn {
            QuestionHeader("Settings and demo", lead: "Which server, and what\u{2019}s running.")
            Card { ServerURLForm() }
            if let session = model.session {
                Card {
                    Text("What\u{2019}s running")
                        .font(.rrHeadline)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Labels.modes(session.mode, providers: session.providers)) { label in
                        HStack {
                            Text(label.name).foregroundStyle(Theme.muted)
                            Spacer()
                            Text(label.value).multilineTextAlignment(.trailing)
                        }
                        .font(.rrBody)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle("Settings")
        .toolbarTitleDisplayMode(.inline)
        .accessibilityIdentifier("screen.settings")
    }
}
