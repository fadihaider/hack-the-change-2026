import SwiftUI

/// Settings and demo, from More: the server address, what's running (Labels.modes from the session), and the
/// demo clock (GET /api/clock, POST /api/clock/jump and /api/clock/reset, admin only). ports the demo/admin menu
/// in components/app/Shell.tsx, plus "Start a new care week", which opens Start on its welcome back
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var clock: DemoClock?
    @State private var showsStart = false

    init() {}

    var body: some View {
        ScreenColumn {
            QuestionHeader("Settings and demo", lead: "Which server, and what\u{2019}s running.")
            if let session = model.session {
                if let episode = session.episode {
                    careWeekCard(session: session, episode: episode)
                }
                if session.admin || DemoClock.isDemoRun(session.mode), let clock {
                    DemoCard(session: session, clock: clock)
                }
            }
            Card { ServerURLForm() }
        }
        .accessibilityIdentifier("screen.settings")
        .screenTitle("Settings")
        .onAppear(perform: makeClock)
        .task(id: model.session?.appNow) {
            guard model.session != nil else { return }
            makeClock()
            await clock?.refreshSimulated()
        }
        .sheet(isPresented: $showsStart) {
            NavigationStack {
                StartView(mode: .newWeek)
            }
            .presentationBackground(Theme.page)
        }
    }

    private func makeClock() {
        guard clock == nil else { return }
        let appModel = model
        clock = DemoClock(
            api: { appModel.api },
            reload: { await appModel.refreshSession() },
            announce: { text in AccessibilityNotification.Announcement(text).post() }
        )
    }

    private func careWeekCard(session: Session, episode: EpisodeSummary) -> some View {
        Card {
            Text("Care week")
                .font(.rrHeadline)
                .accessibilityAddTraits(.isHeader)
            Text("Caring for \(StartText.recipientName(session)), \(AlbertaTime.weekRange(episode.startsOn, episode.endsOn))")
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings.careWeek")
            Button("Start a new care week") { showsStart = true }
                .buttonStyle(.secondary)
                .accessibilityHint("Opens the start, where you can pick up this week or replace it")
                .accessibilityIdentifier("settings.newWeek")
        }
    }
}

/// the demo or admin controls: app time, what's running, the outbox and the clock
private struct DemoCard: View {
    var session: Session
    var clock: DemoClock

    var body: some View {
        let demo = DemoClock.isDemoRun(session.mode)
        let outbox = session.mode.mail == "outbox"
        Card {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(demo ? "Demo" : "Admin")
                    .font(.rrHeadline)
                    .accessibilityAddTraits(.isHeader)
                if clock.simulated == true {
                    TonePill("Simulated time", tone: .warn)
                        .accessibilityIdentifier("settings.simulated")
                }
            }
            let label = Text(clock.timeLabel).foregroundStyle(Theme.muted)
            let time = Text(AlbertaTime.format(session.appNow)).foregroundStyle(Theme.ink)
            Text("\(label) \(time)")
                .font(.rrBody)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings.appTime")

            let labels = Labels.modes(session.mode, providers: session.providers)
            if !labels.isEmpty {
                Divider().overlay(Theme.hairline).padding(.vertical, 2)
                Text("What\u{2019}s running")
                    .font(.rrLabel)
                    .foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(labels) { label in
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(label.name).foregroundStyle(Theme.muted)
                                Spacer(minLength: 12)
                                Text(label.value).multilineTextAlignment(.trailing)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(label.name).foregroundStyle(Theme.muted)
                                Text(label.value)
                            }
                        }
                        .font(.rrBody)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(label.name): \(label.value)")
                        .accessibilityIdentifier("settings.mode.\(label.key.rawValue)")
                    }
                }
            }

            if outbox || session.admin {
                Divider().overlay(Theme.hairline).padding(.vertical, 2)
                VStack(spacing: 4) {
                    if outbox {
                        NavigationLink {
                            OutboxView()
                        } label: {
                            MenuRow(title: "Open the outbox", systemImage: "tray", showsChevron: true)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Open the outbox")
                        .accessibilityIdentifier("settings.outbox")
                    }
                    if session.admin {
                        Button {
                            clock.clearStatus()
                            Task { await clock.jump() }
                        } label: {
                            MenuRow(
                                title: clock.busy == .jump ? "Moving time forward" : "Move time forward a day",
                                systemImage: "forward.fill", isBusy: clock.busy == .jump
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(clock.busy != nil)
                        .accessibilityIdentifier("settings.jump")
                        Button {
                            clock.clearStatus()
                            Task { await clock.reset() }
                        } label: {
                            MenuRow(
                                title: clock.busy == .reset ? "Resetting the clock" : "Reset the clock",
                                systemImage: "arrow.counterclockwise", isBusy: clock.busy == .reset
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(clock.busy != nil)
                        .accessibilityIdentifier("settings.resetClock")
                    }
                }
            }

            if !clock.status.isEmpty {
                Text(clock.status)
                    .font(.rrCallout)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Theme.page, in: .rect(cornerRadius: Theme.radiusSmall))
                    .accessibilityIdentifier("settings.status")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.demo")
    }
}

/// one row of the demo menu: an icon, the action in words, a spinner while it runs
private struct MenuRow: View {
    var title: String
    var systemImage: String
    var isBusy = false
    var showsChevron = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.teal)
                .frame(width: 32, height: 32)
                .background(Theme.tealTint, in: .rect(cornerRadius: 8))
                .accessibilityHidden(true)
            Text(title)
                .font(.rrBodyMedium)
                .foregroundStyle(isEnabled || isBusy ? Theme.ink : Theme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
            if isBusy {
                ProgressView().tint(Theme.teal)
            } else if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 44)
        .contentShape(.rect)
    }
}
