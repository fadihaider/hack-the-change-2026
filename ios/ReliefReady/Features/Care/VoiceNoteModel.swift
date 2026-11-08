import AVFoundation
import Foundation
import Observation

// the voice note state machine (VoiceNote.tsx, recorder.ts): record to m4a, listen back, send the audio once to
// /api/stt, then check and edit the words before they are saved as a voice source. the audio is dropped as soon as a
// transcript comes back; nothing is transcribed or saved without a tap, and no transcript is ever made up here

nonisolated enum VoiceLimits {
    /// two minutes is a long voice note and stays far below the byte limit
    static let maxSeconds = 120
    /// say how much time is left once, this many seconds before the limit
    static let warnBeforeLimit = 15
    /// the server reads at most 10 MiB for the whole request; leave room for the wrapper
    static let maxAudioBytes = 10 * 1024 * 1024 - 64 * 1024
    static let maxTranscriptChars = 50_000

    /// m:ss, e.g. 65 -> "1:05"
    static func elapsed(_ seconds: Int) -> String {
        let whole = max(0, seconds)
        return "\(whole / 60):\(String(format: "%02d", whole % 60))"
    }

    /// "2 minutes", "1 minute 5 seconds", "45 seconds"
    static func words(_ seconds: Int) -> String {
        let whole = max(0, seconds)
        let minutes = whole / 60
        let rest = whole % 60
        var parts: [String] = []
        if minutes > 0 { parts.append("\(minutes) \(minutes == 1 ? "minute" : "minutes")") }
        if rest > 0 || minutes == 0 { parts.append("\(rest) \(rest == 1 ? "second" : "seconds")") }
        return parts.joined(separator: " ")
    }
}

/// why the microphone could not be used
nonisolated enum MicProblem: Error, Sendable, Hashable {
    case permissionDenied, noMicrophone, micBusy, unknown

    var message: String {
        switch self {
        case .permissionDenied:
            "Microphone access is off for ReliefReady. Turn it on in Settings, then try again, or type the note instead."
        case .noMicrophone: "No microphone was found. Connect one and try again, or type the note instead."
        case .micBusy:
            "The microphone couldn\u{2019}t start. Another app may be using it. Close that app and try again, or type the note instead."
        case .unknown: "The microphone couldn\u{2019}t start. Try again, or type the note instead."
        }
    }
}

/// a finished recording kept on this phone until it is transcribed
nonisolated struct VoiceTake: Sendable, Hashable {
    var audio: Data
    var seconds: Int
}

/// what records audio; the real one wraps AVAudioRecorder, tests use a fake
@MainActor
protocol VoiceRecorderEngine: AnyObject {
    /// asks for the microphone; false when the caregiver said no
    func requestPermission() async -> Bool
    /// starts recording; throws a MicProblem
    func start() throws(MicProblem)
    /// stops and returns the recorded m4a bytes, or nil when nothing was kept
    func stop() -> Data?
    /// stops without keeping anything
    func cancel()
    /// seconds of audio actually captured so far; nil when the engine can't say, so the wall clock is used.
    /// it stops growing while the system has paused the recording
    var recordedSeconds: TimeInterval? { get }
    /// called when the system stops the recording on its own (a call, Siri, another app taking the microphone)
    var onInterrupted: (() -> Void)? { get set }
}

extension VoiceRecorderEngine {
    var recordedSeconds: TimeInterval? { nil }
}

@Observable
final class VoiceNoteModel {
    enum Phase: Equatable {
        case idle
        case requesting
        case recording
        case stopped(VoiceTake, hitLimit: Bool)
        case transcribing(VoiceTake)
        case review
        case saving
        /// this phone or server cannot record or transcribe; typing is the only way on
        case blocked(String)
        /// something went wrong; the take is kept when the same audio can be sent again
        case error(String, VoiceTake?)
    }

    enum StopReason {
        /// Stop was tapped
        case user
        /// the two minute limit
        case time
        /// the system took the microphone (a call, Siri, an alarm)
        case interrupted
        /// ReliefReady went to the background, which stops recording
        case background

        /// what the stopped take says about how it ended; nil for a plain Stop
        var line: String? {
            switch self {
            case .user, .time: nil
            case .interrupted: "Recording stopped when another app used the microphone."
            case .background: "Recording stopped when you left ReliefReady."
            }
        }
    }

    typealias Transcribe = (Data) async throws(APIError) -> Transcript
    /// saves the confirmed words and returns a message to show here, or nil when the screen moved on
    typealias Save = (String) async -> String?

    private(set) var phase: Phase = .idle
    private(set) var elapsed = 0
    /// how the last recording ended
    private(set) var stoppedBy: StopReason = .user
    /// the transcript lives outside the phase so no error can wipe it
    var transcript: String?
    private(set) var saveError: String?
    private(set) var saveNotice: String?
    /// the last thing worth saying aloud
    private(set) var announcement: String?

    @ObservationIgnored private let engine: VoiceRecorderEngine
    @ObservationIgnored private let transcribeAudio: Transcribe
    @ObservationIgnored private let save: Save
    @ObservationIgnored private var startedAt: Date?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var warned = false
    @ObservationIgnored let maxSeconds: Int

    init(engine: VoiceRecorderEngine, maxSeconds: Int = VoiceLimits.maxSeconds, transcribe: @escaping Transcribe, save: @escaping Save) {
        self.engine = engine
        self.maxSeconds = maxSeconds
        self.transcribeAudio = transcribe
        self.save = save
        engine.onInterrupted = { [weak self] in self?.stopRecording(.interrupted) }
    }

    var isWorking: Bool {
        switch phase {
        case .transcribing, .saving: true
        default: false
        }
    }

    var isRecording: Bool {
        phase == .requesting || phase == .recording
    }

    private func say(_ text: String) {
        announcement = text
    }

    func startRecording() async {
        guard !isRecording, !isWorking else { return }
        abandon()
        saveError = nil
        saveNotice = nil
        phase = .requesting
        say("ReliefReady will ask to use the microphone.")
        let allowed = await engine.requestPermission()
        guard phase == .requesting else { return }
        guard allowed else {
            phase = .error(MicProblem.permissionDenied.message, nil)
            return
        }
        do throws(MicProblem) {
            try engine.start()
        } catch {
            phase = .error(error.message, nil)
            return
        }
        startedAt = Date()
        elapsed = 0
        warned = false
        phase = .recording
        say("Recording. Press Stop when you\u{2019}re done.")
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled else { return }
                self.tick(now: Date())
            }
        }
    }

    /// moves the clock and stops at the limit; the ticker calls it, and tests call it with a chosen time
    func tick(now: Date) {
        guard phase == .recording, let startedAt else { return }
        // the recorder's own clock, so a pause the system made never counts as recorded time
        let measured = engine.recordedSeconds ?? now.timeIntervalSince(startedAt)
        let seconds = min(maxSeconds, Int(measured))
        elapsed = seconds
        if !warned && maxSeconds - seconds <= VoiceLimits.warnBeforeLimit {
            warned = true
            say("\(VoiceLimits.words(maxSeconds - seconds)) left.")
        }
        if seconds >= maxSeconds { stopRecording(.time) }
    }

    func stopRecording(_ reason: StopReason = .user) {
        guard phase == .recording else { return }
        ticker?.cancel()
        ticker = nil
        // read before the engine stops: the recorder's clock resets once it has stopped
        let measured = engine.recordedSeconds ?? startedAt.map { Date().timeIntervalSince($0) } ?? 1
        let seconds = min(maxSeconds, max(1, Int(measured.rounded())))
        let recorded = reason == .time ? maxSeconds : seconds
        startedAt = nil
        stoppedBy = reason
        guard let audio = engine.stop(), !audio.isEmpty else {
            phase = .error("Nothing was recorded. Try again closer to the microphone, or type the note instead.", nil)
            return
        }
        guard audio.count <= VoiceLimits.maxAudioBytes else {
            phase = .error("That recording is too long to send. Record a shorter note, or type it instead.", nil)
            return
        }
        let hitLimit = reason == .time
        phase = .stopped(VoiceTake(audio: audio, seconds: recorded), hitLimit: hitLimit)
        if hitLimit {
            say("Recording stopped at the \(VoiceLimits.words(maxSeconds)) limit. Listen back, or transcribe it.")
        } else if let line = reason.line {
            say("\(line) Recorded \(VoiceLimits.words(recorded)). Listen back, or transcribe it.")
        } else {
            say("Recording stopped. Listen back, or transcribe it.")
        }
    }

    func transcribe(_ take: VoiceTake) async {
        guard !isWorking else { return }
        phase = .transcribing(take)
        say("Transcribing your recording.")
        do {
            let result = try await transcribeAudio(take.audio)
            let words = result.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !words.isEmpty else {
                phase = .error(
                    "Nothing was heard in that recording. Record again closer to the microphone, or type the note instead.", nil
                )
                return
            }
            transcript = words
            saveError = nil
            saveNotice = nil
            phase = .review
            say("Transcript ready. Check it and fix anything it misheard.")
        } catch {
            if error.isSpeechUnavailable {
                phase = .blocked(error.speechMessage)
            } else {
                phase = .error(error.speechMessage, error.canRetrySameRecording ? take : nil)
            }
        }
    }

    func confirmTranscript() async {
        guard phase == .review else { return }
        let words = (transcript ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty {
            saveError = "The transcript is empty. Add the words, or record again."
            return
        }
        if words.count > VoiceLimits.maxTranscriptChars {
            saveError = "This note is too long to check word for word. Shorten it, or split it into two notes."
            return
        }
        saveError = nil
        saveNotice = nil
        phase = .saving
        say("Reading your note.")
        let message = await save(words)
        phase = .review
        if let message {
            saveNotice = message
            say(message)
        }
    }

    func editTranscript(_ text: String) {
        transcript = text
        saveError = nil
    }

    /// back to the transcript after starting a re-record
    func backToTranscript() {
        abandon()
        phase = .review
    }

    /// leaving the panel (type instead, close): a recording in progress is let go; a transcript stays
    func leave() {
        let wasRecording = isRecording
        abandon()
        if wasRecording { phase = .idle }
    }

    private func abandon() {
        ticker?.cancel()
        ticker = nil
        startedAt = nil
        if phase == .recording || phase == .requesting { engine.cancel() }
    }
}

// MARK: - the real recorder

/// AVAudioRecorder to an m4a in the temporary folder; the file is deleted as soon as its bytes are read. a file left
/// behind by a crash or a kill mid-recording is swept at launch and whenever the voice screen opens
@MainActor
final class AudioRecorderEngine: NSObject, VoiceRecorderEngine {
    nonisolated static let filePrefix = "voice-note-"

    private var recorder: AVAudioRecorder?
    private var url: URL?
    /// the recorder's time the last time it was recording; currentTime reads 0 once the system stops it
    private var lastTime: TimeInterval = 0
    private var interruptionObserver: NSObjectProtocol?
    var onInterrupted: (() -> Void)?

    override init() {
        super.init()
        Self.sweepLeftovers()
    }

    /// deletes every leftover recording in a folder (the temporary folder by default); returns how many went
    @discardableResult
    nonisolated static func sweepLeftovers(in folder: URL = FileManager.default.temporaryDirectory) -> Int {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        var removed = 0
        for file in files where file.lastPathComponent.hasPrefix(filePrefix) && file.pathExtension == "m4a" {
            if (try? FileManager.default.removeItem(at: file)) != nil { removed += 1 }
        }
        return removed
    }

    var recordedSeconds: TimeInterval? {
        guard let recorder else { return nil }
        if recorder.isRecording { lastTime = recorder.currentTime }
        return lastTime
    }

    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start() throws(MicProblem) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker])
            try session.setActive(true)
        } catch {
            throw .micBusy
        }
        guard session.isInputAvailable else {
            Self.releaseSession()
            throw .noMicrophone
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(Self.filePrefix)\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let recorder = try AVAudioRecorder(url: file, settings: settings)
            recorder.delegate = self
            guard recorder.record(forDuration: TimeInterval(VoiceLimits.maxSeconds + 1)) else { throw MicProblem.micBusy }
            self.recorder = recorder
            url = file
            lastTime = 0
            observeInterruptions()
        } catch {
            try? FileManager.default.removeItem(at: file)
            Self.releaseSession()
            throw .micBusy
        }
    }

    func stop() -> Data? {
        recorder?.stop()
        recorder = nil
        defer { cleanUp() }
        guard let url else { return nil }
        return try? Data(contentsOf: url)
    }

    func cancel() {
        recorder?.stop()
        recorder = nil
        cleanUp()
    }

    /// a call, Siri or an alarm pauses the recorder and nothing resumes it, so the take ends there
    private func observeInterruptions() {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began else { return }
            MainActor.assumeIsolated { self?.interrupted() }
        }
    }

    private func interrupted() {
        guard recorder != nil else { return }
        _ = recordedSeconds
        onInterrupted?()
    }

    private func cleanUp() {
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        lastTime = 0
        Self.releaseSession()
    }

    /// lets go of the audio session, so music or a podcast the caregiver paused can carry on
    static func releaseSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}

extension AudioRecorderEngine: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        // a recording that ends badly (the system took the microphone) is reported; the time limit is the model's
        guard !flag else { return }
        Task { @MainActor in self.interrupted() }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: (any Error)?) {
        Task { @MainActor in self.interrupted() }
    }
}

/// "Listen back": plays the take once and lets go of the audio session when it ends, so the button turns back
/// and other apps' audio resumes
@Observable
final class ListenBackPlayer: NSObject {
    private(set) var playing = false
    @ObservationIgnored private var player: AVAudioPlayer?

    func play(_ audio: Data) {
        stop()
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        guard let player = try? AVAudioPlayer(data: audio) else {
            AudioRecorderEngine.releaseSession()
            return
        }
        player.delegate = self
        self.player = player
        playing = player.play()
        if !playing { finished() }
    }

    func stop() {
        guard player != nil || playing else { return }
        player?.stop()
        finished()
    }

    fileprivate func finished() {
        player?.delegate = nil
        player = nil
        playing = false
        AudioRecorderEngine.releaseSession()
    }
}

extension ListenBackPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        Task { @MainActor in self.finished() }
    }
}
