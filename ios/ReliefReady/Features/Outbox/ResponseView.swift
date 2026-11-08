import SwiftUI

/// the recipient's reply page (/r/[token] on the web), opened from an Outbox link: confirm accept or decline,
/// or propose another time, with POST /api/responses/[token]. nothing is recorded until the confirm.
struct ResponseView: View {
    @Environment(AppModel.self) private var model
    var link: ResponseLink

    @State private var phase: Phase = .loading
    @State private var proposedAt = Date()
    @State private var note = ""
    @State private var isBusy = false
    @State private var error: String?
    @State private var done: ResponseResult?
    @AccessibilityFocusState private var headingFocused: Bool

    enum Phase: Equatable {
        case loading
        case failed(ResponseCopy.Failure)
        case ready(ResponsePreview)
    }

    init(link: ResponseLink) {
        self.link = link
    }

    var body: some View {
        content
            .screenTitle("Reply")
            .accessibilityIdentifier("screen.response")
            .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            LoadingView("Opening the reply page").pageBackground()
        case .failed(let failure):
            ScreenColumn {
                QuestionHeader(failure.title)
                    .accessibilityIdentifier("response.heading")
                NoteText(failure.next, alignment: .leading)
            }
        case .ready(let preview):
            ScreenColumn {
                if let done {
                    finished(done, preview: preview)
                } else if !preview.isOpen {
                    QuestionHeader(ResponseLabels.closedMessage(preview.state))
                        .accessibilityIdentifier("response.heading")
                    letter(preview, showDue: false)
                    about
                } else {
                    form(preview)
                }
            }
        }
    }

    // MARK: - the three states of a loaded page

    @ViewBuilder
    private func finished(_ result: ResponseResult, preview: ResponsePreview) -> some View {
        let heading = ResponseCopy.doneHeading(result)
        QuestionHeader(heading.question, lead: heading.lead)
            .accessibilityIdentifier("response.done")
            .accessibilityFocused($headingFocused)
        NoteText("You can close this page now.", alignment: .leading)
        letter(preview, showDue: false)
            .padding(.top, 16)
        about
    }

    @ViewBuilder
    private func form(_ preview: ResponsePreview) -> some View {
        let copy = ResponseCopy.ask(preview.choice)
        QuestionHeader(copy.ask, lead: copy.lead)
            .accessibilityIdentifier("response.heading")
        letter(preview, showDue: true)
        if preview.choice == .propose {
            proposeFields
        }
        ButtonStack {
            Button {
                Task { await submit(preview) }
            } label: {
                Text(isBusy ? "Recording your answer" : copy.button)
            }
            .buttonStyle(.primary(busy: isBusy))
            .disabled(isBusy)
            .accessibilityLabel(isBusy ? "Recording your answer" : copy.button)
            .accessibilityIdentifier("response.confirm")
            NoteText("Meant to choose something else? Use the other links in the email.")
        }
        .padding(.top, 8)
        if let error {
            ErrorNote(error).accessibilityIdentifier("response.error")
        }
        about
    }

    private var proposeFields: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Date and time (Alberta time)")
                    .font(.rrLabel)
                    .foregroundStyle(Theme.ink)
                    .accessibilityHidden(true)
                DatePicker("Date and time (Alberta time)", selection: $proposedAt)
                    .labelsHidden()
                    .datePickerStyle(.compact)
                    .tint(Theme.teal)
                    // the request is in alberta time (utc-6 all year), whatever zone the phone is in
                    .environment(\.timeZone, AlbertaTime.timeZone)
                    .accessibilityLabel("Date and time, Alberta time")
                    .accessibilityIdentifier("response.date")
                Text(AlbertaTime.format(proposedAt))
                    .font(.rrNote.monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("response.dateSummary")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("A note (optional)")
                    .font(.rrLabel)
                    .foregroundStyle(Theme.ink)
                    .accessibilityHidden(true)
                TextField("", text: $note, axis: .vertical)
                    .lineLimit(3...6)
                    .font(.rrBody)
                    .foregroundStyle(Theme.ink)
                    .padding(12)
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.fieldBorder, lineWidth: 1)
                    }
                    .onChange(of: note) { _, next in
                        let clipped = ResponseCopy.clipped(next)
                        if clipped != next { note = clipped }
                    }
                    .accessibilityLabel("A note, optional")
                    .accessibilityIdentifier("response.note")
                Text("\(ResponseCopy.noteMax - ResponseCopy.length(note)) characters left")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.top, 8)
    }

    // MARK: - the letter

    private func letter(_ preview: ResponsePreview, showDue: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Card(padding: 18) {
                Text("A request sent to you")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                Text(preview.subject)
                    .font(.rrHeadline)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(preview.body)
                    .font(Fonts.figtree(15, relativeTo: .subheadline))
                    .foregroundStyle(Theme.ink)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("response.letter")
            if showDue, preview.isOpen, let due = preview.respondBy, AlbertaTime.parse(due) != nil {
                Label("Please answer by \(AlbertaTime.format(due)), Alberta time.", systemImage: "clock")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("response.due")
            }
        }
    }

    private var about: some View {
        Text(ResponseCopy.about)
            .font(.rrNote)
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 24)
    }

    // MARK: - calls

    private func load() async {
        // already answered here: keep the outcome on screen
        if done != nil { return }
        let api = model.api
        do {
            async let mail = api.outbox()
            async let list = api.requests()
            let outbox = try await mail
            // the request list says whether the link can still be answered; without it nothing is offered
            let requests = try await list
            let preview: ResponsePreview
            switch ResponsePreview.build(link: link, outbox: outbox, requests: requests.requests) {
            case .success(let built): preview = built
            case .failure(let failure):
                phase = .failed(failure)
                return
            }
            if case .loading = phase {
                let now = model.session.flatMap { AlbertaTime.parse($0.appNow) } ?? Date()
                proposedAt = ResponseCopy.defaultProposal(after: now)
            }
            phase = .ready(preview)
        } catch {
            if (error as? APIError)?.isCancelled != true { phase = .failed(.unavailable) }
        }
    }

    private func submit(_ preview: ResponsePreview) async {
        guard !isBusy else { return }
        error = nil
        let proposal = preview.choice == .propose ? ResponseProposal(at: proposedAt, note: note) : nil
        isBusy = true
        defer { isBusy = false }
        do {
            let result = try await model.api.respond(token: link.token, proposal: proposal)
            done = result
            let heading = ResponseCopy.doneHeading(result)
            AccessibilityNotification.Announcement([heading.lead, heading.question].compactMap(\.self).joined(separator: " ")).post()
            headingFocused = true
        } catch {
            self.error = error.responseMessage
        }
    }
}

#Preview {
    NavigationStack {
        ResponseView(link: ResponseLink(url: "http://127.0.0.1:3200/r/x", token: "x", choice: .accept))
    }
    .environment(AppModel())
}
