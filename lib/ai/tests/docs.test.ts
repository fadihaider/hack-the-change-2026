// keeps docs/IMPLEMENTATION.md in step with lib/ai, so teammates don't build against stale contracts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../../../docs/IMPLEMENTATION.md", import.meta.url), "utf8");

test("IMPLEMENTATION.md no longer points at lib/llm.ts", () => {
  assert.ok(!doc.includes("lib/llm.ts"));
  assert.ok(doc.includes("lib/ai/model.ts"));
});

test("IMPLEMENTATION.md timeline expansion honours the rules A4 stores", () => {
  const sentence = doc.split("\n").find((line) => line.startsWith("Code expands `rrule`"));
  assert.ok(sentence);
  assert.match(sentence, /BYDAY/);
  assert.match(sentence, /INTERVAL/);
});

test("IMPLEMENTATION.md has no em or en dashes in the A4 and A1 sections", () => {
  const section6 = doc.slice(doc.indexOf("## 6. Model-backed steps"), doc.indexOf("## 7. ElevenLabs"));
  assert.ok(!/[\u2013\u2014]/.test(section6));
});
