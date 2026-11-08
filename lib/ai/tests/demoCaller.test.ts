import { test } from "node:test";
import assert from "node:assert/strict";
import { runCareCompiler } from "../careCompiler.ts";
import { DEMO_MODEL, demoCaller } from "../demoCaller.ts";
import { runDrafter } from "../drafter.ts";
import { runImpact } from "../impact.ts";
import { runIntake } from "../intake.ts";
import { ModelCallError, type StepDeps, type UsageRecord } from "../model.ts";
import { runProfileQa } from "../profileQa.ts";
import { DISCHARGE_SHEET, EPISODE_START, EXISTING_FACTS, STATEMENT_WITH_DATES, STATEMENT_WITHOUT_DATES, TODAY, VOICE_NOTE } from "../fixtures/rosa.ts";

const usage: UsageRecord[] = [];
const deps: StepDeps = { caller: demoCaller, model: DEMO_MODEL, onUsage: (record) => void usage.push(record) };

test("demo A1 resolves the Rosa statement to a ready window", async () => {
  const result = await runIntake({ statement: STATEMENT_WITH_DATES, today: TODAY }, deps);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.startDate, "2026-11-10");
    assert.equal(result.endDate, "2026-11-16");
    assert.equal(result.recipientAlias, "mom");
    assert.equal(result.reasonText, "day surgery");
  }
  const unclear = await runIntake({ statement: STATEMENT_WITHOUT_DATES, today: TODAY }, deps);
  assert.equal(unclear.status, "needs_clarification");
  assert.ok(usage.some((record) => record.step === "intake" && record.model === DEMO_MODEL && record.inputTokens > 0));
});

test("demo A4 quotes the discharge sheet verbatim and flags the breakfast conflict", async () => {
  const result = await runCareCompiler({ fullText: DISCHARGE_SHEET, existingFacts: EXISTING_FACTS, episodeStart: EPISODE_START }, deps);
  const texts = result.facts.map((fact) => fact.textExact);
  assert.ok(texts.includes("Breakfast at 8:30 with medication."));
  assert.ok(texts.includes("Do not lift anything heavier than 5 kg for 2 weeks."));
  // the injected line and the labels are skipped
  assert.ok(!texts.some((text) => /stop all medication|FICTIONAL/.test(text)));
  assert.deepEqual(result.dropped, []);
  const breakfast = texts.indexOf("Breakfast at 8:30 with medication.");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].factIndex, breakfast);
  assert.equal(result.conflicts[0].existingFactId, "fact-breakfast-voice");
  const appointment = result.facts.find((fact) => fact.category === "logistics");
  assert.equal(appointment?.date, "2026-11-14");
  assert.equal(appointment?.event?.startsAt, "2026-11-14T16:00:00.000Z");

  const voice = await runCareCompiler({ fullText: VOICE_NOTE, existingFacts: [], episodeStart: EPISODE_START }, deps);
  const pharmacy = voice.facts.find((fact) => fact.textExact.startsWith("Every Monday"));
  assert.equal(pharmacy?.rrule, "FREQ=WEEKLY;BYDAY=MO,TH");
  assert.equal(voice.clearedValues.length, 0);
});

test("demo A2, A3 and A5 give the other P0 steps usable answers offline", async () => {
  const impact = await runImpact(
    {
      events: [
        { id: "e1", title: "Work shift", startsAt: "2026-11-12T15:00:00Z", endsAt: null, organizerEmail: "lee@example.test", attendees: [] },
        { id: "e2", title: "Rosa's follow-up appointment", startsAt: "2026-11-14T16:00:00Z", endsAt: null, organizerEmail: null, attendees: [] },
      ],
      ruleConflicts: [],
      contactGroups: [],
      episodeStart: "2026-11-10",
      episodeEnd: "2026-11-16",
      recipientAliases: ["mom", "Rosa"],
    },
    deps,
  );
  assert.deepEqual(impact.events.map((event) => event.suggestedAction), ["coverage", "keep"]);
  assert.equal(impact.events[0].candidateDependencies[0]?.toRef, "lee@example.test");

  for (const tier of ["minimal", "general"] as const) {
    const draft = await runDrafter(
      {
        recipientFirstName: "Lee",
        recipientEmail: "lee@example.test",
        relationship: "my mother",
        commitmentTitle: "Work shift",
        commitmentStart: "2026-11-12T15:00:00Z",
        action: "coverage",
        episodeStart: "2026-11-10",
        episodeEnd: "2026-11-16",
        tier,
        reasonText: "day surgery",
      },
      deps,
    );
    assert.deepEqual(draft.healthTermsFound, []);
    assert.deepEqual(draft.editFlags, []);
    assert.match(draft.body, /Thursday, November 12 at 09:00/);
  }

  const qa = await runProfileQa(
    { question: "Where are her spare glasses?", facts: [{ id: "f1", category: "routine", textExact: EXISTING_FACTS[0].textExact }] },
    deps,
  );
  assert.equal(qa.notFound, true);
  const hit = await runProfileQa(
    { question: "When does she have breakfast?", facts: [{ id: "f1", category: "routine", textExact: EXISTING_FACTS[0].textExact }] },
    deps,
  );
  assert.deepEqual(hit.citedFacts.map((fact) => fact.id), ["f1"]);
});

test("demo caller refuses a prompt it does not know", async () => {
  await assert.rejects(
    demoCaller({ model: DEMO_MODEL, max_tokens: 10, system: "something else", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => error instanceof ModelCallError && error.code === "demo_unknown_step",
  );
});
