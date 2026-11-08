import SwiftUI

/// the server address field, shared by the connection error screen and Settings
struct ServerURLForm: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var isSaving = false
    @State private var invalid = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Server address")
                .font(.rrLabel)
                .foregroundStyle(Theme.ink)
            TextField("http://192.168.1.157:3107", text: $text)
                .font(.rrBody)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(save)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.fieldBorder, lineWidth: 1)
                }
                .accessibilityLabel("Server address")
                .accessibilityHint("The http address of the ReliefReady server, with its port")
                .accessibilityIdentifier("serverURLField")
            if invalid {
                Text("Use an http or https address, for example http://192.168.1.157:3107.")
                    .font(.rrNote)
                    .foregroundStyle(Theme.badInk)
            } else if model.config.isOverridden {
                NoteText("A launch argument sets this address for now.", alignment: .leading)
            }
            ButtonStack {
                Button("Connect", action: save)
                    .buttonStyle(.primary(busy: isSaving))
                    .disabled(isSaving || text.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel("Connect to this server")
                Button("Use the default address") {
                    Task {
                        isSaving = true
                        await model.resetServer()
                        text = model.config.baseURL.absoluteString
                        isSaving = false
                    }
                }
                .buttonStyle(.quiet)
                .disabled(isSaving)
            }
        }
        .onAppear { text = model.config.baseURL.absoluteString }
    }

    private func save() {
        guard !isSaving else { return }
        Task {
            isSaving = true
            invalid = !(await model.changeServer(to: text))
            if !invalid { text = model.config.baseURL.absoluteString }
            isSaving = false
        }
    }
}
