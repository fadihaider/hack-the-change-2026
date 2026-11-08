import AVFoundation
import SwiftUI

/// the voice note step (CareScreen voice view + VoiceNote.tsx)
struct VoiceNoteView: View {
    @Environment(AppModel.self) private var app
    var care: CareModel
    var name: String
    var speech: SpeechProvider
    var onTypeInstead: () -> Void
    var onClose: () -> Void
    @State private var model: VoiceNoteModel?

    /// debug builds honour -CareSpeech on, so the recorder can be shown against a server with speech off
    static var speechOverride: Bool {
        #if DEBUG
            UserDefaults.standard.string(forKey: "CareSpeech") == "on"
        #else
            false
        #endif
    }

    var body: some View {
        ScreenColumn {
            QuestionHeader("Tell ReliefReady about \(name)", lead: "Routines, who to call, where things are kept.")
            VStack(alignment: .leading, spacing: 8) {
                Text("Voice note").font(.careSection).accessibilityAddTraits(.isHeader)
                Text(
                    "Say what you know about \(Labels.possessive(name)) care in your own words. You\u{2019}ll check the words before anything is saved."
                )
                .font(.rrBody)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            }
            if speech == .off && !Self.speechOverride {
                speechOff
            } else if let model {
                VoicePanel(model: model, onTypeInstead: onTypeInstead, onClose: onClose)
            }
        }
        .screenTitle("Voice note")
        .accessibilityIdentifier("screen.careVoice")
        .onAppear {
            guard model == nil else { return }
            let api = app.api
            model = VoiceNoteModel(
                engine: AudioRecorderEngine(),
                transcribe: { data throws(APIError) in try await api.transcribe(audio: data, contentType: "audio/m4a") },
                save: { [care] text in await care.saveTranscript(text) }
            )
        }
        .onDisappear { model?.leave() }
    }

    private var speechOff: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(APIError.speechOffMessage)
                .font(.rrBody)
                .fixedSize(horizontal: false, vertical: true)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
                .accessibilityIdentifier("care.voice.off")
            ButtonStack {
                Button(action: onTypeInstead) { Label("Type a note", systemImage: "keyboard") }
                    .buttonStyle(.primary)
                    .accessibilityIdentifier("care.voice.typeNote")
                Button("Close", action: onClose)
                    .buttonStyle(.quiet)
                    .accessibilityLabel("Close the voice note")
                    .accessibilityIdentifier("care.voice.close")
            }
        }
    }
}

private struct VoicePanel: View {
    @Bindable var model: VoiceNoteModel
    var onTypeInstead: () -> Void
    var onClose: () -> Void
    @State private var player: AVAudioPlayer?
    @State private var playing = false
    @State private var slow = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch model.phase {
            case .blocked(let message):
                noticeBox(message, identifier: "care.voice.blocked")
                ButtonStack {
                    Button { leave(onTypeInstead) } label: { Label("Type a note", systemImage: "keyboard") }
                        .buttonStyle(.primary)
                        .accessibilityIdentifier("care.voice.typeNote")
                    backButton
                    closeButton
                }
            case .idle, .requesting:
                NoteText(
                    "Up to \(VoiceLimits.words(model.maxSeconds)). Your recording is sent to ElevenLabs to turn it into text. ReliefReady keeps only the words you confirm, never the audio.",
                    alignment: .leading
                )
                .accessibilityIdentifier("care.voice.consent")
                ButtonStack {
                    Button { Task { await model.startRecording() } } label: { Label("Record", systemImage: "mic.fill") }
                        .buttonStyle(.primary(busy: model.phase == .requesting))
                        .disabled(model.phase == .requesting)
                        .accessibilityLabel(model.phase == .requesting ? "Waiting for the microphone" : "Record")
                        .accessibilityIdentifier("care.voice.record")
                    if model.phase == .requesting { NoteText("ReliefReady will ask to use the microphone.") }
                    backButton
                    typeInsteadButton
                    closeButton
                }
            case .recording:
                HStack(spacing: 10) {
                    Circle().fill(Theme.badInk).frame(width: 12, height: 12).accessibilityHidden(true)
                    Text("Recording").font(.rrBodyMedium)
                    Spacer()
                    Text(
                        "\(Text(VoiceLimits.elapsed(model.elapsed)).font(.rrBodyMedium.monospacedDigit())) \(Text("of \(VoiceLimits.elapsed(model.maxSeconds))").font(.rrNote).foregroundStyle(Theme.muted))"
                    )
                }
                .padding(14)
                .background(Theme.badTint, in: .rect(cornerRadius: Theme.radius))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Recording, \(VoiceLimits.words(model.elapsed)) of \(VoiceLimits.words(model.maxSeconds))")
                .accessibilityIdentifier("care.voice.recording")
                ButtonStack {
                    Button { model.stopRecording() } label: { Label("Stop", systemImage: "stop.fill") }
                        .buttonStyle(.primary)
                        .accessibilityIdentifier("care.voice.stop")
                    typeInsteadButton
                }
            case .stopped(let take, _), .transcribing(let take):
                let transcribing = model.phase == .transcribing(take)
                Text(statusLine(take))
                    .font(.rrBodyMedium)
                    .accessibilityIdentifier("care.voice.recorded")
                listenBack(take)
                NoteText("Transcribe sends this recording to ElevenLabs once. Nothing is saved until you confirm the words.", alignment: .leading)
                ButtonStack {
                    Button(transcribing ? "Transcribing" : "Transcribe") { Task { await model.transcribe(take) } }
                        .buttonStyle(.primary(busy: transcribing))
                        .disabled(transcribing)
                        .accessibilityIdentifier("care.voice.transcribe")
                    if slow && transcribing { NoteText("Still transcribing. This can take a little while.") }
                    rerecordButton.disabled(transcribing)
                    backButton
                    typeInsteadButton
                }
            case .review, .saving:
                let saving = model.phase == .saving
                NoteText(
                    "Transcribed by ElevenLabs. Speech recognition makes mistakes, so check names, times and amounts and fix anything it misheard. Only the words you confirm are saved.",
                    alignment: .leading
                )
                CareTextArea(
                    label: "Transcript", hint: "Edit it like any note. Each fact still comes back to you to approve.",
                    text: Binding(get: { model.transcript ?? "" }, set: { model.editTranscript($0) }),
                    minLines: 6, maxLength: VoiceLimits.maxTranscriptChars, isDisabled: saving,
                    identifier: "care.voice.transcript"
                )
                if let error = model.saveError { ErrorNote(error) }
                if let notice = model.saveNotice { noticeBox(notice, identifier: "care.voice.notice") }
                ButtonStack {
                    Button(saving ? "Reading your note\u{2026}" : "Use transcript") { Task { await model.confirmTranscript() } }
                        .buttonStyle(.primary(busy: saving))
                        .disabled(saving)
                        .accessibilityIdentifier("care.voice.use")
                    if slow && saving { NoteText("Still reading. This can take a little while.") }
                    rerecordButton.disabled(saving)
                    closeButton
                }
            case .error(let message, let take):
                ErrorNote(message)
                if let take { listenBack(take) }
                ButtonStack {
                    if let take {
                        Button("Try again") { Task { await model.transcribe(take) } }
                            .buttonStyle(.primary)
                            .accessibilityIdentifier("care.voice.retry")
                        rerecordButton
                    } else {
                        Button { Task { await model.startRecording() } } label: { Label("Record again", systemImage: "mic.fill") }
                            .buttonStyle(.primary)
                            .accessibilityIdentifier("care.voice.recordAgain")
                    }
                    backButton
                    typeInsteadButton
                    closeButton
                }
            }
        }
        .onChange(of: model.announcement) { _, text in
            if let text { careAnnounce(text) }
        }
        .task(id: model.isWorking) {
            slow = false
            guard model.isWorking else { return }
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled && model.isWorking {
                slow = true
                careAnnounce("Still working. This can take a little while.")
            }
        }
        .onChange(of: model.phase) { _, _ in stopPlayback() }
    }

    private func statusLine(_ take: VoiceTake) -> String {
        if case .stopped(_, let hitLimit) = model.phase, hitLimit {
            return "Recording stopped at the \(VoiceLimits.words(model.maxSeconds)) limit."
        }
        return "Recorded \(VoiceLimits.words(take.seconds))."
    }

    private func noticeBox(_ text: String, identifier: String) -> some View {
        Text(text)
            .font(.rrBody)
            .fixedSize(horizontal: false, vertical: true)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.warnTint, in: .rect(cornerRadius: Theme.radius))
            .accessibilityIdentifier(identifier)
    }

    private func listenBack(_ take: VoiceTake) -> some View {
        Button {
            if playing { stopPlayback() } else { play(take) }
        } label: {
            Label(playing ? "Stop playback" : "Listen back", systemImage: playing ? "stop.circle" : "play.circle")
        }
        .buttonStyle(.secondary)
        .accessibilityLabel(playing ? "Stop playback" : "Listen back to your recording")
        .accessibilityIdentifier("care.voice.listen")
    }

    private func play(_ take: VoiceTake) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        player = try? AVAudioPlayer(data: take.audio)
        playing = player?.play() ?? false
    }

    private func stopPlayback() {
        player?.stop()
        player = nil
        playing = false
    }

    private func leave(_ next: () -> Void) {
        stopPlayback()
        model.leave()
        next()
    }

    private var rerecordButton: some View {
        Button { Task { await model.startRecording() } } label: { Label("Re-record", systemImage: "arrow.counterclockwise") }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("care.voice.rerecord")
    }

    @ViewBuilder private var backButton: some View {
        if model.transcript != nil {
            Button("Back to my transcript") { model.backToTranscript() }
                .buttonStyle(.secondary)
                .disabled(model.isWorking)
                .accessibilityIdentifier("care.voice.backToTranscript")
        }
    }

    private var typeInsteadButton: some View {
        Button { leave(onTypeInstead) } label: { Label("Type instead", systemImage: "keyboard") }
            .buttonStyle(.quiet)
            .disabled(model.isWorking)
            .accessibilityIdentifier("care.voice.typeInstead")
    }

    private var closeButton: some View {
        Button("Close") { leave(onClose) }
            .buttonStyle(.quiet)
            .disabled(model.isWorking)
            .accessibilityLabel("Close the voice note")
            .accessibilityIdentifier("care.voice.close")
    }
}
