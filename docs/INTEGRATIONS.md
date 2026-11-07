# Integration handoff for issue #6

Status: partial. The workflow services and transport code exist; HTTP routes,
Auth.js sign-in, the durable store adapter and live-provider checks are pending.
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
| `POST /api/stt` | Audio file as multipart `file`, at most 10 MB | JSON `{transcript}` | Owner session plus same Origin |
| `POST /api/tts` | JSON `{text}` | Audio bytes, `Content-Type: audio/mpeg` | Owner session plus same Origin |

Proposal `at` must be an ISO time with `Z` or an explicit numeric offset. Notes
are plain text, at most 300 characters, and never become model input. Invalid
tokens and ownership failures return 404; invalid input 400; invalid Origin 403;
state conflicts 409. Provider failures must not expose provider response bodies.
Keep all existing mock UI results labelled test mode until the live path passes.

## Approval queue and clock contract (planned; not implemented)

Request reads return this owner-only shape. Timestamps are ISO UTC strings or
null; event ids are strings (the database uses bigint). Tokens, refresh tokens,
care facts and medical source text are never included.

```ts
type RequestView = {
  id: string;
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
| `POST /api/requests/approve` | `{requestId, healthOverride?: boolean}` | `{request: RequestView}` in `approved`; or HTTP 422 with `{error:{code:"health_terms",terms:string[]}}` |
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
accepts only awaiting_approval and hashes the server-loaded recipient email,
subject, body and tier under the same request lock. The optional override is an
explicit user choice and is saved in that transaction. Neither approval nor send
accepts client content or a client hash. Cancel accepts awaiting_approval or
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

Local setup is blocked on Google test-project/account configuration, ignored
`.env.local` credentials, ElevenLabs API key/credits, the durable adapter and the
eventual deployed APP_BASE_URL. Keep all credentials out of issues and logs.
Speech ownership was handed to Ali on the board; Fadi confirmed no existing
speech files. Speech routes above are proposed contracts, not completed work.

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
the HTTP routes. No permissive HTTP route is supplied.

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
