# Five-minute demo: Alex and Rosa

Alex is a University of Calgary student with a part-time job. Their mother Rosa is coming home after surgery, and Alex is caring for her for seven days. Alex is the caregiver and Rosa is the care recipient. Everyone and everything in this story is fictional except the public Calgary resource data.

Button and heading names below follow the current design. Care screens are being finished in this repair pass, so check any label marked "(verify)" in the browser before presenting.

## Before you start

1. Start clean. On the deployed demo, open **Demo → Reset the demo** and confirm. It deletes the care week, every message and reply, and Rosa's notes and facts, and puts the clock back. Locally you can also stop the server, run `npm run mvp:reset`, then `npm run dev`.
2. Open `http://localhost:3000` or `http://127.0.0.1:3000` in a desktop browser. Use one of these two addresses, not a LAN IP: the microphone works only there or on https.
3. Decide on voice. With `ELEVENLABS_API_KEY` in `.env.local`, the voice note is transcribed live by ElevenLabs Scribe. Without it, Care says voice notes aren't connected and offers a typed note. Use the typed note and say so. Never present typed text as a transcript.
4. Say which AI mode is running. With the default `RR_AI=demo`, suggestions and answers come from offline keyword rules, and the app labels them as demo rules. Present them that way, not as Claude. With `RR_AI=anthropic` or `RR_AI=bedrock` configured, the same steps call Claude.

## Walkthrough

### 1. Start (0:00 to 0:30)

On `/`, type the crisis in one sentence:

> My mom Rosa has hip surgery on Sunday and I’m caring for her until Saturday.

ReliefReady confirms the care window (seven days) and opens Urgent. The heading takes keyboard focus.

### 2. Urgent: one clash at a time (0:30 to 1:30)

Urgent checks Alex's calendar for the week. These are six seeded demo events, not a real calendar. It shows each clash on its own, with the reason it clashes: the ENGG 513 group project meeting, the assignment 4 deadline, the bookstore shift, the food bank shift, dinner at Lucia's, and Rosa's own follow-up appointment.

- For the group project meeting, accept the suggested decision (for example, ask to reschedule). "Change the plan" is saved on the server, so a refresh keeps it (verify).
- Open the letter. It shows the exact recipient, the exact message and what it discloses about Rosa. Health words trigger a warning. Edit a line to show that editing resets approval.
- Approve this exact message. Approval is bound to the text you saw, through a SHA-256 approval hash and a revision check. If the text changed in the meantime, approval is refused and the new preview is shown.
- Send. In demo mode it goes to the demo outbox. The screen says no real email was sent.
- Keep Rosa's follow-up appointment and add it to her care timeline.

### 3. The recipient says yes (1:30 to 2:00)

- In the top bar, open **Demo → Open the outbox**. The message is there with its reply links. This page exists only in demo mode.
- Open the Accept link. The reply page changes nothing on its own. Choose **Accept the request** to record the reply.
- Back in Urgent, "Here’s who you asked" shows the request as accepted. It changes only because the recipient clicked.

### 4. Care: a voice note about Rosa (2:00 to 3:00)

Open **Care**. Rosa's day comes first: today's schedule, the Ask bar and **Emergency / Help**.

- Choose **+ Voice note** (verify). Give consent, allow the microphone, then record something like:

  > Her spare glasses are in the top drawer of the hallway dresser. She has breakfast at 8:00 every morning. Speak slowly and face her, she reads lips a bit. She likes the radio on in the afternoon.

- Stop, then transcribe. The transcript appears for review. Fix any misheard word, then choose **Use transcript** (verify). Without a speech key, type the same text as a note instead.
- ReliefReady suggests facts. Each one quotes the exact words from the note and names its source. Nothing is saved as settled yet.
- Approve the glasses fact and the breakfast routine. Reject or edit one suggestion to show that the caregiver decides. An edit is saved as a new version, and the old wording is kept as superseded (verify).
- Optional: add a typed note that says "Breakfast at 8:30 with medication." The clash with 8:00 is shown as a conflict, and neither time wins until Alex picks one. The timeline then follows the time Alex kept.

### 5. The Care Passport and the day (3:00 to 3:30)

- Open the **Care Passport**. Approved facts sit in collapsed sections. The glasses fact is under "Practical needs & belongings", breakfast under "Daily routine", the lip-reading tip under "Communication & accessibility" and the radio under "Preferences & interests". Conflicts and unanswered questions collect under "Open questions & conflicts". Expand one to show the original wording, the source and when it was added. Suggested facts never appear as settled.
- Today's schedule shows breakfast at 8:00 with its reminder, if one was approved. Expanding it shows the exact original instruction. **Done** records that Alex marked it done; it is not a verified completion (verify).

### 6. Ask the Care Passport (3:30 to 4:00)

- Ask: **Where are her spare glasses?** The answer cites the approved glasses fact. The citation opens the exact text and its source. In demo mode the answer is labelled as demo rules.
- Ask something the passport doesn't hold, for example **What is her pharmacy’s phone number?** The answer is "Not in profile", and an open question is recorded. Nothing is invented.
- Optional: ask a question that needs medical advice, such as **Should she take more pain medicine?** ReliefReady does not advise. It points to Health Link 811, or 911 in an emergency (verify).

### 7. Help nearby, with the map right below (4:00 to 4:30)

- Open **Emergency / Help**. Call 911 and Call 811 are ordinary phone links; nothing dials by itself. Add Aunt Lucia (fictional, 403-555-0142) as a trusted contact. Only contacts Alex enters appear.
- Scroll to the nearby resources near Rosa (verify heading). Each card shows the name, type, address, straight-line distance, hours and step-free access when the source lists them (otherwise Unknown), the source and the fetch date. The map directly below plots exactly those places. Selecting a card highlights its marker, and selecting a marker brings its card into focus. Filter by service type or distance.
- Follow **Explore all Calgary access** to `/care/access` for the area comparison. The access score is a plain count of reachable services, not a prediction. Area groups compare reachability patterns and are not a ranking of care. The service-type labels come from a classifier trained on facility names, not on care quality.

### 8. Recover (4:30 to 5:00)

- Open **Recover**. The accepted request is under Handled ("Said yes"). Requests that were sent and not answered are under Waiting.
- In **Demo**, choose **Move time forward a day** until the 48-hour reply deadline passes (usually three times). Every request still unanswered moves to Needs follow-up with "No reply in time" (verify wording). Each status comes from a record: the outbox entry, a reply-link click or a passed deadline. Email replies are not read.
- Choose **Demo → Reset the demo** when you finish, so the next run starts clean.

## What to say about real and demo

- Real: request state and evidence, approval hashing, single-use reply links, the local Postgres database, the exact-quote and citation checks, the Calgary resource data with sources, and the trained Care Access artifacts.
- Demo by default: sign-in (everyone is the fictional Alex), the calendar (six seeded events), email (the demo outbox), AI (offline keyword rules unless a live provider is configured) and the movable clock.
- Live only when configured: ElevenLabs transcription, Claude or Claude on Bedrock, and the optional classifier service. If one is not configured, the app says so.

## If something goes wrong

- Every button fails: `APP_BASE_URL` is probably set to a different address than the browser's. Clear it and restart.
- Recover is crowded with old runs: stop the server and run `npm run mvp:reset`.
- The voice note says it isn't connected: no speech key is set, or the page isn't on `localhost` or `127.0.0.1`. Use the typed note.
