import SwiftUI
import UIKit

/// "Send a text": who gets it, what they should know, the draft, the approval tick, then send
struct SmsSheet: View {
    @Bindable var sms: SmsModel
    var onClose: () -> Void
    @State private var composing = false
    @State private var handoffNote: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TonePill(sms.isLive ? "Real text" : "Demo \u{00B7} not delivered", tone: sms.isLive ? .ask : .warn)
                        .accessibilityIdentifier("sms.mode")
                    SheetHeader(title: "Send a text", onClose: onClose)
                        .accessibilityIdentifier("sms.close")
                        .padding(.bottom, -12)
                    Text("Pick who gets it and say what they should know. Read the draft, change anything, then approve these exact words.")
                        .font(.rrBody)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    recipientsPicker
                    field("Sign it as", text: binding(\.senderName), identifier: "sms.sender")
                    noteField
                    TierPicker(
                        value: sms.tier, groupTier: nil, alias: sms.careAlias, disabled: sms.busy != nil,
                        identifierPrefix: "sms"
                    ) { sms.pickTier($0) }

                    UrgentButton(
                        title: sms.draftLabel, kind: .secondary, systemImage: "sparkles", isBusy: sms.busy == .draft,
                        busyTitle: "Writing the draft", identifier: "sms.draft"
                    ) { Task { await sms.writeDraft() } }
                    .disabled(sms.busy == .send)

                    paper

                    if !sms.flagNotes.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(sms.flagNotes, id: \.self) { InfoLine(text: $0) }
                        }
                    }

                    if !sms.terms.isEmpty && sms.tier != .detailed {
                        WarnBox(
                            title: "This text mentions \(UrgentWords.quoted(sms.terms)).",
                            text: "Health details stay private unless you choose to share them. Edit them out, or send it as written."
                        ) {
                            RadioRow(
                                title: "Send it with these words", selected: sms.override, checkbox: true,
                                identifier: "sms.override"
                            ) {
                                sms.override.toggle()
                                sms.changed()
                            }
                        }
                    }

                    RadioRow(
                        title: sms.approveLine, selected: sms.approved, checkbox: true, identifier: "sms.approve"
                    ) { sms.approved.toggle() }
                    .disabled(!sms.canApprove)

                    if let error = sms.error {
                        ErrorNote(error).id("sms.error").accessibilityIdentifier("sms.error")
                    }

                    if let result = sms.result {
                        VStack(alignment: .leading, spacing: 10) {
                            TonePill(SmsWords.deliveryLabel(result.delivery), tone: SmsWords.deliveryTone(result.delivery))
                            Text(SmsWords.deliveryNote(result)).font(.rrBody).foregroundStyle(Theme.ink)
                            if let id = result.providerMessageId {
                                Text("Message ID \(id)").font(.rrNote).foregroundStyle(Theme.muted)
                            }
                            if let phone = sms.handoffPhone {
                                Text("To make it arrive for real, send it from this phone\u{2019}s Messages app.")
                                    .font(.rrBody).foregroundStyle(Theme.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                UrgentButton(
                                    title: "Send it from Messages", kind: .primary, systemImage: "message",
                                    identifier: "sms.handoff"
                                ) { handOff(phone: phone, body: result.body) }
                                if let handoffNote {
                                    Text(handoffNote).font(.rrNote).foregroundStyle(Theme.muted)
                                        .accessibilityIdentifier("sms.handoffNote")
                                }
                            }
                            UrgentButton(
                                title: "Done", kind: sms.handoffPhone == nil ? .primary : .secondary, identifier: "sms.done",
                                action: onClose
                            )
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("sms.result")
                    } else {
                        UrgentButton(
                            title: sms.sendTitle, kind: .primary, systemImage: "paperplane", isBusy: sms.busy == .send,
                            busyTitle: "Sending to \(sms.toName)", identifier: "sms.send"
                        ) { Task { await sms.send() } }
                        .disabled(!sms.canSend && sms.busy != .send)
                    }

                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "message").accessibilityHidden(true)
                        Text(sms.footNote).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                }
                .padding(Theme.gutter)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: sms.error) { _, error in
                if error != nil { withAnimation { proxy.scrollTo("sms.error", anchor: .center) } }
            }
        }
        .background(Theme.surface)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                }.accessibilityIdentifier("keyboard.done")
            }
        }
        .task { await sms.loadRecipients() }
        .sheet(isPresented: $composing) {
            if let phone = sms.handoffPhone, let body = sms.result?.body {
                MessageComposer(phone: phone, body: body) { outcome in
                    composing = false
                    switch outcome {
                    case .sent: handoffNote = "Sent from your Messages app."
                    case .failed: handoffNote = "Messages couldn\u{2019}t send it. Try again."
                    case .cancelled: handoffNote = nil
                    @unknown default: handoffNote = nil
                    }
                }
                .ignoresSafeArea()
            }
        }
        .accessibilityIdentifier("screen.sms")
    }

    /// the Messages sheet on a phone that can text; otherwise the sms: link, which opens Messages where it exists
    private func handOff(phone: String, body: String) {
        handoffNote = nil
        if MessageComposer.canSend {
            composing = true
            return
        }
        var parts = URLComponents()
        parts.scheme = "sms"
        parts.path = phone
        parts.queryItems = [URLQueryItem(name: "body", value: body)]
        if let url = parts.url {
            openURL(url) { opened in
                if !opened { handoffNote = "This device can\u{2019}t send texts. Use an iPhone with a SIM or iMessage." }
            }
        }
    }

    /// a field binding where every change to what would be sent needs a fresh approval
    private func binding(_ path: ReferenceWritableKeyPath<SmsModel, String>, resets: Bool = true) -> Binding<String> {
        Binding(
            get: { sms[keyPath: path] },
            set: {
                sms.set(path, $0)
                if resets { sms.changed() }
            }
        )
    }

    private var recipientsPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            GroupTitle("Who gets it")
            ForEach(sms.recipients?.options ?? [], id: \.self) { option in
                let detail = option.detail.flatMap { option.kind == .careContact ? " \u{00B7} \($0)" : nil } ?? ""
                RadioRow(
                    title: option.label, hint: "\(option.phoneMasked)\(detail)",
                    selected: sms.choice == SmsModel.key(option), identifier: "sms.to.\(SmsModel.key(option))"
                ) { sms.choose(SmsModel.key(option)) }
            }
            RadioRow(
                title: "Another number", hint: "A Canadian or US mobile number", selected: sms.choice == SmsModel.otherKey,
                identifier: "sms.to.other"
            ) { sms.choose(SmsModel.otherKey) }
            if sms.choice == SmsModel.otherKey {
                VStack(alignment: .leading, spacing: 4) {
                    field("Phone number", text: binding(\.otherPhone), identifier: "sms.phone", prompt: "403 555 0123")
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                    if sms.phoneInvalid {
                        Text("Enter 10 digits, for example 403 555 0123.").font(.rrNote).foregroundStyle(Theme.badInk)
                    }
                }
                field("Their name (optional)", text: binding(\.otherName), identifier: "sms.name")
            }
        }
        .disabled(sms.busy != nil)
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("What should they know?").font(.rrLabel).foregroundStyle(Theme.ink)
            TextField(
                "What should they know?",
                text: binding(\.note, resets: false),
                prompt: Text("For example: I\u{2019}m going through something difficult and won\u{2019}t be reachable for the next seven days."),
                axis: .vertical
            )
            .lineLimit(3...)
            .font(.rrBody)
            .padding(12)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
            .overlay { RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.fieldBorder, lineWidth: 1) }
            .accessibilityLabel("What should they know?")
            .accessibilityIdentifier("sms.note")
        }
        .disabled(sms.busy != nil)
    }

    private func field(_ label: String, text: Binding<String>, identifier: String, prompt: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.rrLabel).foregroundStyle(Theme.ink)
            TextField(label, text: text, prompt: prompt.map { Text($0) })
                .font(.rrBody)
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
                .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
                .overlay { RoundedRectangle(cornerRadius: Theme.radiusSmall).strokeBorder(Theme.fieldBorder, lineWidth: 1) }
                .accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
        }
    }

    private var paper: some View {
        Paper {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                PaperLabel("To").frame(width: 64, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(sms.toName.isEmpty ? "Pick someone above" : sms.toName).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                    if !sms.toNumber.isEmpty {
                        Text(sms.toNumber).font(.rrNote).foregroundStyle(Theme.muted)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("sms.toLine")
            }
            .padding(.vertical, 12)
            Hairline()
            VStack(alignment: .leading, spacing: 6) {
                PaperLabel("Text message")
                TextField(
                    "Text message",
                    text: Binding(get: { sms.body }, set: { sms.editBody($0) }),
                    prompt: Text("Write it here, or use the button above for a draft."),
                    axis: .vertical
                )
                .lineLimit(5...)
                .font(.rrBody)
                .disabled(sms.busy != nil)
                .accessibilityLabel("Text message")
                .accessibilityIdentifier("sms.body")
                Text(sms.countLine).font(.rrNote).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("sms.count")
            }
            .padding(.vertical, 12)
        }
    }
}
