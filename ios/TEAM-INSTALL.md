# Putting ReliefReady on your own iPhone

For Haris and Fadi, Sunday 8 November. Haris builds the app on his own Mac with his own Apple ID, so he doesn't need Fadi's laptop. Both phones talk to the Vercel site, so nothing depends on the venue Wi-Fi or on Fadi's Mac staying awake.

The server address for everyone is `https://reliefready-eight.vercel.app`.

## Fadi

1. There's nothing to push. Branch `49-ios-app` is on GitHub and Haris already has access to the repo. Send him this file.

2. Point your own phone at Vercel too, so both phones show the same family. In the app, open More > Settings and demo. The Server address field still holds your Mac's address. Delete all of it, type the Vercel address and tap Connect.

3. Try the demo sentence on Vercel before presenting. Vercel runs a build from 01:09, and the calendar fix (commit `00c3573` on `49-ios-app`) landed at 05:02. Without that fix, the scripted "hip surgery on Sunday" sentence said on a Sunday can produce a week with no clashes, and today is Sunday.

   On the website, choose Start a new care week and type the sentence. This replaces the shared care week on the website and on every phone. If Urgent then has nothing to ask anyone, decide with Haris whether to redeploy Vercel.

   If you redeploy, deploy `main` with `00c3573` cherry-picked onto it. It applies cleanly. Don't deploy `49-ios-app` as it is. That branch predates the `RR_ALLOW_PAID_DEMO` switch, so Vercel would refuse Gemini calls and turn voice notes off.

## Haris

### What you need

- A Mac on macOS Tahoe 26.6 or later, which is the minimum for Xcode 27.2 ([Apple](https://developer.apple.com/xcode/system-requirements/)).
- Xcode 27.2. That's the version the app was built and tested with. Nobody has tried an older one.
- An iPhone on iOS 26 or later, and a cable for it.
- Your Apple ID. A free one works.

If Xcode 27.2 isn't installed yet, start that download first. It's big, and it's most of the wait.

### Steps

1. Open Xcode once. If it offers to install the iOS platform, accept. If it doesn't, and the build later complains that iOS is missing, install it from Xcode > Settings > Components. If macOS asks to install command line developer tools, accept that too.

2. Get the code into a new folder, so your normal clone and your agent's work stay untouched. Nothing else needs installing, no npm and no XcodeGen.

   ```
   gh repo clone fadihaider/hack-the-change-2026 ~/reliefready-ios -- -b 49-ios-app
   open ~/reliefready-ios/ios/ReliefReady.xcodeproj
   ```

3. Add your Apple ID in Xcode > Settings > Apple Accounts. Click + at the bottom left and sign in.

4. Pair the phone with Xcode. Plug it in, unlock it, tap Trust and enter the passcode. In Xcode, open the device menu at the top center of the window. If your iPhone isn't listed, choose Manage Devices… to open Device Hub, select the iPhone in the sidebar, click Pair if it appears, and follow the prompts ([Apple](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)).

5. Turn on Developer Mode. Once pairing has started, the switch appears on the phone under Settings > Privacy & Security > Developer Mode. Turn it on and tap Restart. After the restart, swipe up, tap Enable and enter your passcode ([Apple](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)).

6. Switch signing to your account.
   - Click the blue ReliefReady project icon at the top of the left sidebar.
   - Under Targets, pick ReliefReady and open the Signing & Capabilities tab.
   - Leave Automatically manage signing on.
   - Set Team to your name marked Personal Team.
   - Change Bundle Identifier from `com.fadihaider.reliefready` to one of your own, such as `com.harisn.reliefready`. Fadi's account owns his, so Xcode won't let anyone else use it.
   - If a Set Up Signing button appears, click it and make the same choices. If a Register Device button appears, click it.
   - Leave the two test targets alone. Run doesn't build them.

7. Pick your iPhone in the device menu and press Run, the play button at the top left, or Command-R. The first build takes a minute or two. If macOS asks to let codesign use a key in your keychain, enter your Mac login password and click Always Allow.

8. If the phone says Untrusted Developer, go to Settings > General > VPN & Device Management, tap your Apple ID under Developer App, then tap Trust. Open ReliefReady again.

9. Point the app at Vercel. It starts out aimed at Fadi's Mac, which your phone can't reach from a different Wi-Fi.
   - If iOS asks about finding devices on your local network, either answer is fine.
   - After about 6 seconds the app shows "ReliefReady can't reach its server." Ignore the note about Local Network.
   - The Server address field already holds `http://192.168.1.157:3200`. Delete all of it, type `https://reliefready-eight.vercel.app` and tap Connect.

The install stops opening after 7 days. Press Run again to renew it.

### If something goes wrong

- Signing & Capabilities says your team has no devices. That happens until the phone is paired and picked in the device menu. Finish steps 4 and 7 and it clears. Don't change the bundle identifier to fix it.
- Xcode says the bundle identifier isn't available. Somebody already owns that name, so pick a less common one. Don't keep changing it, though. A free account gets 10 App IDs and 3 devices, and each one counts against you for 7 days ([Apple](https://developer.apple.com/support/compare-memberships/)).
- Your phone isn't in the device menu. Unlock it, plug it in again, and make sure you tapped Trust. Then choose Manage Devices… in the device menu, or Xcode > Open Developer Tool > Device Hub, and follow what it says for your iPhone.
- The app can't reach the server after you entered the Vercel address. The field has to say exactly `https://reliefready-eight.vercel.app`, with nothing left over from the old address. The server only accepts requests from that address. The project's other Vercel URLs sit behind a Vercel login and reject the app.
- Xcode won't cooperate in time. Open the same address in Safari and use the website. It runs the same flows on the same data.

## Before the demo

- Everyone shares one demo family. Both phones and the website use the same demo login, so they read and change the same data. Pick one person to drive.
- To start the demo from the sentence on a phone, open More > Settings and demo and choose Start a new care week. The phone only shows the start screen when no care week exists, and a new week replaces the old one for everyone.
- The demo clock under More > Settings and demo moves time for everyone, phones and website alike.
- On Vercel the AI is Gemini and voice notes go through ElevenLabs, so both are live. Texts are simulated and never reach a real phone. The first voice note asks for microphone access.
