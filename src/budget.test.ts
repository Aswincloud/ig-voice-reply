import { test } from "node:test";
import assert from "node:assert/strict";
import { istDate, decideBudget } from "./budget.ts";
import { rollAllowance } from "./budget.ts";

test("istDate rolls the day over at 18:30 UTC, not midnight UTC", () => {
  assert.equal(istDate(new Date("2026-09-28T18:29:59Z")), "2026-09-28");
  assert.equal(istDate(new Date("2026-09-28T18:30:00Z")), "2026-09-29");
});

test("plenty of budget: normal reply, room excludes the sign-off reserve", () => {
  const d = decideBudget(100, 1000, 160, 60, false);
  assert.deepEqual(d, { kind: "reply", room: 840 });
});

test("nearing the cap: send the sign-off once", () => {
  assert.deepEqual(decideBudget(900, 1000, 160, 60, false), { kind: "signoff" });
});

test("sign-off already sent today: stop, silently", () => {
  assert.deepEqual(decideBudget(900, 1000, 160, 60, true), { kind: "stop" });
});

test("not even room for the sign-off: stop", () => {
  assert.deepEqual(decideBudget(980, 1000, 160, 60, false), { kind: "stop" });
});

test("limit 0 disables the budget", () => {
  assert.equal(decideBudget(999999, 0, 160, 60, false).kind, "reply");
});

test("first day gets the daily allowance", () => {
  assert.deepEqual(rollAllowance(null, 0, "2026-10-02", 1500, 4000), { day: "2026-10-02", available: 1500 });
});
test("unused credits carry forward to the next day", () => {
  assert.deepEqual(rollAllowance({ day: "2026-10-02", available: 1500 }, 300, "2026-10-03", 1500, 4000), { day: "2026-10-03", available: 2700 });
});
test("the balance never exceeds the max", () => {
  assert.equal(rollAllowance({ day: "2026-10-02", available: 3800 }, 0, "2026-10-03", 1500, 4000).available, 4000);
});
test("quiet days each add the daily allowance, up to the max", () => {
  assert.equal(rollAllowance({ day: "2026-10-01", available: 1500 }, 1500, "2026-10-03", 1500, 4000).available, 3000);
  assert.equal(rollAllowance({ day: "2026-09-20", available: 1500 }, 0, "2026-10-03", 1500, 4000).available, 4000);
});
test("overspend never carries a negative balance", () => {
  assert.equal(rollAllowance({ day: "2026-10-02", available: 1500 }, 1600, "2026-10-03", 1500, 4000).available, 1500);
});
test("same day returns the stored state unchanged", () => {
  const s = { day: "2026-10-02", available: 2700 };
  assert.equal(rollAllowance(s, 999, "2026-10-02", 1500, 4000), s);
});
