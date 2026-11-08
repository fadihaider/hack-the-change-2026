# ReliefReady

ReliefReady helps someone who is suddenly responsible for a loved one's care. It protects their own commitments, keeps care information organised and shareable, finds nearby Calgary support, and helps them get back to ordinary life without losing track of what is still open. The demo follows a fictional story: Alex, a University of Calgary student with a part-time job, is helping their mother Rosa for seven days after surgery. Alex is the caregiver and Rosa is the care recipient, so the Care Passport is about Rosa. Every person, address, message and document in the demo is fictional. Only the public Calgary resource data is real, and it carries its source and fetch date. ReliefReady coordinates and organises information. It does not diagnose, treat or triage.

## Run it locally

Use Node.js 22.18 or newer.

```bash
npm install            # or npm ci for an exact lockfile install
npm run dev            # binds 127.0.0.1:3000
```

Open `http://127.0.0.1:3000` (or `http://localhost:3000`). No accounts, keys or cloud services are needed. On first boot the app creates a local Postgres database (PGlite, with PostGIS, pgvector and pgcrypto) in `.data/pglite` and seeds the fictional Alex, Rosa and six calendar events.

- **`APP_BASE_URL`**: leave it blank locally. Blank means both `localhost` and `127.0.0.1` pass the same-Origin check on every POST, and response links in the demo outbox use `http://localhost:3000`. If you set it, it must match the address in your browser exactly, or every POST returns 403 `invalid_origin`. When deployed, set it to the https URL.
- **Start over**: stop the server, then run `npm run mvp:reset`. That deletes `.data/pglite` (or `RR_PGLITE_DIR`), and the next boot reseeds it. Do this before a demo so old test runs don't crowd Recover.
- **Another device on the same network**: run `RR_DEV_ORIGINS=<your LAN IP> npx next dev --hostname 0.0.0.0` and open `http://<your LAN IP>:3000` on the other device. Browsers allow the microphone only on `localhost`, `127.0.0.1` or https, so voice recording does not work over a plain-http LAN address. Typed notes still work.
- **Production build**: `npm run build`, then `npm start`.

Every setting and its default is listed in [`.env.example`](.env.example). To switch on live providers (ElevenLabs speech, Claude, Claude on Bedrock, Gemini, Google, the Supabase database, the optional ML classifier), follow [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Deployed demo

The demo runs on Vercel at https://reliefready-eight.vercel.app, with Supabase, Gemini and ElevenLabs switched on. Everyone who opens it is the fictional Alex. Paid providers normally run for the demo identity on localhost only; the deployment sets `RR_ALLOW_PAID_DEMO=on`, so every visitor shares Alex's rate limits (30 model calls per 10 minutes, 2000 per day). Pushing to `main` does not redeploy. Run `vercel deploy --prod` from a clean checkout of `main`.

## Where things are

The main navigation is **Urgent · Care · Recover**.

| Path | What it does |
|---|---|
| `/` | Start: one sentence about what happened, or resume the active care week |
| `/urgent` | Commitments that clash with the care week, one at a time: a suggested decision, the exact message, recipient and disclosure, approval, then sending. "Change the plan" is saved on the server (verify) |
| `/care` | Rosa's day: today's schedule, Ask the Care Passport, + Voice note and typed notes or PDFs, suggestions to approve, the Care Passport, Emergency / Help (911, 811, trusted contacts), and nearby resource cards with a map directly below them |
| `/care/access` | The detailed Calgary area comparison: access score, area groups and how they were made. Reached from "Explore all Calgary access" under the Care map |
| `/recover` | What happened to each request, from recorded evidence: Handled, Waiting, Needs follow-up, Not sent, New |
| `/outbox` | The demo outbox. Shown only when `RR_MAIL=outbox`. Messages land here instead of being emailed, with working reply links |
| `/r/[token]` | The recipient's reply page. Opening it changes nothing; Accept, Decline or Propose another time is a separate, deliberate click |

The Demo menu in the top bar opens the outbox and moves the demo clock. Moved time is labelled as demo time.

## What is real and what is demo

| Part | Real | Demo (the default) |
|---|---|---|
| Sign-in | Google sign-in callbacks exist and are tested, but no sign-in route is mounted yet | Everyone is the fictional Alex (`RR_AUTH=demo`) |
| AI steps (intake, conflicts, drafts, care suggestions, Ask) | Claude API (`RR_AI=anthropic`), Claude on Bedrock (`RR_AI=bedrock`), Gemini (`RR_AI=gemini`) when configured | Offline keyword rules (`RR_AI=demo`). They are labelled as demo rules, never as AI |
| Safety checks on AI output | Always real code: exact-quote checks on suggested facts, cited-fact checks on answers, health-word checks before sending, prompt-injection guards | Same |
| Email | Gmail adapter exists, but it needs Google sign-in | Demo outbox at `/outbox`. Nothing is emailed |
| Calendar | Google Calendar adapter exists, but it needs Google sign-in | Six seeded fictional events |
| Reply links | Real: single-use, hashed, expiring tokens. Status changes only when the recipient clicks | Same, used through the demo outbox |
| Approval | Real: exact text, SHA-256 approval hash and revision check (`If-Match`) | Same |
| Database | Supabase PostgreSQL with PostGIS and pgvector (`RR_DB=supabase`, `SUPABASE_DB_URL`), server-side only | Local PGlite in `.data/pglite` |
| Voice notes | ElevenLabs Scribe transcription when `ELEVENLABS_API_KEY` is set. You review and edit the transcript before it is saved | Without a key, Care says voice isn't connected and offers a typed note. Speech is never faked |
| Ask the Care Passport | Keyword retrieval over approved, current facts, with citations checked in code. Vector search as well when `RR_EMBED=gemini` or `RR_EMBED=bedrock` | Keyword retrieval; answers come from the demo rules |
| Calgary resources and map | Public data snapshots (OpenStreetMap contributors and City of Calgary open data) with source, licence and fetch date. Map markers use each listed resource's real coordinates, drawn over City community boundaries (verify) | Same data. Distances are straight lines, not travel times. Hours and step-free access are Unknown unless the source lists them |
| Care Access analysis | Trained artifacts in `ml/care_access/`, built from Statistics Canada ODHF v2 and City of Calgary data: a service-type classifier (from facility names, not care quality), KMeans area groups (not a ranking), and a plain reachability count (not a prediction). Live classification of new names needs `CARE_ACCESS_INFERENCE_URL` | The published snapshot only. No live classification |
| Emergency / Help | `tel:911` and `tel:811` links. Nothing dials by itself | Trusted contacts are only the ones you enter |
| Texts (Urgent, "Send a text") | Twilio when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` are set. You approve the exact text and number first | Texts are stored and shown as simulated. Nothing reaches a phone |
| Clock | Real time | Admins can move the demo clock to show deadlines passing |

## Checks

```bash
npm run typecheck      # TypeScript, no emit
npm test               # lib/demo and lib/frontend unit tests
npm run test:ai        # lib/ai: model steps, guards, demo rules, docs invariants
npm run test:store     # stores, rate limits, health terms, care-access engine (PGlite)
npm run test:mvp       # route modules over an in-memory PGlite runtime (tests/mvp-*.test.ts)
npm run test:speech    # speech HTTP handlers and the voice companion
```

Some older suites have no npm script. Run them directly:

```bash
node --conditions=react-server --import tsx --test tests/requests.test.ts tests/integrations.test.ts \
  tests/approval-revision.test.ts tests/request-http.test.ts tests/google-auth.test.ts
```

**End-to-end smoke test.** `scripts/mvp-smoke.ts` drives the whole flow over HTTP against a running server, so start `npm run dev` first, in demo mode:

```bash
SMOKE_BASE_URL=http://127.0.0.1:3000 npx tsx scripts/mvp-smoke.ts
```

It needs `RR_AUTH=demo`, `RR_MAIL=outbox` (it reads the outbox to find the Accept link) and an admin session (`ADMIN_EMAILS` blank, or including `alex@example.test`), because it resets and moves the demo clock. It prints one line per step and exits 1 if any step fails. It writes a new care week, requests and care sources into `.data/pglite` each run, and it resets the clock at the start and end. Run `npm run mvp:reset` (server stopped) afterwards if you want a clean demo. The default `SMOKE_BASE_URL` is `http://localhost:3000`. Pass `127.0.0.1` explicitly, because `localhost` can resolve to IPv6 while the dev server listens on IPv4 only.

## Docs

- [docs/DEMO.md](docs/DEMO.md): a five-minute walkthrough of the Alex and Rosa story.
- [docs/MVP.md](docs/MVP.md): adapters, runtime and every API route.
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): how to switch on each live provider, what failures look like, and the request, response and speech HTTP contracts.
- [docs/PRD.md](docs/PRD.md) and [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): product requirements and the implementation guide.
- [ml/care_access/README.md](ml/care_access/README.md): the Care Access data, models and their limits.

## Team

| Name | GitHub | Area |
| --- | --- | --- |
| Haris | @haris-n34 | Frontend and demo |
| Fadi | @fadihaider | AI and retrieval; data, infrastructure and deployment |
| Ali | @alimukhtarawan | Integrations and state |

## Get the code

```bash
gh repo clone fadihaider/hack-the-change-2026
cd hack-the-change-2026
npm install
```
