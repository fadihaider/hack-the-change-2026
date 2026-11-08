import { test } from "node:test";
import assert from "node:assert/strict";
import { runImpact, type ImpactInput, type ImpactOutput } from "../impact.ts";
import { fakeCaller } from "./fakeCaller.ts";

const input: ImpactInput = {
  events: [
    {
      id: "ev-meeting",
      title: "Group project meeting",
      startsAt: "2026-11-11T20:00:00.000Z",
      endsAt: "2026-11-11T21:00:00.000Z",
      organizerEmail: "alex@example.test",
      attendees: [
        { email: "Sam@Example.test", responseStatus: "accepted" },
        { email: "jo@example.test", responseStatus: "needsAction" },
      ],
    },
    {
      id: "ev-rosa",
      title: "Rosa's follow-up appointment",
      startsAt: "2026-11-14T16:00:00.000Z",
      endsAt: null,
      organizerEmail: null,
      attendees: [],
    },
  ],
  ruleConflicts: [{ eventId: "ev-meeting", reason: "Overlaps the care period (Nov 10 to Nov 16)." }],
  contactGroups: [{ id: "grp-school", name: "School" }],
  episodeStart: "2026-11-10",
  episodeEnd: "2026-11-16",
  recipientAliases: ["mom", "Rosa"],
  userEmail: "alex@example.test",
};

test("A2 keeps rule conflicts, drops dependencies that are not on the event, and keeps the recipient's own event", async () => {
  const output: ImpactOutput = {
    events: [
      {
        eventId: "ev-meeting",
        suggestedAction: "reschedule",
        candidateDependencies: [
          { toKind: "attendee", toRef: "sam@example.test", evidenceText: "Teammate on the project." },
          // invented address, not on the event
          { toKind: "attendee", toRef: "boss@example.test", evidenceText: "Probably cares." },
          // the user themself
          { toKind: "organizer", toRef: "alex@example.test", evidenceText: "Organizer." },
        ],
      },
      // a value outside the set, and the model tries to drop the care recipient's appointment
      { eventId: "ev-rosa", suggestedAction: "cancel_everything", candidateDependencies: [] },
      { eventId: "ev-unknown", suggestedAction: "notify", candidateDependencies: [] },
    ],
  };
  const fake = fakeCaller({ text: JSON.stringify(output) });
  const result = await runImpact(input, { caller: fake.caller });

  const [meeting, rosa] = result.events;
  assert.equal(result.events.length, 2);
  assert.equal(meeting.suggestedAction, "reschedule");
  assert.deepEqual(meeting.ruleConflicts, ["Overlaps the care period (Nov 10 to Nov 16)."]);
  assert.deepEqual(meeting.candidateDependencies, [
    { toKind: "attendee", toRef: "Sam@Example.test", evidenceText: "Teammate on the project.", origin: "model", confirmed: false },
  ]);
  assert.equal(result.droppedDependencies, 2);
  assert.equal(rosa.suggestedAction, "keep");
  assert.equal(rosa.forCareRecipient, true);

  // the request carries calendar fields only inside <untrusted>, and the enum is back in the schema
  const request = fake.requests[0];
  assert.equal(request.output_config?.effort, "low");
  assert.equal(request.max_tokens, 16_000);
  assert.ok(JSON.stringify(request.messages).includes("<untrusted>"));
  assert.ok(JSON.stringify(request.output_config?.format).includes('"enum":["notify","reschedule","extension","coverage","defer","keep"]'));
});
