import SwiftUI

/// Outbox: the demo outbox from More (GET /api/outbox, plus simulated texts from GET /api/sms). each message
/// shows its reply links (OutboxMessage.responseLinks), which open ResponseView.
struct OutboxView: View {
    @Environment(AppModel.self) private var model
    @State private var phase: Phase = .loading
    @State private var openLink: ResponseLink?

    enum Phase {
        case loading
        case failed
        case loaded(Outbox, texts: [SmsView])
    }

    init() {}

    var body: some View {
        content
            .screenTitle("Outbox")
            .accessibilityIdentifier("screen.outbox")
            .task { await load() }
            .navigationDestination(item: $openLink) { link in
                ResponseView(link: link)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            LoadingView("Loading the outbox").pageBackground()
        case .failed:
            ScreenColumn {
                OutboxBanner(text: "Local demo outbox: no real email was sent")
                QuestionHeader("The outbox isn\u{2019}t available.")
                NoteText("Sign in and make sure the local workspace is running, then reload this page.", alignment: .leading)
                Button("Try again") { Task { await load() } }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("outbox.retry")
            }
        case .loaded(let outbox, let texts):
            ScreenColumn {
                OutboxBanner(text: "Local demo outbox: no real email was sent")
                if outbox.mail != "outbox" {
                    QuestionHeader("Nothing is kept here.")
                    NoteText(
                        "Mail is set to \(outbox.mail), so messages go out through that adapter and are not kept here.",
                        alignment: .leading
                    )
                } else if outbox.messages.isEmpty {
                    QuestionHeader("No messages yet.")
                    NoteText("Approved requests show up here when they are sent.", alignment: .leading)
                } else {
                    QuestionHeader(OutboxContent.question(count: outbox.messages.count))
                        .padding(.bottom, -12)
                        .accessibilityIdentifier("outbox.heading")
                    Text("Newest first. The reply links work on this computer.")
                        .font(Fonts.figtree(15, relativeTo: .subheadline))
                        .foregroundStyle(Theme.muted)
                        .padding(.bottom, 4)
                    ForEach(Array(outbox.messages.enumerated()), id: \.element.id) { index, message in
                        OutboxLetter(message: message, index: index) { openLink = $0 }
                    }
                }
                if !texts.isEmpty {
                    OutboxBanner(text: "Simulated texts: not delivered to any phone")
                        .padding(.top, 24)
                    Text(OutboxContent.textsTitle(count: texts.count))
                        .font(.rrHeadline)
                        .foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(texts) { text in
                        OutboxText(text: text)
                    }
                }
            }
            .refreshable { await load() }
        }
    }

    private func load() async {
        let api = model.api
        async let mail = api.outbox()
        async let sms = api.smsList(episodeId: nil)
        do {
            let outbox = try await mail
            // texts are extra: a server without the sms routes still shows its mail
            let texts = (try? await sms).map(OutboxContent.simulatedTexts) ?? []
            phase = .loaded(outbox, texts: texts)
        } catch {
            phase = .failed
        }
    }
}

/// the warn-tinted note at the top of each list
private struct OutboxBanner: View {
    var text: String

    var body: some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "info.circle").accessibilityHidden(true)
        }
        .font(Fonts.figtree(15, weight: .semibold, relativeTo: .subheadline))
        .foregroundStyle(Theme.warnInk)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

/// a label and value row of a letter head
private struct OutboxHeadRow: View {
    var label: String
    var value: String
    var isStrong = false

    var body: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(label).foregroundStyle(Theme.muted).frame(width: 72, alignment: .leading)
                    valueText.frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Theme.muted)
                    valueText
                }
            }
            .font(Fonts.figtree(15, relativeTo: .subheadline))
            .padding(.vertical, 8)
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private var valueText: some View {
        Text(value)
            .fontWeight(isStrong ? .semibold : .regular)
            .monospacedDigit()
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// one stored message set as a letter, with its reply links tappable
private struct OutboxLetter: View {
    var message: OutboxMessage
    var index: Int
    var onOpen: (ResponseLink) -> Void

    var body: some View {
        Card(padding: 18) {
            VStack(spacing: 0) {
                OutboxHeadRow(label: "To", value: message.to)
                OutboxHeadRow(label: "Subject", value: message.subject, isStrong: true)
                OutboxHeadRow(label: "Sent", value: AlbertaTime.format(message.sentAt))
            }
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(OutboxContent.segments(message.body).enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .text(let text):
                        Text(text)
                            .font(Fonts.figtree(15, relativeTo: .subheadline))
                            .foregroundStyle(Theme.ink)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    case .link(let label, let link):
                        linkRow(label: label, link: link)
                    }
                }
            }
            .padding(.top, 4)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Message to \(message.to)")
        .accessibilityIdentifier("outbox.message.\(index)")
    }

    private func linkRow(label: String, link: ResponseLink) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if !label.isEmpty {
                Text(label)
                    .font(Fonts.figtree(15, relativeTo: .subheadline))
                    .foregroundStyle(Theme.ink)
                    .accessibilityHidden(true)
            }
            Button {
                onOpen(link)
            } label: {
                Text(link.url)
                    .font(Fonts.figtree(15, weight: .medium, relativeTo: .subheadline))
                    .foregroundStyle(Theme.tealInk)
                    .underline()
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Self.linkLabel(label: label, choice: link.choice))
            .accessibilityHint("Opens the reply page. Nothing is recorded until you confirm.")
            .accessibilityAddTraits(.isLink)
            .accessibilityIdentifier("outbox.link.\(index).\(link.choice?.rawValue ?? "link")")
        }
    }

    /// "Accept", "Decline", "Propose another time" or the raw label, for voiceover
    static func linkLabel(label: String, choice: ResponseChoice?) -> String {
        let trimmed = label.trimmingCharacters(in: CharacterSet(charactersIn: ": "))
        if !trimmed.isEmpty { return "\(trimmed) link" }
        switch choice {
        case .accept: return "Accept link"
        case .decline: return "Decline link"
        case .propose: return "Propose another time link"
        case nil: return "Reply link"
        }
    }
}

/// one simulated text
private struct OutboxText: View {
    var text: SmsView

    var body: some View {
        Card(padding: 18) {
            VStack(spacing: 0) {
                OutboxHeadRow(label: "To", value: text.recipient.phoneMasked)
                OutboxHeadRow(label: "Saved", value: AlbertaTime.format(OutboxContent.savedAt(text)))
            }
            Text(text.body)
                .font(Fonts.figtree(15, relativeTo: .subheadline))
                .foregroundStyle(Theme.ink)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(.top, 4)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Simulated text to \(text.recipient.phoneMasked)")
        .accessibilityIdentifier("outbox.text.\(text.id)")
    }
}

#Preview {
    NavigationStack { OutboxView() }
        .environment(AppModel())
}
