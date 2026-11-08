import SwiftUI

// emergency / help (EmergencyHelp.tsx, PRD 9): 911 and 811 as static tel: links that never wait on data or a model,
// then only the contacts the caregiver typed in. nothing dials or sends until a link is tapped

/// the compact header button that opens the emergency / help sheet
struct EmergencyHelpButton: View {
    var name: String
    @State private var isOpen = false

    var body: some View {
        Button {
            isOpen = true
        } label: {
            Label("Emergency / Help", systemImage: "lifepreserver")
                .font(Fonts.figtree(16, weight: .semibold, relativeTo: .body))
                .foregroundStyle(Theme.badInk)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(Theme.badTint, in: .rect(cornerRadius: Theme.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.badInk.opacity(0.25), lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Emergency / Help")
        .accessibilityHint("Opens 911, 811 and your trusted contacts")
        .accessibilityIdentifier("care.emergency")
        .sheet(isPresented: $isOpen) {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        SheetHeader(title: "Emergency / Help", closeLabel: "Close emergency help") { isOpen = false }
                        EmergencyHelpContent(name: name)
                    }
                    .padding(Theme.gutter)
                }
                .scrollDismissesKeyboard(.interactively)
                .toolbar(.hidden, for: .navigationBar)
            }
            .rrSheet()
            .presentationDetents([.large])
            .accessibilityIdentifier("sheet.emergency")
        }
    }
}

/// the inline block inside the passport's Contacts & logistics section
struct EmergencyHelpInline: View {
    var name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Emergency / Help")
                .font(.rrHeadline)
                .accessibilityAddTraits(.isHeader)
            EmergencyHelpContent(name: name)
        }
        .padding(14)
        .background(Theme.page, in: .rect(cornerRadius: Theme.radius))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("care.emergencyInline")
    }
}

struct EmergencyHelpContent: View {
    var name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 12) {
                EmergencyServiceCard(
                    title: "Emergency \u{2014} call 911",
                    systemImage: "light.beacon.max",
                    text: "In Calgary, call 911 now if \(name) is in immediate danger, can\u{2019}t breathe, has chest pain or isn\u{2019}t responding.",
                    callLabel: "Call 911",
                    url: CareHelp.emergencyURL,
                    isEmergency: true,
                    identifier: "care.call911"
                )
                EmergencyServiceCard(
                    title: "Health Link \u{2014} call 811",
                    systemImage: "stethoscope",
                    text: "For health questions that aren\u{2019}t emergencies, Health Link nurses give advice 24/7 anywhere in Alberta.",
                    callLabel: "Call 811",
                    url: CareHelp.healthLinkURL,
                    isEmergency: false,
                    identifier: "care.call811"
                )
                NoteText("Nothing dials or sends until you tap a number.", alignment: .leading)
            }
            TrustedContactsView(name: name)
        }
    }
}

private struct EmergencyServiceCard: View {
    var title: String
    var systemImage: String
    var text: String
    var callLabel: String
    var url: URL
    var isEmergency: Bool
    var identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.rrHeadline)
                .foregroundStyle(isEmergency ? Theme.badInk : Theme.ink)
                .accessibilityAddTraits(.isHeader)
            Text(text)
                .font(.rrBody)
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Link(destination: url) {
                Label(callLabel, systemImage: "phone.fill")
                    .font(.rrButton)
                    .foregroundStyle(isEmergency ? .white : Theme.ink)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(isEmergency ? Theme.badInk : Theme.surface, in: .rect(cornerRadius: Theme.radius))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radius)
                            .strokeBorder(isEmergency ? .clear : Theme.hairline, lineWidth: 1)
                    }
            }
            .accessibilityLabel(callLabel)
            .accessibilityIdentifier(identifier)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isEmergency ? Theme.badTint : Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(isEmergency ? .clear : Theme.hairline, lineWidth: 1)
        }
    }
}

// MARK: - trusted contacts

/// GET /api/care/contacts, add and remove
@Observable
final class ContactsModel {
    private(set) var contacts: [CareContact]?
    private(set) var loadError: String?
    @ObservationIgnored private var seq = 0

    var ordered: [CareContact] { CareHelp.orderContacts(contacts ?? []) }

    func load(_ api: APIClient) async {
        seq += 1
        let mine = seq
        loadError = nil
        do {
            let list = try await api.careContacts()
            if mine == seq { contacts = list.contacts }
        } catch {
            if mine == seq { loadError = error.userMessage }
        }
    }

    func added(_ contact: CareContact) {
        contacts = (contacts ?? []) + [contact]
    }

    func removed(_ contact: CareContact) {
        contacts = (contacts ?? []).filter { $0.id != contact.id }
    }
}

struct TrustedContactsView: View {
    @Environment(AppModel.self) private var app
    var name: String
    @State private var model = ContactsModel()
    @State private var adding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your trusted contacts")
                .font(.rrHeadline)
                .accessibilityAddTraits(.isHeader)
            Text("Only people you add here. ReliefReady never calls or messages them for you.")
                .font(.rrNote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)

            if let error = model.loadError {
                ErrorNote(error, retryLabel: "Load contacts again") { Task { await model.load(app.api) } }
            } else if model.contacts == nil {
                Text("Loading your contacts\u{2026}").font(.rrNote).foregroundStyle(Theme.muted)
            } else if model.ordered.isEmpty {
                CareEmptyBox(text: "No contacts added yet.")
                    .accessibilityIdentifier("care.contacts.empty")
            } else {
                VStack(spacing: 10) {
                    ForEach(model.ordered) { contact in
                        ContactRow(name: name, contact: contact) {
                            model.removed(contact)
                            careAnnounce("Removed \(contact.name) from your trusted contacts.")
                        }
                    }
                }
            }

            if model.contacts != nil && model.loadError == nil {
                if adding {
                    ContactForm(name: name) { contact in
                        model.added(contact)
                        adding = false
                        careAnnounce("Added \(contact.name) to your trusted contacts.")
                    } onCancel: {
                        adding = false
                    }
                } else {
                    Button {
                        adding = true
                    } label: {
                        Label("Add a contact", systemImage: "plus")
                    }
                    .buttonStyle(.secondary)
                    .accessibilityLabel("Add a contact")
                    .accessibilityIdentifier("care.contacts.add")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("care.contacts")
        .task { await model.load(app.api) }
    }
}

private struct ContactRow: View {
    @Environment(AppModel.self) private var app
    var name: String
    var contact: CareContact
    var onRemoved: () -> Void
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                InitialsAvatar(name: contact.name)
                VStack(alignment: .leading, spacing: 4) {
                    Text(contact.name).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                    HStack(spacing: 8) {
                        if contact.kind == .emergency {
                            TonePill("Emergency contact", tone: .bad)
                        } else {
                            Text("Trusted helper").font(.rrNote).foregroundStyle(Theme.muted)
                        }
                        if let relationship = contact.relationship, !relationship.isEmpty {
                            Text(relationship).font(.rrNote).foregroundStyle(Theme.muted)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)

            if let url = CareHelp.telURL(contact.phone) {
                Link(destination: url) {
                    Label(contact.phone, systemImage: "phone.fill")
                        .font(.rrButtonSecondary)
                        .foregroundStyle(Theme.tealInk)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(Theme.tealTint, in: .rect(cornerRadius: Theme.radius))
                }
                .accessibilityLabel("Call \(contact.name), \(contact.phone)")
                .accessibilityIdentifier("care.contact.call.\(contact.name)")
            } else {
                Text(contact.phone).font(.rrBody)
            }

            if confirming {
                Text("Remove \(contact.name) from \(Labels.possessive(name)) contacts? This only changes ReliefReady.")
                    .font(.rrBody)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Remove") { Task { await remove() } }
                        .buttonStyle(.secondary(busy: busy))
                        .disabled(busy)
                        .accessibilityLabel("Remove \(contact.name)")
                        .accessibilityIdentifier("care.contact.removeYes")
                    Button("Keep") {
                        confirming = false
                        error = nil
                    }
                    .buttonStyle(.secondary)
                    .disabled(busy)
                    .accessibilityLabel("Keep \(contact.name)")
                    .accessibilityIdentifier("care.contact.keep")
                }
                if let error { ErrorNote(error) }
            } else {
                Button("Remove") { confirming = true }
                    .buttonStyle(.quiet)
                    .accessibilityLabel("Remove \(contact.name)")
                    .accessibilityIdentifier("care.contact.remove.\(contact.name)")
            }
        }
        .padding(14)
        .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
        .overlay { RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.hairline, lineWidth: 1) }
    }

    private func remove() async {
        guard !busy else { return }
        busy = true
        error = nil
        do {
            _ = try await app.api.removeCareContact(id: contact.id)
            onRemoved()
        } catch {
            self.error = error.userMessage
            busy = false
        }
    }
}

private struct ContactForm: View {
    @Environment(AppModel.self) private var app
    var name: String
    var onAdded: (CareContact) -> Void
    var onCancel: () -> Void
    @State private var draft = CareHelp.ContactDraft()
    @State private var fieldError: (field: CareHelp.DraftField, message: String)?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add someone you trust to help \(name)")
                .font(.rrHeadline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            CareTextField(
                label: "Name", text: $draft.name, error: message(.name), maxLength: CareHelp.nameLimit,
                contentType: .name, identifier: "care.contactForm.name"
            )
            CareTextField(
                label: "Relationship", optional: true, hint: "For example: daughter, neighbour, family doctor",
                text: $draft.relationship, error: message(.relationship), maxLength: CareHelp.relationshipLimit,
                identifier: "care.contactForm.relationship"
            )
            CareTextField(
                label: "Phone number", hint: "For example: 403-555-0142", text: $draft.phone, error: message(.phone),
                maxLength: CareHelp.phoneLimit, keyboard: .phonePad, contentType: .telephoneNumber,
                identifier: "care.contactForm.phone"
            )
            VStack(alignment: .leading, spacing: 8) {
                Text("When to call them").font(.rrLabel)
                kindChoice(.emergency, title: "Emergency contact", hint: "Call first in an emergency, after 911")
                kindChoice(.trusted, title: "Trusted helper", hint: "Can help out or take a shift")
            }
            if let error { ErrorNote(error) }
            ButtonStack {
                Button("Save contact") { Task { await save() } }
                    .buttonStyle(.primary(busy: busy))
                    .disabled(busy)
                    .accessibilityLabel("Save contact")
                    .accessibilityIdentifier("care.contactForm.save")
                Button("Cancel", action: onCancel)
                    .buttonStyle(.quiet)
                    .disabled(busy)
                    .accessibilityLabel("Cancel adding a contact")
                    .accessibilityIdentifier("care.contactForm.cancel")
            }
        }
        .padding(16)
        .careBox(Theme.radius)
        .onChange(of: draft) { _, _ in fieldError = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("care.contactForm")
    }

    private func message(_ field: CareHelp.DraftField) -> String? {
        fieldError?.field == field ? fieldError?.message : nil
    }

    private func kindChoice(_ kind: CareContactKind, title: String, hint: String) -> some View {
        let selected = draft.kind == kind
        return Button {
            draft.kind = kind
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? Theme.teal : Theme.fieldBorder)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.rrBodyMedium).foregroundStyle(Theme.ink)
                    Text(hint).font(.rrNote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(minHeight: 44)
            .background(Theme.surface, in: .rect(cornerRadius: Theme.radiusSmall))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radiusSmall)
                    .strokeBorder(selected ? Theme.teal : Theme.hairline, lineWidth: selected ? 2 : 1)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel("\(title). \(hint)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("care.contactForm.kind.\(kind.rawValue)")
    }

    private func save() async {
        guard !busy else { return }
        switch CareHelp.check(draft) {
        case .invalid(let field, let text):
            fieldError = (field, text)
            careAnnounce(text)
        case .ok(let input):
            busy = true
            error = nil
            do {
                let result = try await app.api.addCareContact(input)
                onAdded(result.contact)
            } catch {
                self.error = error.userMessage
                busy = false
            }
        }
    }
}
