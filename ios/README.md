# ReliefReady for iPhone

A native SwiftUI client for the ReliefReady web app in this repo. It calls the same `/api/*` routes, so start the Next.js server first. Screens: Start, Urgent, Care, the nearby map and the Care access map, Recover, Outbox and reply links, voice notes, and Settings.

Requires Xcode 27.2 or later (iOS 26.0 minimum) and `xcodegen` (`brew install xcodegen`) if you change `project.yml`.

## Run it

### 1. Start a server

The phone reaches the Mac over Wi-Fi, so the server must listen on the LAN address. Port 3200 avoids the other dev servers on this Mac.

**Demo mode.** Demo AI rules, a throwaway database in `.data/pglite-ios`, simulated texts and no paid calls:

```
ios/scripts/demo-server.sh --reset --lan 3200
```

**Live mode.** Gemini, ElevenLabs and Twilio, from `.env.local`. Replace `<ip>` with `ipconfig getifaddr en0`:

```
APP_BASE_URL=http://<ip>:3200 RR_DEV_ORIGINS=<ip> RR_TRUSTED_LAN_HOSTS=<ip> npx next dev -H 0.0.0.0 -p 3200
```

`RR_TRUSTED_LAN_HOSTS` is a dev-only switch, ignored in production. It lets the demo identity use paid providers from the listed LAN host. While it is on, anyone on the same Wi-Fi can spend the API keys, so turn it off when you are done. With `APP_BASE_URL` set, that address is the only accepted origin, so the simulator must use it too.

For the simulator only, `ios/scripts/demo-server.sh --reset 3200` (no `--lan`) listens on `http://127.0.0.1:3200`, which is the simulator's default.

### 2. Run the app

- **Phone:** open `ios/ReliefReady.xcodeproj`, pick the iPhone and press Run. The app is signed with Fadi's free Personal Team (`766UTLLLT4`), so an install stops opening after 7 days; press Run again to renew it.
- **Simulator:** pick any iPhone simulator on iOS 26 or later.
- **Server address:** the phone defaults to `http://192.168.1.157:3200` and the simulator to `http://127.0.0.1:3200`. Change it under More > Settings, or on the "can't reach its server" screen.
- **First launch on the phone:** iOS asks for Local Network access. Allow it. If it was denied, the error screen links to Settings.

## Tests

```
cd ios && xcodegen generate
xcodebuild -project ReliefReady.xcodeproj -scheme ReliefReady -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test -only-testing:ReliefReadyTests
```

- **Unit tests (205):**
  - every real server response in `ReliefReadyTests/Fixtures` decodes;
  - every endpoint builds the exact request the server expects (Origin, Content-Type, If-Match, strict JSON keys, multipart);
  - the label and time helpers match their TypeScript originals, plus each feature's view-model logic.
- **UI tests:** each one skips unless its env var points at a reset demo server; see the header of each file in `ReliefReadyUITests/`. `DemoWalkthroughTests` drives all of `docs/DEMO.md` and saves the `screenshots/demo-*.png` set.
- **Fixtures:** `ios/scripts/capture-fixtures.sh <base-url>` re-captures them from a fresh demo server.

## Layout

- `ReliefReady/App`: the root view, tabs, `AppModel` (server, client, session, selected tab), More.
- `ReliefReady/Core`:
  - `APIClient`: one typed method per endpoint.
  - `APIError`: user messages copied from `lib/frontend/live-api.ts`.
  - `ServerConfig`.
  - `Models`: Codable mirrors of the zod schemas in `lib/frontend/*.ts`.
  - `Labels`: ports of the label and Alberta time helpers.
- `ReliefReady/Design`: the theme (the web's light palette), the bundled Figtree font (OFL), and shared components.
- `ReliefReady/Features/*`: one folder per screen area.

When an API response shape changes on the server, update the matching model in `Core/Models` and re-capture the fixtures; the decode tests catch drift.
