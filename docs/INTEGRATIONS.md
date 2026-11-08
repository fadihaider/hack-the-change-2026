# Integrations

Everything runs locally with no credentials: demo sign-in, offline demo rules, the demo outbox, seeded calendar events and PGlite. This page says how to switch each live provider on, how to check it is really handling requests, and what each failure looks like. The second half holds the detailed HTTP and store contracts.

Items marked "(verify)" describe behaviour being added in the current repair pass; check them against the code after merge. An integration counts as working only after a real request has gone through it. Until then the app must keep saying it is demo or not connected.

## Status

| Integration | Switch | State in this repo | Run live here? |
|---|---|---|---|
| Speech-to-text (ElevenLabs Scribe v2) | `ELEVENLABS_API_KEY` | Adapter, HTTP handlers and quota exist. `/api/stt` and `/api/tts` are mounted (verify) | No live call yet |
| Hosted voice companion (ElevenLabs agent) | `RR_VOICE_AGENT=on` | Optional `/voice` page; the session route returns 404 unless switched on (verify) | No conversation yet |
| Claude API | `RR_AI=anthropic`, `ANTHROPIC_API_KEY` | Adapter exists (`lib/ai/anthropic.ts`, model `claude-opus-5-5`) | Not in this pass |
| Claude on Amazon Bedrock | `RR_AI=bedrock`, `BEDROCK_REGION`, `BEDROCK_MODEL_ID` | Adapter exists (`lib/ai/bedrock.ts`) | Not in this pass |
| Gemini | `RR_AI=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL` | Being added (verify) | No |
| Fact embeddings (Titan V2) | `RR_EMBED=bedrock` | Being added; keyword retrieval stays the default (verify) | No |
| Google sign-in | `RR_AUTH=google` | Callbacks are tested (`lib/auth/google.ts`), but no sign-in route is mounted. The adapter returns no user, so every API call is 401 | No |
| Gmail send | `RR_MAIL=gmail` | Adapter exists (`lib/google.ts`). Needs Google sign-in | No |
| Google Calendar read | `RR_CALENDAR=google` | Adapter exists (`lib/google.ts`). Needs Google sign-in | No |
| Supabase PostgreSQL (cloud database) | `RR_DB=supabase`, `SUPABASE_DB_URL` | Adapter in `lib/supabase/database.ts`. Boot creates the schema, seeds the demo and loads the Calgary data on an empty project | Yes, 2026-11-08: `npm run db:verify` (8 checks) and `scripts/mvp-smoke.ts` (all steps) passed on Supabase |
| SMS (Urgent "Send a text") | `RR_SMS`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `DEMO_SMS_TO` | Twilio and demo adapters (`lib/sms/*`), draft by the `RR_AI` model | Partly, 2026-11-08: Gemini drafts, approval, duplicate-click guard and Twilio's error path verified; a delivered text still needs a trial number assigned to the test phone |
| Care Access classifier service | `CARE_ACCESS_INFERENCE_URL` | Optional Python service in `ml/care_access` | No |

`GET /api/session` returns only mode words and `providers:{speech:"elevenlabs"|"off", retrieval:"keyword"|"vector"}`. It never returns keys, connection strings or tokens. Secrets stay in `.env.local` (git-ignored) locally, or in the host's secret store when deployed.

Paid providers have one shared gate (`paidProvidersAllowed` in `lib/mvp/auth.ts`). With `RR_AUTH=demo`, model and speech calls are allowed only when the base URL is plain http on `localhost` or `127.0.0.1`. A deployed origin needs a verified owner (`RR_AUTH=google`), so a public demo can't spend credits for strangers. Every model and speech call reserves quota first (`lib/rateLimit.ts`). Model steps allow 30 calls per 10 minutes per user, with a daily global limit. Voice allows 30 calls per 10 minutes per user, shared by STT and TTS.

### Common failures

| What you see | HTTP and code | Usual cause |
|---|---|---|
| Every button fails with a same-address message | 403 `invalid_origin` | `APP_BASE_URL` names a different host than the one in the address bar. Leave it blank locally |
| Every screen is signed out | 401 `unauthenticated` | `RR_AUTH=google` (stub), or the demo user is missing from the database (migrated with `--no-seed`) |
| A live AI or voice action refuses | 403 `verified_owner_required` | A paid provider on a non-local base URL with demo sign-in |
| A message asking you to wait and try again | 429 `rate_limited` with `Retry-After` | The per-user quota was used up |
| A model step fails | 503 `model_unavailable` | Missing or wrong key, no model access, or a network or provider error. The provider's message is never shown or logged |
| A model answer is held back | 422 `model_needs_review` | The model refused, hit max tokens, or returned output that failed the schema or code guards |
| A feature says it isn't set up | 503 `not_configured` | An adapter was picked without its settings, for example `RR_DB=supabase` without `SUPABASE_DB_URL`, or `RR_MAIL=gmail` without Google client settings |
| Anything else | 503 `temporarily_unavailable` | An unexpected error. The server log shows only the error name and a safe code |

Set `RR_DB_DEBUG=1` to print the Postgres message for database errors on the local console.

## Turn on live speech (ElevenLabs)

1. Get an ElevenLabs API key that can use speech-to-text (and text-to-speech if you want read-aloud), on an account with credit.
2. Add `ELEVENLABS_API_KEY=<key>` to `.env.local`. `ELEVENLABS_VOICE_ID` is optional (blank means the stock voice in `lib/speech/runtime.ts`).
3. Keep `RR_AUTH=demo` and leave `APP_BASE_URL` blank, or set it to `http://localhost:3000` or `http://127.0.0.1:3000`. Restart `npm run dev`.
4. Check: `GET /api/session` should return `providers.speech: "elevenlabs"`. If it says `"off"`, the key is missing or the base URL is not local.
5. Open `http://localhost:3000/care` or `http://127.0.0.1:3000/care`. Browsers block the microphone on plain-http LAN addresses. Choose **+ Voice note**, give consent, allow the microphone, record, stop, then transcribe. Edit the transcript and choose **Use transcript** (verify labels). The confirmed text is saved as a `voice` source through `POST /api/care/sources`, and the suggested facts appear for approval.
6. The panel credits ElevenLabs only after `/api/stt` returned 200 (verify). Raw audio stays in memory only. The provider transcript is deleted before the text comes back. Deleting a transcript is not the same as zero retention of every provider log.

What failure looks like:

| What you see | Code |
|---|---|
| Care says voice notes aren't connected and offers a typed note | `providers.speech` is `off`; a direct call returns 503 `speech_not_configured` |
| The microphone prompt was blocked or dismissed | No upload happens; the panel explains the permission and offers the typed note |
| Transcription isn't available right now | 503 `speech_access_denied` (the key lacks permission or credit) or 502 `speech_provider_failed` |
| The transcript is withheld | 502 `speech_cleanup_failed`: the provider transcript could not be deleted, so the text is not released |
| The recording is too large | 413 `payload_too_large` (over 10 MiB on the wire) |
| The format is wrong | 415 `unsupported_media_type` or 400 `invalid_audio` |
| Too many tries | 429 `rate_limited` or `speech_rate_limited` |

The optional hosted companion on `/voice` also needs `RR_VOICE_AGENT=on`. `ELEVENLABS_AGENT_ID` overrides the provisioned private agent. See docs/ELEVENLABS_AGENT.md.

## Turn on Claude (Anthropic API)

1. Add `RR_AI=anthropic` and `ANTHROPIC_API_KEY=<key>` to `.env.local`. The SDK reads the key from the environment. The model is fixed in code as `claude-opus-5-5` (`lib/ai/anthropic.ts`).
2. Keep a local base URL (see the speech steps above), or use Google sign-in when deployed.
3. Restart and run an intake from `/`. `GET /api/session` shows `mode.ai: "anthropic"`, and Ask answers carry `answeredBy: "anthropic"` (verify).

Failures: a missing or wrong key, no credit or an outage gives 503 `model_unavailable`. A refusal, or a reply that fails validation, gives 422 `model_needs_review`. Nothing silently falls back to demo rules.

## Turn on Claude on Amazon Bedrock

1. Use the project Region `us-east-2`. Set `RR_AI=bedrock`, `BEDROCK_REGION=us-east-2` and `BEDROCK_MODEL_ID=us.anthropic.claude-opus-5-5` (the default in `.env.example`).
2. Give the server AWS credentials through the default chain, for example `AWS_PROFILE=<profile>` in the shell that runs `npm run dev`. Never put access keys in `.env.example`.
3. The identity needs `bedrock:InvokeModel` for that model or inference profile, and model access must be enabled for the account.
4. Restart and run an intake from `/`. With the server stopped, `AWS_PROFILE=<profile> BEDROCK_REGION=us-east-2 npx tsx --conditions=react-server scripts/ai-live-fixtures.ts` checks A1 and A4 against the fictional fixtures.

Failures: missing credentials, access denied, a model that isn't enabled, or throttling all give 503 `model_unavailable`. Only the status and error code are kept, never the provider message.

## Turn on Gemini (verify)

Being added by the AI integration. Expected settings: `RR_AI=gemini`, `GEMINI_API_KEY=<key>`, and optionally `GEMINI_MODEL`. Ask answers would then carry `answeredBy: "gemini"`. Confirm the names in `lib/ai/provider.ts` before relying on this section. Failures should map to the same `model_unavailable` and `model_needs_review` codes as the other providers.

## Turn on fact embeddings (verify)

`RR_EMBED=bedrock` adds pgvector search over the approved, current facts of the owner's care recipient. It uses Amazon Titan Text Embeddings V2 (1024 dimensions) in `EMBED_REGION` (blank means `BEDROCK_REGION`); `EMBED_MODEL_ID` overrides the model. The identity needs `bedrock:InvokeModel` on `amazon.titan-embed-text-v2:0`. Personal care facts and public Calgary resource data are indexed and searched separately. Changing an approved fact makes its old vector unusable. If embedding fails, Ask falls back to keyword retrieval and reports `retrieval.method: "keyword"`. `GET /api/session` reports `providers.retrieval: "vector"` only when embeddings are on.

## Turn on Google sign-in, Gmail and Calendar

Status: not usable end to end yet. `lib/auth/google.ts` has tested NextAuth v4 callbacks, but no `/api/auth/[...nextauth]` route or server-session lookup is mounted, and `createGoogleAuth()` in `lib/mvp/auth.ts` returns no user. With `RR_AUTH=google`, every API call returns 401 `unauthenticated`.

When the sign-in route lands, the steps are:

1. In a Google Cloud project, configure the OAuth consent screen (testing mode with named test users is enough for a demo) and create a Web OAuth client.
2. Add the redirect URI `<APP_BASE_URL>/api/auth/callback/google` (the NextAuth v4 default; verify against the route when it lands).
3. Request exactly the scopes in `lib/google.ts`: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/calendar.events.readonly` and `https://www.googleapis.com/auth/gmail.send`. A partial grant is refused at sign-in.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ENC_KEY` (the key for AES-256-GCM encryption of stored refresh tokens), `AUTH_SECRET`, and `NEXTAUTH_URL` equal to `APP_BASE_URL`.
5. Set `RR_AUTH=google`, then `RR_MAIL=gmail` and `RR_CALENDAR=google`.

Failures: `RR_MAIL=gmail` or `RR_CALENDAR=google` without the client settings or `APP_ENC_KEY` gives 503 `not_configured`. A revoked or missing refresh token gives `google_reauth_required`. A failed send is recorded as `failed` on the request and shown as failed. It is never retried automatically. An uncertain outcome stays `sending`, so it can be checked before anything is sent again.

## Turn on Supabase PostgreSQL

Supabase is the cloud database. PGlite (`RR_DB=pglite`, the default) stays for offline work and tests. Both run the same SQL, so stores and routes don't change.

1. In the Supabase dashboard, open **Connect** and copy the **Session pooler** URI. It has the form `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` and works on IPv4 networks. URL-encode any special characters in the password (`%` becomes `%25`, `?` becomes `%3F`). Use the transaction pooler (port 6543) only for serverless hosts.
2. In `.env.local`, set `RR_DB=supabase` and `SUPABASE_DB_URL=<that URI>`. For deployment, put both in the host's secret store. Never use a `NEXT_PUBLIC_` name: the URL carries the database password.
3. Optional, recommended when deployed: download the CA certificate from **Database Settings → SSL Configuration** and set `SUPABASE_DB_CA_CERT` to the file path or the PEM text. With it, TLS checks the CA and the hostname. Without it, the connection is still encrypted, but the server certificate isn't checked, and the server logs a warning once.
4. Run `npm run db:migrate`. On an empty project it installs `postgis`, `vector` and `pgcrypto` in the `extensions` schema (`db/supabase-extensions.sql`). Then it applies `db/schema.sql` and `db/mvp.sql`, seeds the fictional Alex and Rosa, and loads the Calgary snapshots (resources, community boundaries, rule cards). It finishes by printing the extensions, the access check and row counts. Add `--no-seed` to skip the demo persona and the Calgary data. The app runs the same migration on its first database call, so this step is optional.
5. Optional: `npm run db:copy-local -- --yes` copies every row of the local PGlite database (`.data/pglite`) into Supabase and replaces what's there. Stop any dev server using that PGlite folder first.
6. Run `npm run db:verify` to check the stores end to end. It uses fictional rows, deletes them afterwards and resets the demo clock.

Access control: the app never uses the Supabase Data API, the anon key or the service-role key. Every query runs on the server over `SUPABASE_DB_URL` as the `postgres` role. Each boot runs `db/supabase-security.sql`, which revokes every grant the `anon` and `authenticated` roles have in `public` (including default privileges for new tables) and sets `sim_now` to `security_invoker`. Boot also enables row level security, with no policies, on every table in `public`. `npm run db:migrate` fails if any table is left reachable.

Failures: no `SUPABASE_DB_URL` gives 503 `not_configured`. An unreachable host or a wrong password becomes `supabase_unavailable` inside the server. Postgres errors become `pg_<sqlstate>` codes inside the server. Both show as 503 `temporarily_unavailable` in the browser. Set `RR_DB_DEBUG=1` to print the Postgres message on the server console.

## Turn on SMS (Twilio)

Urgent's summary ("Here's who you asked") has a **Send a text** button. The sheet takes a recipient (the test phone from `DEMO_SMS_TO`, a saved care contact with a phone, or a typed North American number), a "sign it as" name, what they should know, and a disclosure tier. The `RR_AI` model writes a draft (`lib/ai/smsDrafter.ts`; the intake reason reaches it only at the detailed tier). The owner edits the draft, ticks "I approve sending exactly this text to …", and presses **Send SMS**.

A text is a `request` row with `channel = 'sms'` and no contact. It uses the same state machine and `request_event` evidence as email. The email queries join `contact`, so they never see SMS rows.

- **Approve:** `POST /api/sms` needs `approved: true`. It saves the exact words and number and records an `approval` event whose hash covers `sms:<number>`, the text and the tier. Health words at the minimal or general tier need an explicit "send it with these words". A repeated click with the same `clientKey` returns the same row.
- **Send:** `POST /api/sms/send` moves approved → sending under a row lock, so a second click gets 409 `state_conflict`. Twilio's message SID is recorded as `sms_message_sid` evidence, and the request moves to `requested`, shown as "Submitted".
- **Status:** `GET /api/sms` asks Twilio for the current status of any text still moving (`GET Messages/{Sid}.json`) and records each change as `sms_status` evidence. `sent` shows "Sent to carrier". `delivered` moves the request to `completed` ("Delivered"). `undelivered` or `failed` moves it to `failed`, keeping only the numeric error code. The summary asks again every 4 seconds for up to 3 minutes while a text is moving. Status callbacks aren't used, because they need a public URL.
- **Uncertain sends:** a timeout or dropped connection leaves the request in `sending` as "Not confirmed". It is never re-sent automatically.
- **Limits:** 10 texts per user per hour (`LIMITS.smsPerUser`). Real texts need a verified owner unless the app runs on localhost.

Setup:

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PHONE_NUMBER` in `.env.local`, plus `DEMO_SMS_TO` for the test phone. Blank `RR_SMS` then picks Twilio.
2. On a trial account: verify the recipient in the Twilio Console (**Messaging → Try it out → Send an SMS**). Set `TWILIO_PHONE_NUMBER` to the trial number Twilio assigns to that recipient. Any other From number fails with 572002. Twilio limits trial texts to verified recipients in the sign-up country.

Without Twilio settings (or with `RR_SMS=demo`), texts go to `sms_outbox`. They show at `/outbox` under "Simulated texts", and in Urgent as "Simulated · not delivered".

## Turn on the Care Access classifier (optional)

The Care page and `/care/access` never need this. It only sorts new resource names into service types. It does not rate care quality.

```bash
python3 -m venv .venv-care-access
.venv-care-access/bin/pip install -r ml/care_access/requirements.txt
.venv-care-access/bin/python -m ml.care_access.inference --port 8091
```

Then set `CARE_ACCESS_INFERENCE_URL=http://127.0.0.1:8091/classify` in `.env.local`, plus `CARE_ACCESS_INFERENCE_TOKEN` if the service requires a bearer token. Both stay server-side. The service loads the saved classifier once and never trains on requests. `ml/care_access/README.md` covers the optional Lambda and S3 hooks (`CARE_ACCESS_MODEL_PATH`, `CARE_ACCESS_MODEL_BUCKET`, `CARE_ACCESS_MODEL_KEY`).

Failures: `POST /api/care-access/classify` returns 503 `classifier_not_configured` when the URL is unset, and 503 `classifier_unavailable` when the service fails, times out (5 seconds) or returns an invalid shape. Input outside 1 to 20 texts of at most 2,000 characters is 400 `invalid_input`.

---

# Contracts

## Store boundary

Implemented in `lib/store/workflowStore.ts` and `lib/store/requestQueue.ts`; the same SQL runs on PGlite and on Supabase Postgres. They implement `WorkflowStore` from `lib/requests/workflow.ts`, and the rules below still apply to any change.

Both methods must serialize changes using a transaction and a lock on the same
request row. Commit or roll back state, request_event, tokens and proposals
together. `transition` is a compare-and-set, writes one evidence row, and returns
false if the expected state no longer matches.

- `withOwnedRequest`: load the request for the authenticated owner, join contact
  through its group owner, and load the latest approval event. Map stored draft
  subject/body, contact email and disclosure tier to `RequestRecord`. Cross-owner
  lookups throw `WorkflowError("not_found")`. Editing routes must use the same row
  lock and only allow the editable states in IMPLEMENTATION section 4.
- `withResponseToken`: look up the SHA-256 hash, check expiry with real SQL `now()`
  and lock the request. Used tokens remain readable until expiry so a repeated
  response shows the first state without another transition. The link fixes the
  choice; clients cannot supply it. `consumeAllTokens` marks every token for that
  request used. `saveProposal` updates proposed_at/proposed_note and inserts the
  response commitment in this transaction, with its original owner and episode.
- Use `sim_now` for app deadlines and expiry sweeps. Link expiry uses real time.
  Keep `respond_by` when already set. `sending -> requested` receives the exact
  default deadline used when generating the response tokens.

Never wire a memory store to live Gmail. The fixture store in tests is only for
workflow checks. If Gmail succeeded but the final DB write fails, the request
stays `sending` for reconciliation; do not automatically send again.

## Send, response and speech HTTP contract

These routes are mounted: `app/api/requests/send/route.ts`, `app/r/[token]/page.tsx`, `app/api/responses/[token]/route.ts`, and the speech routes `app/api/stt/route.ts` and `app/api/tts/route.ts` (verify the speech routes after merge).

| Endpoint | Input | Success | Access |
|---|---|---|---|
| `POST /api/requests/send` | JSON `{requestId}` only | `{state:"requested",messageId}`; or `{state:"failed",errorCode}`; or `{state:"needs_review"}` | Owner session (`RR_AUTH`) plus same Origin |
| `GET /r/[token]` | Token in URL | Plain-text request preview and confirm button; no state mutation | Unexpired response token |
| `POST /api/responses/[token]` | Empty JSON for Accept/Decline; `{proposal:{at,note?}}` for Propose | `{state,recorded}`; repeats return the first state and `recorded:false` | Unexpired token plus same Origin |
| `POST /api/stt` | Exactly one multipart `file`; total request at most 10 MiB including multipart overhead | JSON `{transcript}` | Owner session plus same Origin |
| `POST /api/tts` | JSON `{text}` | Audio bytes, `Content-Type: audio/mpeg` | Owner session plus same Origin |

Proposal `at` must be an ISO time with `Z` or an explicit numeric offset. Notes
are plain text, at most 300 characters, and never become model input. Invalid
tokens and ownership failures return 404; invalid input 400; invalid Origin 403;
state conflicts 409. Provider failures must not expose provider response bodies.
Keep all existing mock UI results labelled test mode until the live path passes.

### Send and response HTTP boundary

`createRequestHttpHandlers` in `lib/requests/http.ts` supplies `send`, `preview`
and `confirm` functions taking standard `Request` objects and returning
`Response` objects. The Next.js routes listed above compose it with the
durable `WorkflowStore`, the real Google transport, Fadi's health-term checker,
an owner-scoped app-clock reader, and a verified server-session resolver returning
`{userId}` or null. It supplies no memory store, permissive checker or mock send.
Google sign-in (`RR_AUTH=google`) is the remaining piece of root auth.

Send accepts only POST JSON `{requestId}` (1 to 128 letters, digits, hyphens or
underscores); it gets the owner from the session and all message content from the
store. Recipient confirmation accepts only POST JSON `{}` or
`{proposal:{at,note?}}`, with the choice fixed by the stored token. A proposal on
an unanswered Accept/Decline token is rejected. Proposal dates must be valid ISO
date-times with `Z` or an explicit offset; notes permit at most 300 Unicode
characters. Both POSTs check Origin before reading the body or entering storage.
Recipient confirmation uses the bearer token without requiring an owner login.

The body reader enforces a 4 KiB limit on actual bytes, including streamed bodies
with a missing or false Content-Length. Malformed JSON/UTF-8 and unknown fields
return 400 `invalid_input`; oversized bodies return 413 `payload_too_large`;
non-JSON media types return 415 `unsupported_media_type`; wrong methods return
405 `method_not_allowed` with Allow. Missing owner identity returns 401
`unauthenticated`. Workflow failures retain their fixed codes and 400/403/404/409
statuses. Unexpected auth/storage/provider errors return only 503
`temporarily_unavailable`; diagnostic messages and bodies are neither returned
nor logged. A recorded Gmail failure or health-review result is still an HTTP
200 outcome, exactly as in the table above. No handler retries a send.

`preview(GET, token)` reads the unexpired token through `withResponseToken` and
returns only `{request:{subject,body,state,choice,respondBy}}`. It never calls a
transition, consumes tokens, or writes evidence. The eventual `/r/[token]` page
must render those fields as plain text and require a separate explicit POST to
confirm; a GET, including an email scanner's prefetch, cannot confirm a response.
The JSON preview is an internal page-data boundary, not a new public endpoint.
Every success/error response sets `Cache-Control:no-store`,
`Referrer-Policy:no-referrer` and `X-Content-Type-Options:nosniff`, and grants no
cross-origin access. Preserve equivalent headers on the eventual HTML page and
exclude response-token URLs from access/analytics logs.

The HTTP fixtures exercise the real workflow services with fictional in-memory
storage and an intercepted Gmail transport. They establish no live send, real
SQL transaction/locking, protected deployed route, or rendered landing-page result.

## Approval queue and clock contract

Mounted under `app/api/requests/**` and `app/api/clock/**`.

Request reads return this owner-only shape. Timestamps are ISO UTC strings or
null; event ids are strings (the database uses bigint). Tokens, refresh tokens,
care facts and medical source text are never included.

```ts
type RequestView = {
  id: string;
  revision: string; // opaque SHA-256 preview revision, 64 lowercase hex characters
  state: RequestState;
  action: "notify" | "reschedule" | "extension" | "coverage";
  recipient: { contactId: string; name: string; email: string };
  subject: string;
  body: string;
  disclosureTier: "minimal" | "general" | "detailed";
  healthTermsFound: string[];
  healthOverride: boolean;
  respondBy: string | null;
  proposedAt: string | null;
  proposedNote: string | null;
  approval: { id: string; hash: string; at: string } | null;
  evidence: Array<{
    id: string;
    fromState: RequestState | null;
    toState: RequestState;
    evidenceKind: EvidenceKind;
    evidenceRef: string | null;
    actor: string;
    at: string;
  }>;
};
```

| Endpoint | Input | Success |
|---|---|---|
| `GET /api/requests` | No body | `{requests: RequestView[], appNow: string}` |
| `GET /api/requests/[id]` | Owner's request id | `{request: RequestView, appNow: string}` |
| `POST /api/requests/edit` | `{requestId, subject?, body?, contactId?, respondBy?}` | `{request: RequestView}` in `awaiting_approval`, with `healthOverride:false` |
| `POST /api/requests/approve` | `{requestId, healthOverride?: boolean}` plus `If-Match: "<revision>"` | `{request: RequestView}` in `approved`; or HTTP 422 with `{error:{code:"health_terms",terms:string[]}}` |
| `POST /api/requests/cancel` | `{requestId}` | `{request: RequestView}` in `cancelled` |
| `POST /api/requests/refresh` | Empty JSON | `{requests: RequestView[], appNow: string, expiredRequestIds:string[]}` after the owner-scoped expiry sweep |
| `GET /api/clock` | No body | `{appNow:string, realNow:string, offsetMilliseconds:number}` |
| `POST /api/clock/jump` | `{days: number}` (positive integer) | `{appNow:string, realNow:string, offsetMilliseconds:number, expiredRequestIds:string[]}` after audited clock jump and in-process expiry sweep |
| `POST /api/clock/reset` | `{}` | `{appNow:string, realNow:string, offsetMilliseconds:number}` with the offset back to 0 |
| `POST /api/demo/reset` | `{}` | `{reset:true}` after clearing the demo run and resetting the clock. Admin and `RR_AUTH=demo` only |

All these routes require an owner session. POSTs require matching Origin; clock
jump and reset additionally require an admin: the session email in ADMIN_EMAILS,
or the demo user when that list is empty and `RR_AUTH=demo`. GETs do not write
state. Recover calls `POST /api/recover {}`, which runs the same owner-scoped
expiry sweep, before rendering its recorded results.
The list carries only evidence for that owner, with newest evidence first.

Edit loads the contact and its group with owner-scoped SQL; the resulting tier
comes from that group, never a client tier. Edit accepts only draft,
awaiting_approval or needs_review, rechecks health terms, invalidates any prior
approval, resets the override and writes the manual event atomically. Approve
accepts only awaiting_approval and checks `requireApprovalRevision` from
`lib/requests/approval-revision.ts` before any approval write. Every request read
computes `revision` with `approvalRevision` from that same server-loaded
`RequestRecord`. The browser sends the revision associated with the exact
rendered preview as a strong quoted `If-Match` header, keeping the JSON body
unchanged. Missing/empty headers return HTTP 428
`{error:{code:"precondition_required"}}`; changed, malformed, weak, wildcard or
multiple validators return HTTP 412 `{error:{code:"stale_request"}}`. Neither
error writes an approval, audit event or state change. The browser must refresh,
show the new preview and require another explicit approval; it must never retry
approval automatically with a freshly fetched revision.

`withCurrentApproval` provides the owner-scoped transaction wrapper for the base
`WorkflowStore`. An extended durable approval transaction may call
`requireApprovalRevision` directly after ownership checks, so its health-term
check, override save/audit and approval transition share that same lock and
transaction. Never check the revision before entering the transaction and then
write approval in a separate one. The revision covers request
identity/owner, state, exact recipient email, subject, body, tier, selected
deadline and saved override; it is a preview precondition, not approval evidence
or authorization. Canonical JSON fields avoid ambiguous newline boundaries.
The approval evidence hash remains the existing newline-joined encoding from
`lib/state.ts`. The optional override is an
explicit user choice and is saved in that transaction. Neither approval nor send
accepts client content or a client approval hash. The durable adapter must also
serialize contact/group edits affecting email or tier with the request lock (or
lock those source rows) so joined content cannot change during approval. Cancel accepts awaiting_approval or
needs_review; sending/requested requests cannot be cancelled as unsent.

Use HTTP 401 for missing session; 404 for missing/cross-owner requests or
contacts; 403 for Origin/admin denial; 400 for malformed/unknown fields and
invalid dates; 409 for an ineligible state; 503 for unconfigured adapters. Error
JSON is `{error:{code:string}}`, with no provider payload. Send's recorded
`failed` result is a normal JSON outcome that the UI must show as failed.

## Provider boundary (Ali)

`googleClient` in `lib/google.ts` uses an injected server-side `loadAccount` to
load the owner's email and decrypted refresh token. It sends MIME text/plain
through Gmail only and reads Calendar with recurrence expansion and pagination.
Calendar fields (including `attendeesOmitted` and `location`) stay available to
the impact scan. No invite response changes request state. `lib/crypto.ts` binds
AES-256-GCM ciphertext to app_user.id using AAD and uses a fresh IV each time.

`sendApprovedRequest` requires the health-term checker explicitly. Fadi owns
`lib/healthTerms.ts`; Ali will adapt it when that contract lands. No permissive
production checker is supplied. Its approval hash and evidence names follow the
existing spec exactly.

### Google sign-in and account persistence

`lib/auth/google.ts` exports `createGoogleAuthCallbacks`,
`GOOGLE_AUTHORIZATION_PARAMS`, `SAFE_AUTH_LOGGER` and `googleAccountLoader` for
the installed NextAuth **4.24.15**. This is a tested callback foundation; no root
`auth.ts`, sign-in HTTP route or live Google session is supplied yet.

Fadi's account-store contract, agreed on the board for #25/#7, is:

```ts
interface AccountStore {
  findOrCreateUserByEmail(verifiedEmail: string): Promise<{ id: string }>;
  loadEncryptedRefreshToken(userId: string): Promise<{
    email: string;
    ciphertext: Uint8Array | null;
  }>;
  saveEncryptedRefreshToken(userId: string, ciphertext: Uint8Array): Promise<void>;
}
```

Email is lowercased after verifying the Google profile. The upsert must be atomic
and unique on that email, returning a stable app_user UUID on repeat sign-in.
Load/save operate only on that server-selected UUID. Unknown IDs must throw
`WorkflowError("not_found")`; a save affecting no row must fail. No memory
production implementation is included. The agreed storage column is `bytea`;
Fadi owns the schema change from the original implementation guide's `text`.
The callbacks convert `lib/crypto.ts`'s base64 encoding into bytes with the same
`iv || authTag || ciphertext` layout and owner-ID AAD. The store never receives a
plaintext token. `googleAccountLoader` converts those bytes back, decrypts only
on the server and supplies `googleClient`'s existing `loadAccount` dependency.

Sign-in accepts only a Google OAuth account whose subject matches the verified
profile and whose granted scopes include the complete existing allowlist.
Google's userinfo email/profile aliases are accepted. Missing verification,
identity mismatch or partial grants deny sign-in before persistence. A new
refresh token is encrypted and saved before issuing the app JWT; repeat sign-in
without one preserves and validates the saved owner-bound ciphertext. No saved
token, corrupt ciphertext or a different owner binding requires reauthentication.
Store failures expose a fixed error code only.

JWT callbacks return only `sub`, `appUserId`, `email` and `name`; NextAuth adds its
own encoding metadata. Session callbacks return only `expires` and
`user:{id,email,name}`. Neither callback spreads provider/default token fields or
client session updates. Access, refresh and ID tokens are never copied into the
JWT or browser session. Client updates cannot change the signed app identity.

When the durable store lands, the root configuration must use the stock Google
provider with `authorization.params: GOOGLE_AUTHORIZATION_PARAMS`,
`session:{strategy:"jwt"}`, these callbacks, an explicit `secret` from the server
secret loader, `logger:SAFE_AUTH_LOGGER` and `debug:false`. Preserve the stock
Google provider's ID-token, PKCE and state checks. Root route/server-session
wiring stays with Ali; database and deployment files stay with Fadi. For this
installed v4 API, configure the canonical `NEXTAUTH_URL` to match `APP_BASE_URL`
when deploying, and use `getServerSession` with the same options. Do not assume
the implementation guide's Auth.js v5 `auth()`/`AUTH_TRUST_HOST` examples apply
to the installed v4 package. This is a deployment handoff requirement, not a
completed environment change.

Reference: [NextAuth v4 Google](https://next-auth.js.org/providers/google),
[callbacks](https://next-auth.js.org/configuration/callbacks),
[options](https://next-auth.js.org/configuration/options) and
[server session](https://next-auth.js.org/configuration/nextjs).

Live Google setup still needs a Google test project and account, ignored
`.env.local` credentials, the sign-in route and the eventual deployed APP_BASE_URL.
Live speech needs an ElevenLabs key with credit. Keep all credentials out of issues
and logs. The speech HTTP functions are below; the routes are mounted (verify), and
no live speech request has been run yet.

`elevenLabsClient` in `lib/elevenlabs.ts` is the server-only speech adapter. STT
accepts nonempty supported audio up to 10 MB, uses Scribe v2 and deletes the
provider transcript when a transcription_id is returned. Its internal result is
`{transcript, cleanup:"deleted"|"id_not_returned"}`; a missing id does not become a
false deletion claim. Cleanup failure is an error. Deleting a transcript is not
zero retention for all provider logs. TTS uses the configured voice and explicit
Flash v2.5 model, returns MP3 bytes, and accepts at most 4,000 Unicode characters
per call. Keys stay server-side, calls use no-store, and ambiguous provider
failures are not retried. Callers must supply session authorization, same-Origin
checks, per-user rate limits and metadata-only llm_call logging before wiring
the HTTP routes.

### Speech HTTP boundary (#35 / #16)

`createSpeechHttpHandlers` in `lib/speech/http.ts` supplies `stt(Request)` and
`tts(Request)` functions. `app/api/stt` and `app/api/tts` call them through
`createSpeechRuntimeFromApp` in `lib/speech/runtime.ts` (verify), composed with a
verified server-session resolver, canonical `APP_BASE_URL`, `elevenLabsClient`
and the durable reservation below. There is no in-memory quota implementation
or default successful reservation. Both functions require POST, a server-selected
owner and matching Origin before reading the body; no client user ID, model or
voice override is accepted.

STT bounds the actual streamed request to 10 MiB **before** multipart parsing,
including when Content-Length is missing or false. Multipart overhead counts
toward that limit, so clients should keep audio below 10 MiB. It accepts exactly
one nonempty `file` in a supported audio MIME type, discards the original filename
and keeps the audio in memory only. The adapter performs transcript cleanup
before `{transcript}` is returned. The HTTP function never saves a care source or
calls a model; the caller chooses intake versus care-note processing.

TTS accepts strict JSON `{text}` with nonblank text of at most 4,000 Unicode
characters and a 64 KiB actual-body limit (enough for escaped Unicode JSON).
It preserves the supplied text exactly and returns `audio/mpeg` bytes. Every
success and error has no-store, no-referrer and nosniff headers with no CORS grant.

Fadi's #7 quota handoff is adapted structurally as:

```ts
reserveCall({ userId, step, model }): Promise<{
  allowed: boolean;
  limit: { retryAfterSeconds: number };
  // The durable implementation also returns callId and other limit metadata.
}>
```

It is bound to `reserveCall(rt.stores.database, input)` from `lib/rateLimit.ts`
by `lib/speech/runtime.ts`. The database owns a fixed ten-minute **real-time** per-user voice
counter, shared by STT/TTS, with a limit of 30. Model steps have their own bucket
and daily fuse. Counting and inserting `llm_call(user_id,step,model)` with null
token counts must commit atomically before `allowed:true`. The handler reserves
after validating input and before the provider call. Attempts remain counted on
provider failure, cleanup failure or an uncertain network outcome; no retry or
refund is performed. Only user ID, step and fixed model ID reach this boundary;
it receives no audio, text, filename, provider key or transcript ID. The complete
reservation result and call ID are not exposed to the browser. The factory and
quota exports were a board handoff, not locally verified production wiring.

Wrong methods return 405 with `Allow: POST`; missing sessions 401; invalid Origin
403; unsupported media 415; invalid input/audio 400; oversized actual bodies 413.
Quota denial returns 429 `{error:{code:"rate_limited"}}` and the database's
`Retry-After` seconds. Speech provider rate limits also return 429. Missing speech
configuration/provider access returns 503; provider/cleanup/invalid-response
failures return 502. Unexpected session/quota/storage errors return only 503
`temporarily_unavailable`. Provider diagnostics, bodies and credentials are
neither logged nor returned.

`node --conditions=react-server --import tsx --test tests/speech-http.test.ts tests/speech.test.ts`
uses fictional multipart audio, an intercepted provider transport and a quota
fixture. It verifies auth/Origin checks, streamed bounds/cancellation, strict
fields, metadata-only reservation before calls, quota failure, MP3/transcript
results, cleanup and safe failures without retries. It does not establish real
database quota isolation, deployed routes, live audio quality, credit availability
or live deletion. Those remain acceptance work in #16.

## Fixture checks

These suites have no npm script; README.md lists the command that runs them all, next to the scripted suites. The notes below say what each one does and does not prove.

`node --conditions=react-server --test tests/requests.test.ts tests/integrations.test.ts`
passes 18 fixture tests on Node 26.4.0. They cover changed approvals,
health-term blocking, competing send attempts,
Gmail failure, cross-owner denial, deadline preservation, hash-only tokens,
competing/repeated responses, real-time token expiry and proposal validation.
Patched Nodemailer MIME generation, Calendar pagination and token encryption
tamper/owner checks also pass. `npm run typecheck` passes. Live provider requests,
database transaction rollback and HTTP/GET behavior still need checks after the
production adapters and routes are available. This does not verify a real send.

`node --conditions=react-server --test tests/approval-revision.test.ts` passes
seven additional fixture checks for exact viewed content, missing/invalid
preconditions, changed previews, a queued edit versus approval, competing
approvals, owner denial and unambiguous revision fields. These test a serializing
fixture; real SQL isolation and the eventual HTTP status mapping remain pending.

`node --conditions=react-server --import tsx --test tests/google-auth.test.ts`
passes 13 auth fixture checks for account verification/grants, encrypted binary
persistence, owner binding, repeat sign-in, identity-only JWT/session output,
ignored client identity updates, fixed-code errors and metadata-free logging.
These do not verify OAuth redirects/cookies, Google account consent, the real
database or a real Calendar read/send.
