# Integration handoff for issue #6

Status: partial. The workflow services, transport code and tested HTTP handler
functions exist; Next.js route registration, Auth.js sign-in, the durable store
adapter and live-provider checks are pending.
No real email, Calendar read, speech request or deployed Accept flow has passed.

## Store boundary (Fadi)

Implement `WorkflowStore` from `lib/requests/workflow.ts` using Aurora Data API.
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

## Frontend HTTP contract (planned; routes not implemented yet)

| Endpoint | Input | Success | Access |
|---|---|---|---|
| `POST /api/requests/send` | JSON `{requestId}` only | `{state:"requested",messageId}`; or `{state:"failed",errorCode}`; or `{state:"needs_review"}` | Auth.js owner session plus same Origin |
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
`Response` objects. It does not register Next.js routes. Compose it with the
durable `WorkflowStore`, the real Google transport, Fadi's health-term checker,
an owner-scoped app-clock reader, and a verified server-session resolver returning
`{userId}` or null. It supplies no memory store, permissive checker or mock send.
Root auth and route composition remain with Ali after the #7 persistence handoff.

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

## Approval queue and clock contract (planned; not implemented)

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

All these routes require an owner session. POSTs require matching Origin; clock
jump additionally requires the session email in ADMIN_EMAILS. GETs do not write
state. Recover calls the refresh POST before rendering its recorded results.
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

Local setup is blocked on Google test-project/account configuration, ignored
`.env.local` credentials, ElevenLabs API key/credits, the durable adapter and the
eventual deployed APP_BASE_URL. Keep all credentials out of issues and logs.
Speech ownership was handed to Ali on the board; Fadi confirmed no existing
speech files. Speech HTTP functions are available below; route registration and
live acceptance remain pending.

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
`tts(Request)` functions without registering endpoints. Compose them with a
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

Bind this to `reserveCall(appStores().database, input)` from `lib/rateLimit.ts`
when #7 lands. The database owns a fixed ten-minute **real-time** per-user voice
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

## Checks so far

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
