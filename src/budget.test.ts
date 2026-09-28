import { test } from "node:test";
import assert from "node:assert/strict";
import { istDate, decideBudget } from "./budget.ts";

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
