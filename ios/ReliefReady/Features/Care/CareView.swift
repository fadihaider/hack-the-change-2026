import SwiftUI

/// Care tab: the care passport (/api/care/facts with PassportSection groups), adding notes, voice notes
/// (/api/stt) and pdfs (/api/care/sources), approving, editing, rejecting and resolving facts, the day's
/// timeline (/api/care/timeline, /api/care/events/*/complete), Ask (/api/care/ask) and care contacts.
/// embeds NearbySection.
struct CareView: View {
    @Environment(AppModel.self) private var model
    @State private var care: CareModel?

    init() {}

    var body: some View {
        Group {
            if let care {
                CareScreen(care: care)
            } else {
                LoadingView("Loading the care details").pageBackground()
            }
        }
        .screenTitle("Care")
        .accessibilityIdentifier("screen.care")
        .onAppear {
            if care == nil { care = CareModel(api: model.api) }
        }
        .onChange(of: model.api.baseURL) { _, _ in
            care?.api = model.api
            Task { await care?.loadProfile() }
        }
    }
}

/// what the tab shows for each state of the session and profile (CareScreen.tsx)
private struct CareScreen: View {
    @Environment(AppModel.self) private var app
    @Bindable var care: CareModel
    @State private var sourceRequest: SourceRequest?

    var body: some View {
        let name = app.careRecipientName
        content(name: name)
            .navigationDestination(isPresented: $care.isFlowPresented) {
                CareFlowView(care: care, name: name)
            }
            .task(id: app.session?.episode?.id) {
                if app.session?.episode != nil { await care.loadProfile() }
            }
    }

    @ViewBuilder private func content(name: String) -> some View {
        // 911 and 811 never wait on data: the loading and error states keep emergency help on screen
        if let session = app.session {
            if let episode = session.episode {
                if let profile = care.profile {
                    CareHome(
                        care: care, name: name, session: session, episode: episode, profile: profile,
                        sourceRequest: $sourceRequest
                    )
                    .sheet(item: $sourceRequest) { request in
                        SourceSheet(request: request) { sourceRequest = nil }
                    }
                } else if let error = care.profileError {
                    ScreenColumn {
                        QuestionHeader("\(CareData.possessive(name)) care details didn\u{2019}t load.")
                        ErrorNote(error) { Task { await care.loadProfile() } }
                        EmergencyHelpInline(name: name)
                    }
                } else {
                    ScreenColumn {
                        Text("Loading \(CareData.possessive(name)) care details")
                            .font(.rrBody)
                            .foregroundStyle(Theme.muted)
                            .padding(.vertical, 24)
                        EmergencyHelpInline(name: name)
                    }
                }
            } else {
                ScreenColumn {
                    QuestionHeader(
                        "Start with what\u{2019}s happening, then come back here.", lead: "There\u{2019}s no care week yet."
                    )
                }
            }
        } else {
            ScreenColumn {
                QuestionHeader("The care details didn\u{2019}t load.")
                ErrorNote(app.sessionError?.userMessage ?? "ReliefReady couldn\u{2019}t reach its server.") {
                    Task { await app.refreshSession() }
                }
                EmergencyHelpInline(name: name)
            }
        }
    }
}

/// the pushed sub-flow: add, voice or review, switching in place like the web's ?step=
private struct CareFlowView: View {
    @Environment(AppModel.self) private var app
    var care: CareModel
    var name: String

    var body: some View {
        // one question at a time: the tab bar steps aside until the caregiver is back on the overview
        step.toolbar(.hidden, for: .tabBar)
    }

    @ViewBuilder private var step: some View {
        switch care.flow {
        case .add:
            AddNoteView(care: care, name: name, onVoice: { care.go(.voice) })
        case .voice:
            VoiceNoteView(
                care: care, name: name, speech: app.session?.providers.speech ?? .off,
                onTypeInstead: { care.go(.add) }, onClose: { care.goHome() }
            )
        case .review(let session):
            ReviewHost(session: session, name: name, care: care)
                .id(session.id)
        }
    }
}

private struct ReviewHost: View {
    var session: ReviewSession
    var name: String
    var care: CareModel
    @State private var model: ReviewModel?

    var body: some View {
        Group {
            if let model {
                ReviewStepsView(model: model)
            } else {
                Color.clear.pageBackground()
            }
        }
        .onAppear {
            if model == nil { model = ReviewModel(session: session, name: name, care: care) }
        }
    }
}

// MARK: - the overview

private struct CareHome: View {
    var care: CareModel
    var name: String
    var session: Session
    var episode: EpisodeSummary
    var profile: CareProfile
    @Binding var sourceRequest: SourceRequest?
    @State private var expanded: Set<PassportSectionID> = []

    private var openVoice: () -> Void { { care.openVoice() } }
    private var openAdd: () -> Void { { care.openAdd() } }

    private var pending: [ReviewStep] { CareData.pendingSteps(profile.facts) }

    /// nothing written down yet: one calm way in, no passport or ask over an empty profile
    private var isEmpty: Bool {
        profile.facts.allSatisfy { $0.status != .approved } && pending.isEmpty && profile.openQuestions.isEmpty
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScreenColumn {
                top
                middle(proxy: proxy)
                bottom
            }
            .refreshable { await care.loadProfile() }
        }
    }

    @ViewBuilder private var top: some View {
        CareHeader(
            name: name, session: session, episode: episode, quickAdd: !isEmpty,
            onVoice: openVoice, onNote: openAdd
        )
        if let receipt = care.receipt {
            Receipt(receipt).accessibilityIdentifier("care.receipt")
        }
        if isEmpty {
            CareSection(
                title: "Nothing is written down yet",
                hint: "Routines, who to call, where things are kept. Each thing comes back to you to check before anyone helping \(name) sees it.",
                identifier: "care.empty"
            ) {
                TellAboutView(name: name, onVoice: openVoice, onNote: openAdd)
            }
        }
        TodayCareView(
            name: name, session: session, episode: episode, version: care.version,
            onVoice: isEmpty ? nil : openVoice, onNote: isEmpty ? nil : openAdd
        )
    }

    @ViewBuilder private func middle(proxy: ScrollViewProxy) -> some View {
        if !isEmpty {
            AskAboutView(
                name: name, facts: profile.facts, openQuestions: profile.openQuestions, onAdd: openAdd,
                onChanged: { await care.loadProfile() },
                onSource: { sourceRequest = $0 },
                onReveal: { reveal($0, proxy: proxy) }
            )
        }
        let pending = pending
        if !pending.isEmpty {
            PendingReviewSection(name: name, count: pending.count) { care.openReview(pending) }
        }
        if !isEmpty {
            CarePassportView(
                name: name, profile: profile, expanded: $expanded, onReview: { care.openReview($0) },
                onChanged: { await care.loadProfile() }, onAdd: openAdd,
                onSource: { sourceRequest = $0 }
            )
        }
    }

    @ViewBuilder private var bottom: some View {
        Rectangle().fill(Theme.hairline).frame(height: 1).padding(.top, 12)
        NearbySection()
        NavigationLink {
            CareAccessView()
        } label: {
            HStack {
                Label("Explore all Calgary access", systemImage: "map")
                    .font(.rrButtonSecondary)
                Spacer()
                Image(systemName: "chevron.right").accessibilityHidden(true)
            }
            .foregroundStyle(Theme.tealInk)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(Theme.tealTint, in: .rect(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Explore all Calgary access")
        .accessibilityHint("Opens the care access map")
        .accessibilityIdentifier("care.accessLink")
    }

    /// an Ask citation: open the passport section holding the fact and scroll to it
    private func reveal(_ factId: String, proxy: ScrollViewProxy) {
        guard let fact = profile.facts.first(where: { $0.id == factId && $0.status == .approved }) else { return }
        expanded.insert(PassportSection.section(of: fact.category))
        Task {
            try? await Task.sleep(for: .milliseconds(150))
            withAnimation { proxy.scrollTo("fact-\(factId)", anchor: .center) }
        }
    }
}

private struct CareHeader: View {
    var name: String
    var session: Session
    var episode: EpisodeSummary
    var quickAdd: Bool
    var onVoice: () -> Void
    var onNote: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(CareData.possessive(name)) care")
                    .font(.careTitle)
                    .foregroundStyle(Theme.ink)
                    .tracking(-0.3)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("care.title")
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { week; today }
                    VStack(alignment: .leading, spacing: 2) { week; today }
                }
                .font(Fonts.figtree(15, relativeTo: .subheadline))
            }
            HStack(spacing: 10) {
                EmergencyHelpButton(name: name)
                Spacer(minLength: 0)
            }
            if quickAdd {
                HStack(spacing: 10) {
                    quickButton("Voice note", systemImage: "plus", identifier: "care.quick.voice", action: onVoice)
                    quickButton("Note", systemImage: "plus", identifier: "care.quick.note", action: onNote)
                }
            }
        }
        .padding(.bottom, 4)
    }

    private var week: some View {
        Text("Care week \(AlbertaTime.weekRange(episode.startsOn, episode.endsOn))").foregroundStyle(Theme.muted)
    }

    private var today: some View {
        Text("Today: \(AlbertaTime.dayLabel(session.today))").fontWeight(.semibold).foregroundStyle(Theme.ink)
    }

    private func quickButton(_ title: String, systemImage: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.secondary)
        .accessibilityLabel("Add a \(title.lowercased())")
        .accessibilityIdentifier(identifier)
    }
}

/// suggestions stay apart from the approved passport until the caregiver checks them
private struct PendingReviewSection: View {
    var name: String
    var count: Int
    var onReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(CareData.plural(count, "suggestion", "suggestions")) to check")
                .font(.rrHeadline)
                .accessibilityAddTraits(.isHeader)
            Text("Not in \(CareData.possessive(name)) passport yet. Helpers only see what you\u{2019}ve said is right.")
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Review \(CareData.plural(count, "suggestion", "suggestions"))", action: onReview)
                .buttonStyle(.primary)
                .accessibilityIdentifier("care.pending.review")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tealTint, in: .rect(cornerRadius: Theme.radius))
        .padding(.top, 12)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("care.pending")
    }
}
