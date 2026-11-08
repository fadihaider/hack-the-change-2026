import SwiftUI
import UIKit

/// Start: the welcome and the intake ("what's happening with your family?"), shown full screen while the session has
/// no care episode. owns POST /api/intake, the clarifying questions, and calling AppModel.refreshSession() once an
/// episode exists so RootView moves on to the tabs, on Urgent (the web's /urgent?from=intake). Settings presents it as
/// .newWeek, which opens on the welcome back to the current week and, once a new week is saved or the user continues
/// with this one, closes itself and switches to Urgent.
struct StartView: View {
    enum Mode {
        /// RootView's full-screen start, with no care week on file
        case root
        /// presented from Settings: the welcome back first, then the intake for a week that replaces this one
        case newWeek
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let mode: Mode
    @State private var flow: StartFlow?

    init() {
        self.mode = .root
    }

    init(mode: Mode) {
        self.mode = mode
    }

    var body: some View {
        Group {
            if let flow {
                StartContent(flow: flow, session: model.session, mode: mode, onContinue: openUrgent)
            } else {
                LoadingView("Loading your week").pageBackground().accessibilityIdentifier("screen.start")
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: flow?.screen)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: flow.map { StageKey($0.stage) })
        .interactiveDismissDisabled(flow?.isBusy ?? false)
        .toolbar {
            if mode == .newWeek {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: close)
                        .disabled(flow?.isBusy ?? false)
                        .accessibilityLabel("Close and keep this week")
                        .accessibilityIdentifier("start.close")
                }
            }
        }
        .onAppear(perform: makeFlow)
        .onChange(of: flow?.isFinished ?? false) { _, finished in
            if finished { openUrgent() }
        }
    }

    private func makeFlow() {
        guard flow == nil else { return }
        let api = model.api
        let appModel = model
        let mode = mode
        flow = StartFlow(
            current: mode == .newWeek ? model.session?.episode : nil,
            startAtWelcome: mode == .newWeek,
            intake: { statement throws(APIError) in try await api.intake(statement: statement) },
            reload: {
                await appModel.refreshSession()
                // full screen, the refreshed session swaps RootView to the tabs at once, so pick Urgent now
                if mode == .root, appModel.sessionError == nil { appModel.showUrgent(fromStart: true) }
                return appModel.sessionError
            },
            announce: { text in AccessibilityNotification.Announcement(text).post() }
        )
    }

    /// "Close": the sheet goes away and this week stays as it is
    private func close() {
        if mode == .newWeek { dismiss() }
    }

    /// a new week saved, or "Continue with this week": presented, the sheet closes onto Urgent. in root mode the
    /// reload already switched RootView to the tabs on Urgent
    private func openUrgent() {
        guard mode == .newWeek else { return }
        dismiss()
        model.showUrgent(fromStart: true)
    }
}

/// a stage without its payload, so a change of stage animates but typing does not
private struct StageKey: Hashable {
    var name: String
    var round: Int

    init(_ stage: StartFlow.Stage) {
        switch stage {
        case .write: name = "write"; round = 0
        case .clarify(let clarify): name = "clarify"; round = clarify.round
        case .confirm: name = "confirm"; round = 0
        }
    }
}

private struct StartContent: View {
    @Bindable var flow: StartFlow
    var session: Session?
    var mode: StartView.Mode
    var onContinue: () -> Void

    var body: some View {
        ScreenColumn {
            Group {
                if flow.screen == .welcome, let episode = flow.replacing {
                    WelcomeStage(flow: flow, session: session, episode: episode, onContinue: onContinue)
                        .id("welcome")
                } else {
                    switch flow.stage {
                    case .write:
                        WriteStage(flow: flow).id("write")
                    case .clarify(let clarify):
                        ClarifyStage(flow: flow, clarify: clarify).id("clarify-\(clarify.round)")
                    case .confirm(let ready):
                        ConfirmStage(flow: flow, ready: ready).id("confirm")
                    }
                }
            }
            .transition(.asymmetric(
                insertion: .move(edge: flow.movingForward ? .trailing : .leading).combined(with: .opacity),
                removal: .opacity
            ))
        }
        .accessibilityIdentifier("screen.start")
        .screenTitle(mode == .newWeek ? "Start" : "ReliefReady")
    }
}

// MARK: - welcome

private struct WelcomeStage: View {
    var flow: StartFlow
    var session: Session?
    var episode: EpisodeSummary
    var onContinue: () -> Void
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        let name = AppModel.recipientName(session)
        let today = session?.today ?? AlbertaTime.dateString(of: .now)
        VStack(alignment: .leading, spacing: 16) {
            MetaLines(lines: [(
                id: "when", systemImage: "calendar",
                text: "\(AlbertaTime.dayLabel(episode.startsOn)) to \(AlbertaTime.dayLabel(episode.endsOn))"
            )], label: "This care week")
            QuestionHeader("Pick up where you left off?", lead: StartText.welcomeLead(name: name, today: today, episode: episode))
                .accessibilityFocused($headingFocused)
            ButtonStack {
                Button("Continue with this week", action: onContinue)
                    .buttonStyle(.primary)
                    .accessibilityIdentifier("start.continue")
                Button("Start a new care week") { flow.startNewWeek() }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("start.newWeek")
                NoteText("A new week replaces this one once you check it.")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("start.welcome")
        .onAppear { if flow.moved { headingFocused = true } }
    }
}

// MARK: - the first question

private struct WriteStage: View {
    @Bindable var flow: StartFlow
    @FocusState private var fieldFocused: Bool
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuestionHeader("What\u{2019}s happening with your family?", lead: "Your week just changed.")
                .accessibilityFocused($headingFocused)
            VStack(alignment: .leading, spacing: 16) {
                StartTextArea(
                    label: "In your own words",
                    hint: "Who you\u{2019}re caring for, why, and from when until when.",
                    size: .large,
                    minLines: 4,
                    text: Binding(get: { flow.statement }, set: { flow.update(statement: $0) }),
                    isReadOnly: flow.isBusy,
                    focus: $fieldFocused,
                    identifier: "start.statementField"
                )
                if let count = flow.countText {
                    Text(count)
                        .font(Fonts.figtree(13, relativeTo: .caption).monospacedDigit())
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.top, -8)
                        .accessibilityIdentifier("start.count")
                }
                if flow.showsExample {
                    ExampleButton(text: StartFlow.exampleStatement) {
                        flow.fillExample()
                        fieldFocused = true
                    }
                    .padding(.top, -4)
                }
                if let error = flow.error {
                    ErrorNote(error).accessibilityIdentifier("start.error")
                }
                ButtonStack {
                    Button(flow.isBusy ? flow.busyLabel : "Check my week") { check() }
                        .buttonStyle(.primary(busy: flow.isBusy))
                        .allowsHitTesting(!flow.isBusy)
                        .accessibilityIdentifier("start.check")
                    NoteText(flow.writeNote).accessibilityIdentifier("start.note")
                    if flow.canGoBack {
                        Button("Back to this week") { flow.backToWelcome() }
                            .buttonStyle(.quiet)
                            .disabled(flow.isBusy)
                            .accessibilityIdentifier("start.backToWeek")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("start.write")
        .onAppear { if flow.moved { headingFocused = true } }
    }

    private func check() {
        fieldFocused = false
        Task {
            await flow.submit()
            if flow.error != nil, flow.stage == .write, flow.showsExample { fieldFocused = true }
        }
    }
}

// MARK: - a clarifying question

private struct ClarifyStage: View {
    @Bindable var flow: StartFlow
    var clarify: StartFlow.Clarify
    @FocusState private var fieldFocused: Bool
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        let lines = StartText.understood(clarify.partial)
        let first = clarify.questions.first ?? StartFlow.fallbackQuestion
        let rest = Array(clarify.questions.dropFirst())
        VStack(alignment: .leading, spacing: 0) {
            if !lines.isEmpty {
                MetaLines(
                    lines: lines.map { (id: $0.kind.rawValue, systemImage: $0.systemImage, text: $0.text) },
                    label: "What you wrote so far"
                )
                .padding(.bottom, 16)
                .accessibilityIdentifier("start.understood")
            }
            QuestionHeader(first, lead: clarify.questions.count == 1 ? "One more detail." : "A couple more details.")
                .accessibilityFocused($headingFocused)
                .accessibilityIdentifier("start.question")
            if !rest.isEmpty {
                BulletList(items: rest, font: Fonts.figtree(18, relativeTo: .body))
                    .padding(.top, -12)
                    .padding(.bottom, 24)
                    .accessibilityIdentifier("start.moreQuestions")
            }
            VStack(alignment: .leading, spacing: 16) {
                StartTextArea(
                    label: "Your answer",
                    hint: "It\u{2019}s added to what you already wrote.",
                    minLines: 3,
                    text: Binding(get: { flow.answer }, set: { flow.update(answer: $0) }),
                    isReadOnly: flow.isBusy,
                    focus: $fieldFocused,
                    identifier: "start.answerField"
                )
                if let error = flow.error {
                    ErrorNote(error).accessibilityIdentifier("start.error")
                }
                ButtonStack {
                    Button(flow.isBusy ? flow.busyLabel : "Check my week") {
                        fieldFocused = false
                        Task {
                            await flow.submit()
                            if flow.error != nil, flow.answer.isEmpty { fieldFocused = true }
                        }
                    }
                    .buttonStyle(.primary(busy: flow.isBusy))
                    .allowsHitTesting(!flow.isBusy)
                    .accessibilityIdentifier("start.check")
                    if let note = flow.clarifyNote {
                        NoteText(note)
                    }
                    Button("Edit what I wrote") { flow.editStatement() }
                        .buttonStyle(.quiet)
                        .disabled(flow.isBusy)
                        .accessibilityIdentifier("start.editStatement")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("start.clarify")
        .onAppear { if flow.moved { headingFocused = true } }
    }
}

// MARK: - saved, with things worth thinking about

private struct ConfirmStage: View {
    var flow: StartFlow
    var ready: IntakeReady
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Receipt(StartText.savedReceipt(ready))
                .padding(.bottom, 24)
                .accessibilityIdentifier("start.receipt")
            QuestionHeader("Next, see what it affects.", lead: "Your week is set.")
                .accessibilityFocused($headingFocused)
            VStack(alignment: .leading, spacing: 6) {
                Text("Worth thinking about")
                    .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
                    .foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                BulletList(items: ready.clarifyingQuestions ?? [])
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
            .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
            .padding(.top, -8)
            .padding(.bottom, 28)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("start.worth")
            if let error = flow.error {
                ErrorNote(error).padding(.bottom, 16).accessibilityIdentifier("start.error")
            }
            ButtonStack {
                Button(flow.isBusy ? flow.busyLabel : "See what it affects") {
                    Task { await flow.openWeek() }
                }
                .buttonStyle(.primary(busy: flow.isBusy))
                .allowsHitTesting(!flow.isBusy)
                .accessibilityIdentifier("start.seeAffects")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("start.confirm")
        .onAppear { if flow.moved { headingFocused = true } }
    }
}
