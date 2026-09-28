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
