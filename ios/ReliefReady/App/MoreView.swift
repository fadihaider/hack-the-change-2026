import SwiftUI

/// the More tab: links to the care access map, the demo outbox, and settings and demo controls
struct MoreView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                NavigationLink {
                    CareAccessView()
                } label: {
                    row("Care access map", detail: "Places in reach of each Calgary community", systemImage: "map")
                }
                .accessibilityIdentifier("more.careAccess")
                NavigationLink {
                    OutboxView()
                } label: {
                    row("Outbox", detail: "Messages the demo stored instead of sending", systemImage: "tray")
                }
                .accessibilityIdentifier("more.outbox")
                NavigationLink {
                    SettingsView()
                } label: {
                    row("Settings and demo", detail: "Server address, what\u{2019}s running, demo clock", systemImage: "gearshape")
                }
                .accessibilityIdentifier("more.settings")
            }
            .listRowBackground(Theme.surface)
        }
        .scrollContentBackground(.hidden)
        .pageBackground()
        .navigationTitle("More")
    }

    private func row(_ title: String, detail: String, systemImage: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Theme.teal)
                .frame(width: 36, height: 36)
                .background(Theme.tealTint, in: .rect(cornerRadius: Theme.radiusSmall))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                Text(detail).font(.rrNote).foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(detail)")
    }
}
