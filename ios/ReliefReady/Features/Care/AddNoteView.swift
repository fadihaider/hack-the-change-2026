import SwiftUI
import UniformTypeIdentifiers

// add what you know: a typed note or a pdf (AddWhatYouKnow.tsx). nothing is approved here; every fact comes back as
// a suggestion

enum AddNoteLimits {
    static let maxChars = 50_000
    /// the server takes up to 10 MB for the whole upload; leave room for the form wrapper
    static let maxPDFBytes = 10 * 1024 * 1024 - 64 * 1024
    static let slowAfter: Duration = .seconds(5)
    static let exampleNote =
        "Mom has her breakfast at 8:00 every morning, usually oatmeal with brown sugar. She takes her walk around the block at 10 am with her cane, every day if the weather is okay. Call Aunt Lucia at 403-555-0142 if anything comes up."
}

struct AddNoteView: View {
    @Environment(AppModel.self) private var app
    var care: CareModel
    var name: String
    var onVoice: (() -> Void)?
    @State private var text = ""
    @State private var busy: AddedFrom?
    @State private var slow = false
    @State private var error: String?
    @State private var notice: String?
    @State private var picking = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScreenColumn {
            QuestionHeader("What do you know about \(CareData.possessive(name)) care?", lead: "Routines, who to call, what the nurse said.")
            CareTextArea(
                label: "Write it down",
                hint: "Add times where you know them. Each thing comes back to you to check before helpers see it.",
                text: $text, minLines: 5, maxLength: AddNoteLimits.maxChars, isDisabled: busy != nil,
                identifier: "care.add.field", focus: $fieldFocused
            )
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && busy == nil {
                Button {
                    text = AddNoteLimits.exampleNote
                    error = nil
                    careAnnounce("Example added. Change anything you like, then check it.")
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Tap to use an example").font(.rrLabel).foregroundStyle(Theme.tealInk)
                        Text("\u{201C}\(AddNoteLimits.exampleNote)\u{201D}")
                            .font(.rrNote)
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.radius))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radius)
                            .strokeBorder(Theme.hairline, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Use an example note")
                .accessibilityIdentifier("care.add.example")
            }
            if let error { ErrorNote(error) }
            if let notice {
                Text(notice)
                    .font(.rrCallout)
                    .foregroundStyle(Theme.warnInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
                    .accessibilityIdentifier("care.add.notice")
            }
            ButtonStack {
                Button(busy == .note ? "Reading your note" : "Check what I wrote") { submit() }
                    .buttonStyle(.primary(busy: busy == .note))
                    .disabled(busy != nil)
                    .accessibilityIdentifier("care.add.submit")
                if slow { NoteText("Still reading. This can take a little while.") }
                if let onVoice {
                    Button {
                        onVoice()
                    } label: {
                        Label("Record a voice note instead", systemImage: "mic")
                    }
                    .buttonStyle(.quiet)
                    .disabled(busy != nil)
                    .accessibilityIdentifier("care.add.voice")
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Rectangle().fill(Theme.hairline).frame(height: 1).padding(.vertical, 12)
                Text("Have a discharge sheet or care plan?")
                    .font(.careSection)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text("A PDF with selectable text, under 10 MB. It\u{2019}s read word for word, like a note.")
                    .font(.rrNote)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    picking = true
                } label: {
                    Label(busy == .pdf ? "Reading the PDF" : "Upload a PDF", systemImage: "doc.badge.arrow.up")
                }
                .buttonStyle(.secondary(busy: busy == .pdf))
                .disabled(busy != nil)
                .padding(.top, 4)
                .accessibilityIdentifier("care.add.pdf")
            }
        }
        .screenTitle("Add a note")
        .navigationBarBackButtonHidden(busy != nil)
        .accessibilityIdentifier("screen.careAdd")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf]) { result in
            switch result {
            case .success(let url): picked(url)
            case .failure: break
            }
        }
        .task(id: busy) {
            slow = false
            guard busy != nil else { return }
            try? await Task.sleep(for: AddNoteLimits.slowAfter)
            if !Task.isCancelled && busy != nil {
                slow = true
                careAnnounce("Still reading. This can take a little while.")
            }
        }
    }

    private func submit() {
        guard busy == nil else { return }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            error = "Write something about \(CareData.possessive(name)) care first, or tap the example."
            fieldFocused = true
            return
        }
        fieldFocused = false
        run(.note) { () throws(APIError) in try await app.api.addCareText(kind: .note, text: words) }
    }

    private func picked(_ url: URL) {
        guard busy == nil else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            notice = nil
            error = "This PDF could not be read. Try another file or type the key lines as a note."
            return
        }
        guard url.pathExtension.lowercased() == "pdf" || UTType(filenameExtension: url.pathExtension)?.conforms(to: .pdf) == true
        else {
            notice = nil
            error = "Only PDF files can be uploaded here. Pick a PDF, or type the key lines as a note."
            return
        }
        guard data.count <= AddNoteLimits.maxPDFBytes else {
            notice = nil
            error = "That file is too large. Upload a PDF under 10 MB."
            return
        }
        let filename = url.lastPathComponent.isEmpty ? "care-document.pdf" : url.lastPathComponent
        run(.pdf) { () throws(APIError) in try await app.api.uploadCarePDF(data, filename: filename) }
    }

    private func run(_ from: AddedFrom, _ work: @escaping () async throws(APIError) -> CareSourceResult) {
        busy = from
        error = nil
        notice = nil
        careAnnounce(from == .pdf ? "Reading the PDF." : "Reading your note.")
        Task {
            do throws(APIError) {
                let result = try await work()
                if let message = await care.added(result, from: from) {
                    notice = message
                    careAnnounce(message)
                }
            } catch {
                self.error = error.userMessage
            }
            busy = nil
        }
    }
}
