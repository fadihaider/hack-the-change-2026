# ReliefReady PRD

Status: draft v2, 2026-11-07. Open decisions are listed in section 13 with a default for each.
Companion doc: [IMPLEMENTATION.md](IMPLEMENTATION.md) (AWS, ElevenLabs, agents, data loading).

> **Database update (2026-11-08):** Supabase PostgreSQL replaced AWS Aurora and the RDS Data API as the cloud database. PGlite stays the offline default. The Aurora steps below are kept as history and no longer apply. Current setup: [INTEGRATIONS.md, "Turn on Supabase PostgreSQL"](INTEGRATIONS.md#turn-on-supabase-postgresql).

## 1. Summary

ReliefReady helps a person in Calgary who suddenly has to care for a family member. It does three jobs.

1. **Urgent.** It finds which commitments in the caregiver's own life are now at risk. It drafts requests to the right people and sends them only after approval. Then it tracks each answer, because a sent request is not the same as an accepted one. New caregivers also get a short, address-specific "where to start" guide.
2. **Care.** It builds a care profile for the person receiving care from voice notes, uploaded documents, typed notes and how the app gets used. It turns that profile into a timeline that shows the right instruction at the right time, and keeps the full original wording one tap away.
3. **Recover.** It lists what was handled, what is still waiting and what needs follow-up, built from the record of what actually happened. This is a baseline feature.

One line: *When someone you love suddenly needs care, ReliefReady protects the rest of your life, keeps their care consistent, and helps you come back.*

## 2. Problem fit

ReliefReady targets caregiver health, social connection and well-being in Calgary.

| Need | How ReliefReady addresses it |
|---|---|
| Caregiver stress and work-life balance | Removes the coordination load of a care crisis. The caregiver approves; the app does the drafting, tracking and reminding. |
| Connection to the caregiver's circle and local supports | Brings in the caregiver's own circle (coworkers, classmates, family) through scoped requests, and points to real Calgary supports near the care recipient. |
| Understanding care instructions | Turns discharge sheets and notes into a timed, source-linked care plan a substitute caregiver can follow. It does not interpret clinical content. |

## 3. Users and scope

- **Primary user:** someone in Calgary who has just become a caregiver for days or weeks, such as a student or employee whose parent had surgery. They may have no prior caregiving experience.
- **Secondary user:** an experienced caregiver who needs coverage or a handoff.
- **Other actors:** the care recipient, a trusted substitute, and collaborators (professor, manager, teammates, volunteer coordinator). Collaborators never log in. They only click response links.
- **Geography:** Calgary only. Resource lookups, rules and directions assume a Calgary address.

## 4. Product principles

1. **Approval first.** No message or disclosure leaves the app without an explicit approval of that exact item. The app never writes to Google Calendar.
2. **Evidence-backed states.** Every status change has evidence attached: the user's approval, a Gmail message ID, a response-link click, a manual entry by the user, a passed deadline, or an API error. The model's own text never counts as evidence.
3. **Keep the original wording.** The app shows short versions, but the full source text stays available. Extracted facts stay "suggested" until the caregiver approves them.
4. **No clinical decisions.** The app repeats medical instructions exactly as written in an approved source. It never creates, changes or interprets them. Emergencies go to 911, and health questions go to 811 Health Link.
5. **The user controls urgency.** The app never blocks or delays a contact the user starts.
6. **Fictional people, real world.** Demo personas are fictional and labelled. Calendars, sends, responses, Calgary resources and Alberta rules are real.
7. **Minimum disclosure.** Each contact group has a disclosure tier (section 5.1). By default, drafts are instructed to say "a family caregiving situation" and not to name a diagnosis, and a word-list check flags common health terms before approval. The check can miss terms, so the user reviews every draft.

## 5. Feature requirements

Priority: **P0** = must work in the demo, **P1** = should ship if P0 is done, **P2** = describe as future work only.

### 5.1 Urgent mode

| ID | Requirement | Priority |
|---|---|---|
| U1 | **Crisis intake.** The user types or speaks a statement such as "My mom has surgery Tuesday, I'm out for a week." Speech uses ElevenLabs speech-to-text. The app pulls out the date range, the care recipient's nickname, the help requested and the reason, if the user gave one. If the dates are unclear, it asks before doing anything else. The statement is not added to the care profile. | P0 |
| U2 | **Life setup by the caregiver.** The caregiver creates contact groups such as Work, School, Family and Volunteer. Each group gets members (name, email, relationship), a disclosure tier (minimal, general or detailed; see the table below) and an allowed channel. Calendar attendees can be added to groups with one tap. | P0 |
| U3 | **Impact scan.** The app reads Google Calendar events in the disruption window (read-only). Code-based rules flag overlaps and attach attendees and organizers. The model adds candidate links from each commitment to the people who depend on it, marked "unconfirmed" until the user confirms them. Each flag shows its reason. | P0 |
| U4 | **Delegation and requests.** For each affected commitment the user picks an action: notify, request reschedule, request extension, ask for coverage (hand the task to a named person), defer, or keep. Notify, request reschedule, request extension and ask for coverage each become a Request (section 8). Defer and keep are saved on the commitment and create no Request. | P0 |
| U5 | **Approval queue.** Drafts are grouped by recipient. The user sees the exact recipient, channel, subject, body, disclosure tier and response deadline. A word-list check flags health terms in the subject and body before approval. The user can approve, edit or cancel each item. Approval covers the exact recipient, subject, body and tier. Any edit needs a new approval. | P0 |
| U6 | **Execution.** Approved emails go out through Gmail (`gmail.send`) with three response links: Accept, Decline and Propose another time. Every send writes a `request_event` with `evidence_kind='gmail_message_id'` and the Gmail message ID in `evidence_ref`. Propose another time collects a date and time (date-time picker) and an optional note of up to 300 characters. It sets `request.proposed_at`, moves the request to `needs_review` and creates a commitment with `source='response'`. The note is stored as plain text, rendered only as text (no HTML or markdown), and never sent to a model step. R2 drafts receive only the proposed date and time. | P0 |
| U6b | **Deadline and expiry.** Each request has a response deadline (`respond_by`). The user can set it in the approval queue. If the user leaves it empty, it defaults to app time at send plus 48 hours. When app time (real or simulated) passes `respond_by` while the request is still `requested`, code moves it to `expired`. | P0 |
| U7 | **Follow-up nudge.** When a request expires, the app suggests a nudge for approval. It never sends a nudge on its own. | P1 |
| U8 | **New caregiver start guide.** A "first 72 hours" page built from the user's or care recipient's Calgary address and situation. Cards: (1) Alberta personal and family responsibility leave, 5 days per calendar year for employees with 90 or more days at the same employer ([Alberta](https://www.alberta.ca/personal-family-responsibility-leave)), with a draft notice to the employer. The app asks "Have you worked for this employer for 90 days or more? (yes / no / not sure)" and shows the card for yes and not sure. (2) EI caregiving benefits, shown only as "may apply if a medical doctor or nurse practitioner certifies that the person is critically ill or injured, or needs end-of-life care" ([EI caregiving benefits](https://www.canada.ca/en/services/benefits/ei/caregiving.html)). (3) The AHS Family Caregiver Centre and 811 Health Link. (4) The nearest hospital, a pharmacy open at the needed time, and the nearest transit stops. (5) Hand-picked InformAlberta supports. Every card shows its source and fetch date. | P0 |

**Disclosure tiers.** The health-term check runs on the subject and body of each draft, on every saved edit, and again at send.

| Tier | A draft may include | Health-term hit |
|---|---|---|
| minimal | "A family caregiving situation" and availability dates | Blocks approval until the user edits the draft or overrides. An override writes an audit event. |
| general | Minimal, plus the relationship ("my mother") and "recovering from a medical procedure". No condition, body part or treatment. | Same as minimal |
| detailed | General, plus the reason the user gave at intake, word for word | Warning only |

### 5.2 Care mode

| ID | Requirement | Priority |
|---|---|---|
| C1 | **Care profile made of facts.** Each fact records: category (routine, preference, communication, mobility, contacts, logistics, or medical instruction as written), exact text, source (document, page or span, voice note, note, or app-use signal), author, timestamp, status (suggested, approved, rejected, superseded or conflicting) and version. | P0 |
| C2 | **Inputs.** Voice notes go through ElevenLabs speech-to-text. Uploaded PDFs and photos go to Claude as document or image input. The caregiver can also type notes, and app-use signals count as input (see C5). | P0 voice and notes, P0 one PDF, P1 photos |
| C3 | **Care compiler.** The model extracts candidate facts and timed events. Code attaches each fact's source span and drops any fact whose text is not in the source word for word. New facts are compared with the recipient's existing facts from every source. A conflict, such as 8:00 in a voice note and 8:30 on a discharge sheet, marks both facts conflicting and keeps their items off the timeline until the caregiver picks one. The other fact becomes superseded. Photos and scanned PDFs (P1) have no text layer, so their facts stay suggested, are labelled "not text-verified" and show beside the image on the approval screen. Nothing becomes approved without a click. | P0 |
| C4 | **Care timeline.** A day view of approved timed items. Each item shows a short line and expands to the full original text. Items due within their reminder window (`remind_minutes` before `starts_at`, in app time, real or simulated) are highlighted at the top of the timeline. These reminders are in-app only and are recomputed on page load and every 30 seconds. A shift-start overview lists the day. Real-time reminders through EventBridge Scheduler are P1. | P0; Scheduler reminders P1 |
| C5 | **Personalization loop.** The app learns from use: completion times logged by whoever is caring, questions the substitute asks, and skipped items. From these it proposes profile changes, for example: "Breakfast logged at 8:20 on 4 of the last 5 days. Update the routine?" These are suggestions only. The care recipient's current wishes always override a recorded preference. | P1 |
| C6 | **Ask the care profile.** The caregiver or substitute asks a question and gets an answer drawn only from approved facts, with citations. Each cited fact's exact text shows under the answer. If a cited fact is a medical instruction, the app shows only its exact text, with no model wording, plus "For health questions call 811. Emergencies: 911." If the answer isn't in the profile, the app says so and creates an open question for the caregiver. | P0 |
| C7 | **Trusted handoff link.** A secret link for a substitute, limited to a time window, a set of fact categories and a set of timeline items, and revocable at any time. The link goes through the approval queue like any other disclosure. The substitute never sees the caregiver's work or school data. | P1 |
| C8 | **Read aloud.** ElevenLabs text-to-speech reads timeline items and answers aloud. Every voice feature also has a text equivalent. | P1 |
| C9 | **Logistics card for each care event.** For an appointment or errand, the card shows the location, the nearest transit stops, pharmacy hours and accessibility info if known ("unknown" if not), all from the Calgary data in section 6. A calendar appointment for the care recipient is suggested as keep in the impact scan and joins the timeline, with its location, through an "Add to care timeline" button. | P0 for one event |

### 5.3 Recover mode (baseline)

| ID | Requirement | Priority |
|---|---|---|
| R1 | **Return review.** Every Request is grouped by its recorded state (table below). New lists commitments created from responses. Each group is sorted by deadline. | P0 |
| R2 | **Follow-up drafts.** One-click draft follow-ups for "Needs follow-up" items. They use the same approval queue as U5. | P1 |
| R3 | **Demo clock.** An admin control moves "now" forward so the demo can show time passing honestly. A visible banner says "simulated time". Deadlines and expiry use this app time. Only admin accounts can move the clock. | P0 |

| Group | Request states |
|---|---|
| Handled | `accepted`, `completed` |
| Waiting | `requested` |
| Needs follow-up | `rejected`, `failed`, `expired`, `needs_review`, and `sending` if the send never confirmed (outcome unknown, so never shown as not sent) |
| Not sent | `draft`, `awaiting_approval`, `approved`, `cancelled` |
| New | Not a request state. Commitments with `source = 'response'`, created when a recipient proposes another time. |

## 6. Calgary location intelligence (geo-filtered retrieval)

**Requirement.** Given a Calgary address, return resources and instructions specific to that location and to the person's needs, each with a citation.

**Design.** Address similarity is not location, so a vector search alone can't answer "near this address". The pipeline is:

1. **Geocode.** Match the address against the City of Calgary Parcel Address dataset (420,684 addresses with coordinates as of 2026-11-07; [dataset](https://data.calgary.ca/d/9zvu-p8uz)). The match is exact, so the app first normalizes the address to the City's format and asks for the quadrant (NE, NW, SE or SW) if it is missing. Use Amazon Location as a fallback for addresses that still don't match.
2. **Spatial filter.** PostGIS finds resources within a radius. It also finds the community for that point. A point outside every Calgary community boundary is rejected.
3. **Need ranking.** pgvector ranks the filtered resources by similarity to the need text, for example "pharmacy open Sunday evening, wheelchair access, near transit". Transit stops are not ranked. A separate query returns the nearest stops (up to 3 within 800 m).
4. **Rule filters.** Opening hours at the needed time, and facility type.
5. **Compose.** The model writes the card using only the retrieved rows and cites row IDs. Code rejects any card that cites an ID it didn't receive. Hours and accessibility on the card come from the data row, never from model text.

**Sources (snapshot with fetch date; each row stores source, URL, licence and fetched_at):**

| Source | Used for |
|---|---|
| City of Calgary Parcel Address (`9zvu-p8uz`) | Geocoding |
| City of Calgary Community Services (`x34e-bcjz`) | Hospitals, public health clinics, social development centres, community centres, libraries |
| City of Calgary Transit Stops (`muzh-c9qc`) | Nearest active stops |
| City of Calgary Community District Boundaries (`surr-xmvs`) | Community name, and the check that a point is inside Calgary |
| Calgary Equity Index 2024 (`i6pu-a35d`) plus its census tract shapefile | Optional (P1, see D5). Neighbourhood context only. Never used to infer anything about a person. |
| OpenStreetMap (Overpass snapshot) | Pharmacies, clinics, opening hours, wheelchair tags. Must be credited on screen, linked to the [OSM copyright page](https://www.openstreetmap.org/copyright), which states the ODbL licence. |
| [StatCan Open Database of Healthcare Facilities](https://www.statcan.gc.ca/en/lode/databases/odhf) | Optional backup facility list, lowest priority. Sources collected Nov 2019 to Mar 2020, updated May to Jun 2020 for v1.1. Only 7 Calgary rows have coordinates. Open Government Licence (Canada). |
| Hand-picked: AHS Family Caregiver Centre, 811 Health Link, InformAlberta entries | Caregiver supports, entered by hand with links |
| Rules: [Alberta personal and family responsibility leave](https://www.alberta.ca/personal-family-responsibility-leave); [federal EI caregiving benefits](https://www.canada.ca/en/services/benefits/ei/caregiving.html) | Code rules, quoted from the official pages |

**Rules for this data:**
- Missing accessibility data shows as "unknown", never "not accessible".
- Never claim a provider is accepting patients.
- Never use neighbourhood statistics to say anything about a person.

## 7. Data model (entities)

User, ContactGroup, Contact, CareEpisode, CareRecipient, Commitment (from calendar, entered by hand, or created from a response), Dependency (with evidence), Request (with state), RequestEvent (each state change with its evidence), ResponseToken, CareSource (an uploaded file, voice note, note or app-use signal), CareFact (versioned), CareEvent (timed), OpenQuestion, HandoffGrant, Resource (with geography and embedding), Community (Calgary community boundary, used for the Calgary-only check), RuleCard, AuditEvent, SimClock.

Column-level schema: IMPLEMENTATION.md section 4.

## 8. Request state machine

Where possible, state names follow the [FHIR Task status codes](https://hl7.org/fhir/valueset-task-status.html) (`draft`, `requested`, `accepted`, `rejected`, `completed`, `failed`, `cancelled`). `awaiting_approval`, `approved`, `sending`, `expired` and `needs_review` are app-specific.

```
draft -> awaiting_approval -> approved -> sending -> requested -> accepted -> completed
         awaiting_approval -> cancelled
                                          sending -> failed
                                                     requested -> rejected      (Decline)
                                                     requested -> needs_review  (Propose another time; proposed_at recorded)
                                                     requested -> expired       (app time passed respond_by)
any -> needs_review   (conflicting or unclear evidence, or content changed after approval; a human resolves it)
needs_review -> awaiting_approval   (user edits or re-confirms)
needs_review -> cancelled           (user drops it)
```

Each transition writes one `request_event` row with one of these evidence kinds:

| Evidence kind | Records |
|---|---|
| `user_manual` | A user action, such as picking the action (draft to awaiting_approval), resolving a needs_review item, cancelling or marking done |
| `approval` | awaiting_approval to approved. Also approved to sending, with `evidence_ref` set to the approval event id and actor `system`. |
| `gmail_message_id` | sending to requested, with the Gmail message ID |
| `link_click` | A recipient response: accepted, rejected, or needs_review for a proposed time |
| `scheduler` | requested to expired, when app time passes `respond_by` |
| `error` | sending to failed, and approved to needs_review when the content hash does not match at send |

**Approvals are bound to content.** An approval's `evidence_ref` is a hash of the recipient email, subject, body and disclosure tier. At send, code loads these from the database, re-runs the health-term check, recomputes the hash and sends only if it matches the latest approval. Otherwise nothing is sent and the request moves to `needs_review`.

Every state change is a compare-and-set on the current state, written together with its `request_event`. A second response to the same request therefore changes nothing.

## 9. Privacy, safety and consent

- Least-privilege Google scopes: `openid email profile` for sign-in, `calendar.events.readonly` ("View events on all your calendars", [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)) and `gmail.send`. The app never writes to Google Calendar; the 6 demo events are created by hand. No inbox reading.
- Server-side authorization on every record. SQL filters every query by owner or care recipient. The model never decides who can see what.
- Handoff grants (P1) are time-limited, scoped to fact categories and timeline items, and revocable. Every substitute request re-checks the grant. An expired, revoked or not-yet-started grant returns 403.
- Health-term check on the subject and body of every outgoing message, re-run at send. It flags; it does not guarantee.
- ReliefReady never stores audio. The server forwards it to ElevenLabs and keeps only the transcript. ElevenLabs keeps request history by default, and zero-retention mode is enterprise-only, so the server deletes each transcript from ElevenLabs after use. ElevenLabs says deleted items can remain in its debugging and moderation logs, and in backups for up to 30 days. Text read aloud by text-to-speech is also sent to ElevenLabs. ([STT delete](https://elevenlabs.io/docs/api-reference/speech-to-text/delete), [zero-retention mode](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode))
- Uploaded documents are deleted from storage after 14 days. Their extracted text stays in the profile.
- Demo uses fictional personas only. Do not upload real medical records.
- No claims of HIPAA or Health Information Act compliance, data residency in Canada, or clinical safety. Claude on Bedrock runs from `ca-central-1` with Global or US routing, or from `us-east-1` as a fallback, so prompts may be processed outside Canada.
- An audit log records every approval, send, state change and grant. Request approvals, sends and state changes are `request_event` rows. Health overrides, handoff grants and demo clock moves are `audit_event` rows.
- Server logs and the audit log hold IDs, state names and error codes only. They never hold prompts, transcripts, care facts, draft text, email addresses or tokens.

## 10. Demo scenario

Fictional persona Alex, a University of Calgary student working part time. Their mom, Rosa, has day surgery and needs help at home for 7 days. Rosa's address is a real public building address in Calgary (see decision D3).

1. Alex says the crisis statement (U1). The app asks one clarifying question about the end date.
2. The impact scan finds 6 hand-made events in the test Google Calendar: a group project meeting, an assignment deadline, a work shift, a volunteer shift, a family dinner and Rosa's follow-up appointment. It shows the dependency link from the meeting to the teammates (U3).
3. The start guide shows the Alberta leave rule with a draft notice for the work shift, plus nearby supports for Rosa's address (U8).
4. Approval queue. Alex edits the work draft to add "after her hip replacement". The check flags it for the minimal tier and blocks approval. Alex removes it and approves (U5).
5. Real sends go to teammates' inboxes. One teammate clicks Accept, another clicks Decline, and a third clicks Propose another time (U6).
6. Care mode: Alex records a voice note about Rosa's routine and uploads a fictional discharge sheet. The compiler flags a time conflict between the two sources, and Alex resolves it (C2, C3). The timeline shows tomorrow. Rosa's follow-up appointment, added from the calendar, has a logistics card (C4, C9).
7. Ask the profile: "Where are her spare glasses?" The app answers "Not in profile" and creates an open question (C6).
8. The demo clock jumps 7 days, and requests still waiting past their deadline become expired (R3, U6b). The return review shows Handled (the Accept), Waiting (one request whose deadline was set more than 7 days out in the approval queue), Needs follow-up (the Decline, the expired requests and the proposed time) and New (the proposed time) (R1).

## 11. Acceptance tests

Tests for a P1 requirement run only if that requirement ships.

| Test | Expected | Priority |
|---|---|---|
| Statement without dates | The app asks for dates. It makes no scan or drafts yet. | P0 |
| User cancels a draft | Nothing is sent. Request becomes `cancelled` and a `request_event` row with `user_manual` evidence is written. | P0 |
| Content changed after approval | Nothing is sent. Request becomes `needs_review`. | P0 |
| Gmail send fails (revoked token) | Request becomes `failed` with the error shown. It is not shown as sent. | P0 |
| Sent, no click before the deadline | Request becomes `expired`. It appears under Needs follow-up and is never shown as Handled. | P0 |
| Recipient clicks Decline | Request becomes `rejected`. Recover lists it under Needs follow-up. | P0 |
| Recipient proposes another time | Request becomes `needs_review` with `proposed_at` stored. Recover lists it under Needs follow-up and the proposed time under New. | P0 |
| Any second response to the same request (same or different link) | Shows the first recorded answer. No second transition. | P0 |
| Draft contains "hip replacement" with the minimal tier | The draft is flagged and cannot be approved without an edit or override. | P0 |
| Two sources disagree on a time | Both are kept and marked conflicting. Neither appears on the timeline until resolved. | P0 |
| Question not answerable from approved facts | The answer is "not in profile" and an OpenQuestion is created. | P0 |
| Handoff link after expiry or revocation | Returns 403. | P1 (C7) |
| Address outside Calgary | The app says Calgary only and asks for a Calgary address. | P0 |
| Pharmacy with no wheelchair tag | The card shows "accessibility unknown". | P0 |
| Recover opened before any responses | Shows only recorded states. Nothing is shown as resolved. | P0 |

## 12. Out of scope

Real medical records, electronic health record sync, clinical advice, medication schedules generated by the model, ER wait-time routing, inbox reading, writing to Google Calendar, calendar invite responses as evidence, SMS, multiple calendar providers, an open-ended autonomous agent, hardware, and any city other than Calgary.

## 13. Open decisions (defaults apply if nobody objects)

| # | Decision | Default |
|---|---|---|
| D1 | Claude model | Claude Opus 5.5 on Bedrock at low or medium effort. Switching high-volume steps to Haiku 5.5 to save budget is the team's call. |
| D2 | Email channel | Gmail `gmail.send` from the test account. No backup channel: a failed send moves the request to `failed` (section 11), and the demo uses the labelled test mode (IMPLEMENTATION section 15). |
| D3 | Persona address | A real public building address in a community with a high share of seniors living alone, never a private home |
| D4 | Substitute handoff (C7) | P1, built only after the P0 list passes |
| D5 | Equity Index map | Pitch slide only, after freeze. Loading the Equity Index is optional (P1). No P0 feature uses it, including geocoding and the community lookup. |
| D6 | Cut line if behind | At the Sat 23:00 gate, if one real email with a working Accept link is not done, U8 and C9 fall back to static curated cards and the Amazon Location fallback moves to P1. Scheduler reminders, the Equity Index and the ODHF loader are already P1 or optional. The team lead decides. |

## 14. Timeline in Alberta Time (UTC-6)

Alberta stopped changing clocks on 2026-11-01 and now uses Alberta Time (ABT, UTC-6) all year ([Alberta](https://www.alberta.ca/albertas-new-time-system-abt)). The Sun 11:30 deadline is 17:30 UTC.

| By | Milestone |
|---|---|
| Sat 18:00 | Setup gate: Bedrock smoke test passes, Aurora running with extensions, Google OAuth lists test-calendar events, Amplify skeleton deployed |
| Sat 23:00 | U1 to U6 plus U6b working end to end, with one real email and working response links; geo query returns cards. Cut-line gate (D6). |
| Sun 03:00 | C1 to C4, C6, C9 (one event), U8, R1 and R3 working |
| Sun 06:30 | P1 items if green; acceptance tests in section 11 pass (skip tests for P1 features that were not built) |
| Sun 08:00 | **Feature freeze.** Only bug fixes after this. |
| Sun 10:00 | Demo video recorded, Devpost draft complete |
| Sun 11:30 | Submission deadline (17:30 UTC) |
