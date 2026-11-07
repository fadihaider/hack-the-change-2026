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
| `POST /api/stt` | Audio file as multipart `file`, at most 10 MB | JSON `{text}` | Owner session plus same Origin |
| `POST /api/tts` | JSON `{text}` | Audio bytes, `Content-Type: audio/mpeg` | Owner session plus same Origin |

Proposal `at` must be an ISO time with `Z` or an explicit numeric offset. Notes
are plain text, at most 300 characters, and never become model input. Invalid
tokens and ownership failures return 404; invalid input 400; invalid Origin 403;
state conflicts 409. Provider failures must not expose provider response bodies.
Keep all existing mock UI results labelled test mode until the live path passes.

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

## Checks so far

`node --test tests/requests.test.ts` passes 12 fixture tests on Node 26.4.0.
They cover changed approvals, health-term blocking, competing send attempts,
Gmail failure, cross-owner denial, deadline preservation, hash-only tokens,
competing/repeated responses, real-time token expiry and proposal validation.
The patched Nodemailer import, full app typecheck/build, crypto tamper checks,
provider requests, transaction rollback and HTTP/GET behavior still need checks
after the scaffold and production adapters are available.
