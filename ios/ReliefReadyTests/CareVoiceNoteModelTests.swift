import Foundation
import Testing
@testable import ReliefReady

/// a recorder that never touches the microphone
@MainActor
final class FakeRecorder: VoiceRecorderEngine {
    var allow = true
    var startProblem: MicProblem?
    var audio: Data? = Data(repeating: 7, count: 2048)
    private(set) var started = 0
    private(set) var cancelled = 0

    func requestPermission() async -> Bool { allow }

    func start() throws(MicProblem) {
        if let startProblem { throw startProblem }
        started += 1
    }

    func stop() -> Data? { audio }

    func cancel() { cancelled += 1 }
}

/// the voice note state machine: record, stop, transcribe, check the words, save
@MainActor
struct CareVoiceNoteModelTests {
    private func model(
        _ recorder: FakeRecorder,
        transcribe: @escaping VoiceNoteModel.Transcribe = { _ throws(APIError) in Transcript(transcript: "  She has breakfast at 8:00.  ") },
        save: @escaping VoiceNoteModel.Save = { _ in nil }
    ) -> VoiceNoteModel {
        VoiceNoteModel(engine: recorder, transcribe: transcribe, save: save)
    }

    @Test func recordStopTranscribeAndUse() async {
        let recorder = FakeRecorder()
        var saved: [String] = []
        let voice = model(recorder, save: { text in
            saved.append(text)
            return nil
        })
        #expect(voice.phase == .idle)
        await voice.startRecording()
        #expect(voice.phase == .recording)
        #expect(recorder.started == 1)
        #expect(voice.announcement == "Recording. Press Stop when you\u{2019}re done.")

        voice.stopRecording()
        guard case .stopped(let take, let hitLimit) = voice.phase else {
            Issue.record("expected stopped, got \(voice.phase)")
            return
        }
        #expect(!hitLimit)
        #expect(take.audio.count == 2048)

        await voice.transcribe(take)
        #expect(voice.phase == .review)
        #expect(voice.transcript == "She has breakfast at 8:00.")

        voice.editTranscript("She has breakfast at 8:00 every morning.")
        await voice.confirmTranscript()
        #expect(saved == ["She has breakfast at 8:00 every morning."])
        #expect(voice.phase == .review)
    }

    @Test func theTwoMinuteLimitStopsTheRecording() async {
        let recorder = FakeRecorder()
        let voice = model(recorder)
        #expect(voice.maxSeconds == 120)
        await voice.startRecording()
        voice.tick(now: Date().addingTimeInterval(106))
        #expect(voice.phase == .recording)
        #expect(voice.announcement == "14 seconds left.")
        voice.tick(now: Date().addingTimeInterval(121))
        guard case .stopped(let take, let hitLimit) = voice.phase else {
            Issue.record("expected stopped at the limit")
            return
        }
        #expect(hitLimit)
        #expect(take.seconds == 120)
        #expect(voice.announcement == "Recording stopped at the 2 minutes limit. Listen back, or transcribe it.")
    }

    @Test func microphoneProblemsOfferTypingOrAnotherTry() async {
        let denied = FakeRecorder()
        denied.allow = false
        let voice = model(denied)
        await voice.startRecording()
        #expect(voice.phase == .error(MicProblem.permissionDenied.message, nil))

        let busy = FakeRecorder()
        busy.startProblem = .micBusy
        let other = model(busy)
        await other.startRecording()
        #expect(other.phase == .error(MicProblem.micBusy.message, nil))

        let silent = FakeRecorder()
        silent.audio = Data()
        let empty = model(silent)
        await empty.startRecording()
        empty.stopRecording()
        #expect(empty.phase == .error("Nothing was recorded. Try again closer to the microphone, or type the note instead.", nil))
    }

    @Test func speechOffOnTheServerLeavesOnlyTyping() async {
        let voice = model(FakeRecorder(), transcribe: { _ throws(APIError) in
            throw APIError(code: "speech_not_configured", status: 503)
        })
        await voice.startRecording()
        voice.stopRecording()
        guard case .stopped(let take, _) = voice.phase else { return }
        await voice.transcribe(take)
        #expect(voice.phase == .blocked(APIError.speechOffMessage))
        #expect(voice.transcript == nil)
    }

    @Test func aDroppedConnectionKeepsTheRecordingForAnotherTry() async {
        var attempts = 0
        let voice = model(FakeRecorder(), transcribe: { _ throws(APIError) in
            attempts += 1
            if attempts == 1 { throw APIError.network }
            return Transcript(transcript: "words")
        })
        await voice.startRecording()
        voice.stopRecording()
        guard case .stopped(let take, _) = voice.phase else { return }
        await voice.transcribe(take)
        #expect(voice.phase == .error(APIError.speechErrorText["network_error"]!, take))
        await voice.transcribe(take)
        #expect(voice.phase == .review)
        #expect(voice.transcript == "words")
    }

    @Test func unreadableAudioCannotBeSentAgain() async {
        let voice = model(FakeRecorder(), transcribe: { _ throws(APIError) in
            throw APIError(code: "invalid_audio", status: 400)
        })
        await voice.startRecording()
        voice.stopRecording()
        guard case .stopped(let take, _) = voice.phase else { return }
        await voice.transcribe(take)
        guard case .error(_, let kept) = voice.phase else {
            Issue.record("expected an error")
            return
        }
        #expect(kept == nil)
    }

    @Test func anEmptyTranscriptIsNotUsed() async {
        let voice = model(FakeRecorder(), transcribe: { _ throws(APIError) in Transcript(transcript: "  ") })
        await voice.startRecording()
        voice.stopRecording()
        guard case .stopped(let take, _) = voice.phase else { return }
        await voice.transcribe(take)
        guard case .error(let message, _) = voice.phase else {
            Issue.record("expected an error")
            return
        }
        #expect(message.hasPrefix("Nothing was heard"))
    }

    @Test func savingShowsWhatCameBackAndRefusesEmptyWords() async {
        let voice = model(FakeRecorder(), save: { _ in "Your voice note didn\u{2019}t have anything new to add." })
        await voice.startRecording()
        voice.stopRecording()
        guard case .stopped(let take, _) = voice.phase else { return }
        await voice.transcribe(take)
        voice.editTranscript("   ")
        await voice.confirmTranscript()
        #expect(voice.saveError == "The transcript is empty. Add the words, or record again.")
        voice.editTranscript("Radio in the afternoon.")
        #expect(voice.saveError == nil)
        await voice.confirmTranscript()
        #expect(voice.saveNotice == "Your voice note didn\u{2019}t have anything new to add.")
    }

    @Test func rerecordingKeepsTheTranscriptUntilReplaced() async {
        let recorder = FakeRecorder()
        let voice = model(recorder)
        await voice.startRecording()
        voice.stopRecording()
        guard case .stopped(let take, _) = voice.phase else { return }
        await voice.transcribe(take)
        await voice.startRecording()
        #expect(voice.phase == .recording)
        #expect(voice.transcript == "She has breakfast at 8:00.")
        voice.backToTranscript()
        #expect(voice.phase == .review)
        #expect(recorder.cancelled == 1)
    }

    @Test func leavingWhileRecordingLetsItGo() async {
        let recorder = FakeRecorder()
        let voice = model(recorder)
        await voice.startRecording()
        voice.leave()
        #expect(voice.phase == .idle)
        #expect(recorder.cancelled == 1)
    }

    @Test func durationWords() {
        #expect(VoiceLimits.words(120) == "2 minutes")
        #expect(VoiceLimits.words(65) == "1 minute 5 seconds")
        #expect(VoiceLimits.words(0) == "0 seconds")
        #expect(VoiceLimits.elapsed(65) == "1:05")
    }
}
