import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  albertaTimestamp,
  canonicalRrule,
  datesMentioned,
  dayOfWeek,
  isIsoDate,
  isRuleGrounded,
  namesDay,
  ruleStartDate,
  timesMentioned,
} from "../time";

test("isIsoDate accepts real dates only", () => {
  assert.equal(isIsoDate("2026-11-10"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-11-1"), false);
  assert.equal(isIsoDate(null), false);
});

test("addDays and dayOfWeek", () => {
  assert.equal(addDays("2026-11-10", 6), "2026-11-16");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(dayOfWeek("2026-11-09"), "Monday");
});

test("albertaTimestamp uses UTC-6 all year", () => {
  assert.equal(albertaTimestamp("2026-11-10", "08:30"), "2026-11-10T14:30:00.000Z");
  assert.equal(albertaTimestamp("2027-07-01", "08:30"), "2027-07-01T14:30:00.000Z");
});

test("timesMentioned reads clock times and ignores doses", () => {
  assert.deepEqual([...timesMentioned("breakfast at 8:00")].sort(), ["08:00", "20:00"]);
  assert.deepEqual([...timesMentioned("walk at 10 am")], ["10:00"]);
  assert.deepEqual([...timesMentioned("naps from 1:30 pm until about 3")], ["13:30"]);
  assert.deepEqual([...timesMentioned("dinner 6 p.m.")], ["18:00"]);
  assert.deepEqual([...timesMentioned("check at 20:15")], ["20:15"]);
  assert.deepEqual([...timesMentioned("lunch at noon")], ["12:00"]);
  assert.equal(timesMentioned("Take 2 tablets, 500 mg every 6 hours").size, 0);
  assert.equal(timesMentioned("12 am").has("00:00"), true);
});

test("canonicalRrule allows only daily or weekly rules", () => {
  assert.equal(canonicalRrule("FREQ=DAILY"), "FREQ=DAILY");
  assert.equal(canonicalRrule("RRULE:freq=weekly;byday=mo,th"), "FREQ=WEEKLY;BYDAY=MO,TH");
  assert.equal(canonicalRrule("BYDAY=MO;FREQ=WEEKLY;INTERVAL=2"), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO");
  assert.equal(canonicalRrule("FREQ=HOURLY"), null);
  assert.equal(canonicalRrule("FREQ=DAILY;COUNT=3"), null);
  assert.equal(canonicalRrule("FREQ=WEEKLY;BYDAY=XX"), null);
  assert.equal(canonicalRrule("FREQ=DAILY;FREQ=WEEKLY"), null);
  assert.equal(canonicalRrule("FREQ=DAILY;INTERVAL=0"), null);
  assert.equal(canonicalRrule(""), null);
});

test("datesMentioned reads written dates and infers the year", () => {
  assert.deepEqual([...datesMentioned("Follow-up: November 14 at 10:00", "2026-11-10")], ["2026-11-14"]);
  assert.deepEqual([...datesMentioned("on 14 Nov.", "2026-11-10")], ["2026-11-14"]);
  assert.deepEqual([...datesMentioned("see you Jan 5", "2026-11-10")], ["2027-01-05"]);
  assert.deepEqual([...datesMentioned("on 2026-11-20", "2026-11-10")], ["2026-11-20"]);
  assert.equal(datesMentioned("on 11/14", "2026-11-10").size, 0);
  assert.equal(datesMentioned("February 30", "2026-11-10").size, 0);
});

// regression tests for the review findings

test("timesMentioned reads 24-hour and written forms exactly", () => {
  assert.deepEqual([...timesMentioned("Breakfast at 08:00")], ["08:00"]);
  assert.deepEqual([...timesMentioned("Follow-up November 14 1030 hrs")], ["10:30"]);
  assert.deepEqual([...timesMentioned("Meds at 0830h")], ["08:30"]);
  assert.deepEqual([...timesMentioned("Breakfast at 8 o'clock")].sort(), ["08:00", "20:00"]);
  assert.deepEqual([...timesMentioned("check at 08:00 pm")], ["20:00"]);
  assert.equal(timesMentioned("Take 1000 mg, 500 mg every 6 hours").size, 0);
});

test("datesMentioned ignores month-like words and the verb may, and finds dates it used to miss", () => {
  for (const text of [
    "Give her 5 decaf teas and 2 mayo packets",
    "Take 1 Janumet tablet with breakfast",
    "Take 2 Septra tablets",
    "Apply 2 Decongestant sprays",
    "Adults and children over 12 may take 1 to 2 tablets",
    "1 or 2 may be taken at bedtime",
  ]) {
    assert.equal(datesMentioned(text, "2026-11-10").size, 0, text);
  }
  assert.deepEqual([...datesMentioned("Follow-up November 14 1030 hrs", "2026-11-10")], ["2026-11-14"]);
  assert.deepEqual([...datesMentioned("Clinic on 14 May at 10:00", "2026-11-10")], ["2027-05-14"]);
  assert.deepEqual([...datesMentioned("Follow up May 2nd, 2027", "2026-11-10")], ["2027-05-02"]);
  assert.deepEqual([...datesMentioned("February 29", "2027-12-20")], ["2028-02-29"]);
});

test("canonicalRrule requires BYDAY on a weekly rule", () => {
  assert.equal(canonicalRrule("FREQ=WEEKLY"), null);
  assert.equal(canonicalRrule("FREQ=WEEKLY;INTERVAL=2"), null);
  assert.equal(canonicalRrule("FREQ=WEEKLY;BYDAY=FR"), "FREQ=WEEKLY;BYDAY=FR");
});

test("isRuleGrounded needs the days and the repetition written in the text", () => {
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=MO,TH", "Every Monday and Thursday the pharmacy delivers."), true);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=SA,SU", "Every Monday and Thursday the pharmacy delivers."), false);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Walk at 10 am Mon-Fri."), true);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "Walk at 10 am on weekdays."), true);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=TU,TH", "Tuesdays and Thursdays she swims."), true);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=TH", "Physio visit Thursday at 2 pm."), false);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=MO", "Monitor her blood pressure every morning."), false);
  assert.equal(isRuleGrounded("FREQ=WEEKLY;BYDAY=TH", "Thus every week it repeats."), false);
  assert.equal(isRuleGrounded("FREQ=DAILY", "She takes her walk every day if the weather is okay."), true);
  assert.equal(isRuleGrounded("FREQ=DAILY", "Take your pills twice a day."), true);
  assert.equal(isRuleGrounded("FREQ=DAILY", "Breakfast at 8:30 with medication."), false);
  assert.equal(isRuleGrounded("FREQ=DAILY;INTERVAL=2", "Change the dressing every other day."), true);
  assert.equal(isRuleGrounded("FREQ=DAILY;INTERVAL=3", "Walk the dog every day."), false);
});

test("ruleStartDate starts a BYDAY rule on its first day on or after the anchor", () => {
  assert.equal(ruleStartDate("2026-11-10", "FREQ=WEEKLY;BYDAY=MO,TH"), "2026-11-12");
  assert.equal(ruleStartDate("2026-11-10", "FREQ=WEEKLY;BYDAY=TU"), "2026-11-10");
  assert.equal(ruleStartDate("2026-11-10", "FREQ=WEEKLY;BYDAY=MO"), "2026-11-16");
  assert.equal(ruleStartDate("2026-11-10", "FREQ=DAILY"), "2026-11-10");
});

test("namesDay spots weekdays and relative days but not look-alike words", () => {
  assert.equal(namesDay("Physio visit Thursday at 2 pm."), true);
  assert.equal(namesDay("Come back tomorrow at 9 am."), true);
  assert.equal(namesDay("Give the pill tonight at 9 pm."), true);
  assert.equal(namesDay("Dressing change Tues. at 10 am."), true);
  assert.equal(namesDay("She sat in the sun at 2 pm, and we wed at noon."), false);
  assert.equal(namesDay("Monitor her at 8 pm."), false);
});

// regression tests for the second review

test("datesMentioned does not read a 24-hour time after the day as the year", () => {
  assert.deepEqual([...datesMentioned("Follow-up November 14 1930 hrs", "2026-11-10")], ["2026-11-14"]);
  assert.deepEqual([...datesMentioned("Follow-up 14 Nov 2030h", "2026-11-10")], ["2026-11-14"]);
  assert.deepEqual([...datesMentioned("Born November 14, 1930.", "2026-11-10")], ["1930-11-14"]);
  assert.deepEqual([...timesMentioned("Follow-up November 14 1930 hrs")], ["19:30"]);
});
