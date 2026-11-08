import Foundation
import Observation
import SwiftUI

/// send a text: pick or type a number, draft, edit, tick the approval for these exact words and this number, then
/// send. nothing is saved or sent before the tick and the button that names the person (SmsSheet.tsx)
@MainActor
@Observable
final class SmsModel {
    enum Busy: Equatable {
        case draft, send
    }

    static let otherKey = "other"

    let api: any UrgentAPI
    let episodeId: String?
    let careAlias: String?
    let aiMode: String
    private let onChange: (SmsView?) -> Void

    var recipients: SmsRecipients?
    var choice = SmsModel.otherKey
    var otherPhone = ""
    var otherName = ""
    var senderName = ""
    var note = ""
    var tier: DisclosureTier = .minimal
    var body = ""
    var flags: [String] = []
    var terms: [String] = []
    var override = false
    var approved = false
    var busy: Busy?
    var error: String?
    var result: SmsView?
    /// the full number after a demo send, for "Send it from Messages"; nil for real (Twilio) sends
    var handoffPhone: String?
    private(set) var clientKey = SmsApproveInput.newClientKey()
    /// the server copy approved for this exact key; a retry after a failed send reuses it instead of approving again
    private var approvedText: (key: String, text: SmsView)?

    init(api: any UrgentAPI, episodeId: String?, careAlias: String?, aiMode: String, onChange: @escaping (SmsView?) -> Void) {
        self.api = api
        self.episodeId = episodeId
        self.careAlias = careAlias
        self.aiMode = aiMode
        self.onChange = onChange
    }

    static func key(_ option: SmsRecipientOption) -> String {
        option.kind == .demo ? "demo" : "care:\(option.id ?? "")"
    }

    // MARK: - derived

    var option: SmsRecipientOption? { recipients?.options.first { Self.key($0) == choice } }
    var typedPhone: String? { SmsWords.normalizePhone(otherPhone) }

    var to: SmsRecipientChoice? {
        if choice == Self.otherKey {
            guard let phone = typedPhone else { return nil }
            let label = otherName.trimmingCharacters(in: .whitespacesAndNewlines)
            return .phone(phone, label: label.isEmpty ? nil : label)
        }
        guard let option else { return nil }
        if option.kind == .demo { return .demo }
        return option.id.map { .careContact(id: $0) }
    }

    var toName: String {
        if choice == Self.otherKey {
            let name = otherName.trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? "this number" : name
        }
        return option?.label ?? ""
    }

    var toNumber: String {
        if choice == Self.otherKey { return typedPhone.map(SmsWords.formatPhone) ?? "" }
        return option?.phoneMasked ?? ""
    }

    var parts: (unicode: Bool, parts: Int, chars: Int) {
        SmsWords.smsParts(body.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var countLine: String {
        let p = parts
        let texts = p.parts == 1 ? "1 text" : "\(p.parts) texts"
        let extra = p.unicode && p.chars > 0 ? " (special characters make each text shorter)" : ""
        return "\(p.chars) characters \u{00B7} \(texts)\(extra)"
    }

    var blocked: Bool { !terms.isEmpty && tier != .detailed && !override }
    var isLive: Bool { recipients?.provider == .twilio }
    var hasBody: Bool { !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var draftLabel: String {
        if hasBody { return "Write it again" }
        switch aiMode {
        case "gemini": return "Write it with Gemini"
        case "demo": return "Write a draft (demo rules)"
        default: return "Write a draft"
        }
    }

    var canSend: Bool { to != nil && hasBody && approved && !blocked && busy == nil }
    var canApprove: Bool { to != nil && hasBody && busy == nil }
    var phoneInvalid: Bool { !otherPhone.trimmingCharacters(in: .whitespaces).isEmpty && typedPhone == nil }
    var flagNotes: [String] { flags.compactMap { SmsWords.flagNotes[$0] } }

    var approveLine: String {
        let name = toName.isEmpty ? "\u{2026}" : toName
        return "I approve sending exactly this text to \(name)\(toNumber.isEmpty ? "" : " at \(toNumber)")."
    }

    var sendTitle: String { toName.isEmpty ? "Send SMS" : "Send SMS to \(toName)" }

    var footNote: String {
        isLive
            ? "Sends a real text through Twilio from the app\u{2019}s number. Each send needs your approval."
            : "Twilio isn\u{2019}t set up, so this goes to the demo text outbox. Nothing is delivered."
    }

    // MARK: - changes

    /// any change to what would be sent needs a fresh tick and a fresh approval
    func changed() {
        approved = false
        result = nil
        handoffPhone = nil
        clientKey = SmsApproveInput.newClientKey()
        approvedText = nil
    }

    func choose(_ key: String) {
        choice = key
        changed()
    }

    /// the web's maxLength on each field (SmsSheet.tsx); the server refuses longer ones
    enum Limit {
        static let phone = 32
        static let name = 60
        static let sender = 60
        static let note = 500
        static let body = 1600
    }

    /// the most characters a field takes, by its key path
    static func limit(_ path: ReferenceWritableKeyPath<SmsModel, String>) -> Int? {
        let limits: [PartialKeyPath<SmsModel>: Int] = [
            \SmsModel.otherPhone: Limit.phone, \SmsModel.otherName: Limit.name, \SmsModel.senderName: Limit.sender,
            \SmsModel.note: Limit.note, \SmsModel.body: Limit.body,
        ]
        return limits[path]
    }

    /// writes a typed field, cut to its limit
    func set(_ path: ReferenceWritableKeyPath<SmsModel, String>, _ text: String) {
        guard let max = Self.limit(path) else {
            self[keyPath: path] = text
            return
        }
        TextLimit.assign(text, max: max) { self[keyPath: path] = $0 }
    }

    func editBody(_ text: String) {
        set(\.body, text)
        terms = []
        override = false
        changed()
    }

    func pickTier(_ next: DisclosureTier) {
        tier = next
        changed()
    }

    // MARK: - calls

    func loadRecipients() async {
        result = nil
        error = nil
        do throws(APIError) {
            let list = try await api.smsRecipients()
            recipients = list
            if choice == Self.otherKey, let first = list.options.first { choice = Self.key(first) }
            if senderName.isEmpty { senderName = list.senderName ?? "" }
        } catch {
            self.error = SmsWords.problem(error)
        }
    }

    private func trimmedOrNil(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    func writeDraft() async {
        guard busy == nil else { return }
        busy = .draft
        error = nil
        defer { busy = nil }
        let recipientName: String? = choice == Self.otherKey
            ? trimmedOrNil(otherName)
            : option?.kind == .careContact ? option?.label : nil
        do throws(APIError) {
            let draft = try await api.smsDraft(SmsDraftInput(
                episodeId: episodeId, recipientName: recipientName, senderName: trimmedOrNil(senderName),
                note: trimmedOrNil(note), tier: tier
            ))
            body = draft.text
            flags = draft.editFlags
            terms = draft.healthTermsFound
            override = false
            changed()
            AccessibilityNotification.Announcement("The draft is ready. Read it and change anything before you approve it.").post()
        } catch {
            self.error = SmsWords.problem(error)
        }
    }

    func send() async {
        guard busy == nil, let to, canSend else { return }
        busy = .send
        error = nil
        defer { busy = nil }
        do throws(APIError) {
            var text = approvedText?.key == clientKey ? approvedText?.text : nil
            if text == nil {
                let saved = try await api.smsApprove(SmsApproveInput(
                    clientKey: clientKey, episodeId: episodeId, to: to, senderName: trimmedOrNil(senderName),
                    body: body.trimmingCharacters(in: .whitespacesAndNewlines), tier: tier, healthOverride: override
                )).text
                approvedText = (clientKey, saved)
                onChange(saved)
                text = saved
            }
            guard let text else { return }
            let reply = try await api.smsSend(requestId: text.id)
            let sent = reply.text
            handoffPhone = reply.handoffPhone
            result = sent
            onChange(sent)
            AccessibilityNotification.Announcement("\(SmsWords.deliveryLabel(sent.delivery)). \(SmsWords.deliveryNote(sent))").post()
        } catch {
            if error.code == "health_terms" {
                terms = error.terms
                self.error = nil
            } else {
                self.error = SmsWords.problem(error)
                if error.status == 409 { onChange(nil) }
            }
        }
    }
}
