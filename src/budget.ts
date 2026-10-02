// Daily ElevenLabs credit budget. Spend is recorded from the `character-cost`
// header ElevenLabs returns with each TTS response, because the API key is scoped
// to text_to_speech only and cannot read the account's real counter. The
// `estimate` and `reserve` passed in are in characters, which over-estimates
// credits when the model bills less than one per character; that errs toward
// signing off slightly early, never toward overspending.
//
// "Daily" is the owner's day: Asia/Kolkata, not UTC.

export function istDate(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

export type BudgetDecision =
  | { kind: "reply"; room: number }   // enough left for a normal reply
  | { kind: "signoff" }               // nearing the cap: send the sign-off once, then stop
  | { kind: "stop" };                 // cap reached, or sign-off already sent

// `reserve` is what the sign-off itself costs; `estimate` is a typical reply.
// We send the sign-off while there is still room to speak it, never after.
export function decideBudget(used: number, limit: number, estimate: number, reserve: number, signoffSent: boolean): BudgetDecision {
  if (limit <= 0) return { kind: "reply", room: Number.POSITIVE_INFINITY };
  const remaining = limit - used;
  if (remaining - reserve >= estimate) return { kind: "reply", room: remaining - reserve };
  if (!signoffSent && remaining >= reserve) return { kind: "signoff" };
  return { kind: "stop" };
}

// ---- carry-forward allowance ---------------------------------------------------
// Each IST day adds `daily` credits to the balance; whatever is not spent carries
// forward, but the balance never exceeds `max`. The balance for today is computed
// lazily on the first request of the day from yesterday's (or the last active
// day's) allowance minus what was spent on it.

export interface AllowanceState { day: string; available: number }

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

export function rollAllowance(prev: AllowanceState | null, prevUsed: number, today: string, daily: number, max: number): AllowanceState {
  if (!prev) return { day: today, available: Math.min(max, daily) };
  if (prev.day === today) return prev;
  const elapsed = Math.max(1, daysBetween(prev.day, today));
  const carry = Math.max(0, prev.available - prevUsed);
  return { day: today, available: Math.min(max, carry + daily * elapsed) };
}
