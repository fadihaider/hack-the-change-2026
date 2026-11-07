# Browser demo

Run `npm ci && npm run dev`, then open http://localhost:3000. Use fictional information only. All changes live in browser memory and reset on refresh.

1. In Urgent, confirm the November 10 to 17 window and continue. Four fixture calendar events appear. Keep the appointment and choose requests for the other three. You can add a contact, choose them as a recipient and set their disclosure tier.
2. Prepare drafts. Review or edit each exact message, email address, tier and response deadline. Approve each individually. Editing resets approval; health-term hits block minimal/general approval unless explicitly overridden.
3. Click **Simulate delivery** for approved requests. No email is sent. Recover lists these under Waiting, not Handled.
4. In Recover, simulate Accept for one request and Propose time for another. The accepted item is Handled; the proposal needs review and creates a New commitment. Jump seven days: the remaining unanswered request expires and needs follow-up. All clock changes are labelled simulated.
5. In Care, choose the 8:30 breakfast source. The 8:00 source becomes superseded. Approve the tea preference. Only the approved timed instruction appears on the day timeline, with its full exact text one click away.
6. Ask the profile about breakfast: exact approved facts and their source references appear. Ask about a spare key: the demo says the answer is absent and records an open question. This is keyword lookup, not a model response.

## Verification

The initial scaffold was checked with eight passing Node workflow tests, TypeScript, a production build on Next.js 15.5.29, a clean dependency audit, and browser interaction checks for the steps above. The mobile intake view was inspected at 390 CSS pixels with no horizontal overflow. These checks do not verify live integrations.

The first deliverable is a clickable frontend. Google sign-in/calendar/sending, response-link endpoints, AI extraction, transcription, uploads, persistent storage and resource retrieval need their live adapters. PDF selection is local only; it does not upload or extract facts. The guide provides general source links without eligibility, distance, hours or accessibility claims. The local demo clock is available to every demo visitor; the live admin clock must be protected server-side.

## Integration boundaries

- UI and fixture-only workflow: `components/relief-ready/` and `lib/demo/` (Haris).
- Live state/send/response logic: Ali's integration modules; do not use the browser fixture workflow to authorize real actions.
- Model facts and proposals: Fadi's `lib/ai/contracts.ts` when merged.
- Database and resource loaders: Haris's Data and infra stream, issue #7.
