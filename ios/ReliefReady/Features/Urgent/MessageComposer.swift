import MessageUI
import SwiftUI

/// Apple's Messages sheet with the number and words filled in. after a demo send, the owner taps Send in it and their
/// own phone delivers the text over iMessage or SMS. needs a real iPhone: the simulator cannot send texts
struct MessageComposer: UIViewControllerRepresentable {
    let phone: String
    let body: String
    var onFinish: (MessageComposeResult) -> Void

    static var canSend: Bool { MFMessageComposeViewController.canSendText() }

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let controller = MFMessageComposeViewController()
        controller.recipients = [phone]
        controller.body = body
        controller.messageComposeDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: MFMessageComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: (MessageComposeResult) -> Void

        init(onFinish: @escaping (MessageComposeResult) -> Void) {
            self.onFinish = onFinish
        }

        func messageComposeViewController(
            _ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult
        ) {
            onFinish(result)
        }
    }
}
