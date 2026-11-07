# Browser demo

Run `npm ci && npm run dev`, then open http://localhost:3000. Use fictional information only. All changes live in browser memory and reset on refresh.

1. In Urgent, confirm the November 10 to 17 window and continue. Four fixture calendar events appear. Keep the appointment and choose requests for the other three. You can add a contact, choose them as a recipient and set their disclosure tier.
2. Prepare drafts. Review or edit each exact message, email address, tier and response deadline. Approve each individually. Editing resets approval; health-term hits block minimal/general approval unless explicitly overridden.
3. Click **Simulate delivery** for approved requests. No email is sent. Recover lists these under Waiting, not Handled.
4. In Recover, simulate Accept for one request and Propose time for another. The accepted item is Handled; the proposal needs review and creates a New commitment. Jump seven days: the remaining unanswered request expires and needs follow-up. All clock changes are labelled simulated.
5. In Care, choose the 8:30 breakfast source. The 8:00 source becomes superseded. Approve the tea preference. Only the approved timed instruction appears on the day timeline, with its full exact text one click away.
6. Ask the profile about breakfast: exact approved facts and their source references appear. Ask about a spare key: the demo says the answer is absent and records an open question. This is keyword lookup, not a model response.
7. Open the first-72-hours guide. The leave card stays hidden until tenure is Yes or Not sure, and hides for No. Dated Alberta, Canada and AHS cards link to their official sources. Prepare an employer notice: it enters Urgent as awaiting approval and sends nothing.

## Verification

The initial scaffold was checked with eight passing Node workflow tests, TypeScript, a production build on Next.js 15.5.29, a clean dependency audit, and browser interaction checks for the steps above. The mobile intake view was inspected at 390 CSS pixels with no horizontal overflow. These checks do not verify live integrations.

The first deliverable is a clickable frontend. Google sign-in/calendar/sending, response-link endpoints, AI extraction, transcription, uploads, persistent storage and resource retrieval need their live adapters. PDF selection is local only; it does not upload or extract facts. The guide has sourced rule summaries and a tenure filter, without determining eligibility or claiming verified distance, hours or accessibility. The local demo clock is available to every demo visitor; the live admin clock must be protected server-side.

## Integration boundaries

The **Open live workspace** control opens a separate server-records panel. Its browser client follows `docs/INTEGRATIONS.md` and validates every response; it never loads fixture records. The panel supports the planned edit/approve/cancel/send/Recover flows. Until protected HTTP routes and durable storage are connected, it shows unavailable and locks mutation controls. Returning to the fictional demo preserves the demo workspace. Missing Gmail evidence, authentication failures, unconfigured adapters and malformed responses never count as successful live delivery. Nine browser-client contract tests cover these boundaries; the real email/Accept milestone remains open in #11.

Approval uses the exact rendered server revision in one strong quoted `If-Match` header. HTTP 412/428 refreshes the preview and clears disclosure overrides, requiring a new explicit approval. It never retries approval automatically. A temporary localhost HTTP fixture verified the browser changed from preview A to B after a 412, kept the request awaiting approval, cleared the disclosure checkbox and made exactly one approval POST. No provider call or real send occurred in that check.

- UI and fixture-only workflow: `components/relief-ready/` and `lib/demo/` (Haris).
- Live state/send/response logic: Ali's integration modules; do not use the browser fixture workflow to authorize real actions.
- Model facts and proposals: Fadi's `lib/ai/contracts.ts` when merged.
- Database and resource loaders: Haris's Data and infra stream, issue #7.
