# Putting ReliefReady on Haris's iPhone

For Haris and Fadi, Sunday 8 November. Fadi can't come, so Haris takes Fadi's laptop. It already has Xcode 27.2, the project, and Fadi's Apple account set up for signing. Haris doesn't change any settings. He pairs his phone and presses Run. Every phone talks to the Vercel site, so nothing depends on the venue Wi-Fi.

The server address for everyone is `https://reliefready-eight.vercel.app`.

## Fadi, before you hand over the laptop

1. Try the demo sentence on Vercel. Vercel runs a build from 01:09, and the calendar fix (commit `00c3573` on `49-ios-app`) landed at 05:02. Without that fix, the scripted "hip surgery on Sunday" sentence said on a Sunday can produce a week with no clashes, and today is Sunday. On the website, choose Start a new care week and type the sentence. This replaces the shared care week everywhere. If Urgent then has nothing to ask anyone, redeploy before the laptop leaves, because the laptop holds the Vercel login. Deploy `main` with `00c3573` cherry-picked onto it. It applies cleanly. Don't deploy `49-ios-app` as it is. That branch predates the `RR_ALLOW_PAID_DEMO` switch, so Vercel would refuse Gemini calls and turn voice notes off.

2. If you want to follow along from home, point your own phone at Vercel. In the app, open More > Settings and demo. The Server address field holds the laptop's address. Delete all of it, type the Vercel address and tap Connect. Don't tap anything while the team is presenting, because every phone shares one family. If you skip this step, the app just can't connect and changes nothing.

3. Give Haris your Mac login password. Leave Xcode signed in to your Apple account.

4. Keep your phone with you. If Xcode asks Haris to sign in to your Apple account again, he'll need to call you.

5. Pack the charger.

## Haris, on Fadi's laptop

Don't change the Team or the Bundle Identifier. Fadi's account signs the app, and a free account takes 3 iPhones in total. Fadi's own phone is one, so yours and one more fit, Ali's for example.

1. Open Xcode, then open `~/hack-the-change-2026/ios/ReliefReady.xcodeproj`. File > Open Recent lists it too. Leave the git branch as it is.

2. Pair your phone. Plug it in, unlock it, tap Trust and enter the passcode. In Xcode, open the device menu at the top center of the window. If your iPhone isn't listed, choose Manage Devices… to open Device Hub. Select the iPhone, click Pair if it appears, and follow the prompts ([Apple](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)).

3. Turn on Developer Mode. Once pairing has started, the switch appears on the phone under Settings > Privacy & Security > Developer Mode. Turn it on and tap Restart. After the restart, swipe up, tap Enable and enter your passcode ([Apple](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)).

4. Pick your iPhone in the device menu and press Run, the play button at the top left, or Command-R. If Xcode shows a Register Device button, click it and press Run again. The first build takes a minute or two.

5. If the phone says Untrusted Developer, go to Settings > General > VPN & Device Management, tap the Apple Development entry under Developer App, then tap Trust. Open ReliefReady again.

6. Point the app at Vercel. It starts out aimed at Fadi's home network, which your phone can't reach.
   - If iOS asks about finding devices on your local network, either answer is fine.
   - After about 6 seconds the app shows "ReliefReady can't reach its server." Ignore the note about Local Network.
   - The Server address field holds `http://192.168.1.157:3200`. Delete all of it, type `https://reliefready-eight.vercel.app` and tap Connect.

For another phone, repeat steps 2 to 6 with that phone. The install stops opening after 7 days, which covers the demo.

### If something goes wrong

- Xcode asks for Fadi's Apple account password. Call Fadi.
- Xcode says the team has reached its device limit. Fadi's free account allows 3 iPhones, and each one counts for 7 days ([Apple](https://developer.apple.com/support/compare-memberships/)). That phone uses the website instead.
- Your phone isn't in the device menu. Unlock it, plug it in again, and make sure you tapped Trust. Then choose Manage Devices… in the device menu, or Xcode > Open Developer Tool > Device Hub.
- The app can't reach the server after you entered the Vercel address. The field has to say exactly `https://reliefready-eight.vercel.app`, with nothing left over from the old address. The project's other Vercel URLs sit behind a Vercel login and reject the app.
- Nothing works in time. Open the Vercel address in Safari and use the website. It runs the same flows on the same data.

## Before the demo

- Everyone shares one demo family. Every phone and the website use the same demo login, so they read and change the same data. Pick one person to drive.
- To start the demo from the sentence on a phone, open More > Settings and demo and choose Start a new care week. The phone only shows the start screen when no care week exists, and a new week replaces the old one for everyone.
- The demo clock under More > Settings and demo moves time for everyone, phones and website alike.
- On Vercel the AI is Gemini and voice notes go through ElevenLabs, so both are live. Texts are simulated and never reach a real phone. The first voice note asks for microphone access.
