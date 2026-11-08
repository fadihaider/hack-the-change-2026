// today's care on the care overview: what shows first, statuses and reminder times (PRD 8, AC7)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAY_PREVIEW,
  STATUS_LABEL,
  dayItemText,
  dayPreview,
  daySummary,
  itemStatus,
  overviewLine,
  reminderAt,
  withCompletion,
} from "../../components/app/care/today-data.ts";

type Item = {
  eventId: string;
  title: string;
  startsAt: string;
  remindMinutes: number;
  highlight: boolean;
  completedAt: string | null;
};

// alberta is utc-6 in this app: 08:00 local is 14:00z
const DAY_START = Date.parse("2026-11-08T06:00:00.000Z");
const local = (hour: number, minutes = 0) => DAY_START + hour * 3600000 + minutes * 60000;

function at(eventId: string, localHour: number, extra: Partial<Item> = {}): Item {
  return {
    eventId,
    title: `item ${eventId}`,
    startsAt: new Date(local(localHour)).toISOString(),
    remindMinutes: 15,
    highlight: false,
    completedAt: null,
    ...extra,
  };
}

const now = (localHour: number, minutes = 0) => local(localHour, minutes);

test("a confirmed 8:00 item with a 15 minute lead shows a 7:45 reminder; no lead time, no reminder", () => {
  assert.equal(reminderAt(at("a", 8)), "2026-11-08T13:45:00.000Z");
  assert.equal(reminderAt(at("a", 8, { remindMinutes: 0 })), null);
  assert.equal(reminderAt({ startsAt: "not a time", remindMinutes: 15 }), null);
});

test("status is done only when the caregiver marked it; a reminder window says reminder now", () => {
  assert.equal(itemStatus(at("a", 8)), "planned");
  assert.equal(itemStatus(at("a", 8, { highlight: true })), "reminder");
  assert.equal(itemStatus(at("a", 8, { highlight: true, remindMinutes: 0 })), "planned");
  assert.equal(itemStatus(at("a", 8, { highlight: true, completedAt: "2026-11-08T14:05:00.000Z" })), "done");
  assert.equal(STATUS_LABEL.done, "Done — recorded by you");
});

test("a short day shows everything in time order", () => {
  const items = [at("c", 18), at("a", 8), at("b", 12)];
  const preview = dayPreview(items, now(9));
  assert.deepEqual(preview.shown.map((item) => item.eventId), ["a", "b", "c"]);
  assert.equal(preview.hidden, 0);
});

test("on another day the preview is the first few in time order", () => {
  const items = [7, 8, 10, 12, 15, 18].map((hour) => at(`h${hour}`, hour));
  const preview = dayPreview(items, null);
  assert.equal(preview.shown.length, DAY_PREVIEW);
  assert.deepEqual(preview.shown.map((item) => item.eventId), ["h7", "h8", "h10", "h12"]);
  assert.equal(preview.hidden, 2);
});

test("today puts the latest earlier items not done next to what comes next, still in time order", () => {
  const items = [6, 7, 8, 10, 12, 15, 18, 20].map((hour) => at(`h${hour}`, hour));
  // 11:00: 6, 7, 8 and 10 are earlier; 12, 15, 18 and 20 are next
  const preview = dayPreview(items, now(11));
  assert.deepEqual(preview.shown.map((item) => item.eventId), ["h8", "h10", "h12", "h15"]);
  assert.equal(preview.hidden, 4);
});

test("done items give way to open ones in the preview", () => {
  const done = "2026-11-08T14:05:00.000Z";
  const items = [at("h8", 8, { completedAt: done }), at("h9", 9, { completedAt: done }), at("h12", 12), at("h14", 14), at("h16", 16), at("h18", 18)];
  const preview = dayPreview(items, now(10));
  assert.deepEqual(preview.shown.map((item) => item.eventId), ["h12", "h14", "h16", "h18"]);
});

test("late in the day the preview still fills with earlier items not marked done", () => {
  const items = [7, 8, 10, 12, 15, 18].map((hour) => at(`h${hour}`, hour));
  const preview = dayPreview(items, now(21));
  assert.deepEqual(preview.shown.map((item) => item.eventId), ["h10", "h12", "h15", "h18"]);
  assert.equal(preview.hidden, 2);
});

test("the day summary counts done and earlier items and names the next open one", () => {
  const items = [at("h8", 8, { completedAt: "2026-11-08T14:05:00.000Z" }), at("h9", 9), at("h12", 12)];
  const summary = daySummary(items, now(10));
  assert.equal(summary.total, 3);
  assert.equal(summary.done, 1);
  assert.equal(summary.earlier, 1);
  assert.equal(summary.next?.startsAt, items[2].startsAt);
  const other = daySummary(items, null);
  assert.equal(other.earlier, 0);
  assert.equal(other.next, null);
});

test("marking one occurrence done changes only that item", () => {
  const items = [at("a", 8), at("b", 9)];
  const next = withCompletion(items, "b", "2026-11-08T15:01:00.000Z");
  assert.equal(next[0].completedAt, null);
  assert.equal(next[1].completedAt, "2026-11-08T15:01:00.000Z");
  assert.equal(items[1].completedAt, null);
  assert.equal(withCompletion(next, "b", null)[1].completedAt, null);
});

test("the overview ends a time that already ends in a.m. or p.m. with one period", () => {
  const line = overviewLine({ total: 4, done: 1, earlier: 0, next: { startsAt: "2026-11-08T14:00:00.000Z", title: "Breakfast" } });
  assert.equal(line, "4 things on this day. 1 marked done. Next: 8:00 a.m.");
  assert.doesNotMatch(line, /\.\.$/);
  assert.equal(overviewLine({ total: 1, done: 0, earlier: 0, next: null }), "1 thing on this day.");
});

test("medication and dose wording shows whole in the day whatever its category; other items show the short title", () => {
  const dose = { factId: "f1", category: "routine", title: "Breakfast", fullText: "Breakfast at 8:30 with her 500 mg tablet." };
  assert.equal(dayItemText(dose), dose.fullText);
  const written = { factId: "f2", category: "medical_instruction", title: "Keep the area dry", fullText: "Keep the area dry for two days." };
  assert.equal(dayItemText(written), written.fullText);
  const breakfast = { factId: "f3", category: "routine", title: "Breakfast", fullText: "Rosa usually has breakfast at eight." };
  assert.equal(dayItemText(breakfast), "Breakfast");
  const appointment = { factId: null, category: null, title: "Wound check", fullText: "Wound check at the clinic, bring the dressing list." };
  assert.equal(dayItemText(appointment), "Wound check");
});
