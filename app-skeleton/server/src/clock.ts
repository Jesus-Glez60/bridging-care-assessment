// Business clock. The brief fixes "now" at org.simulatedNow (Wed Oct 21 2026, 9:00 AM Central).
// We persist an anchor pair (simulated instant, real instant) so business time advances in real time
// from that point and survives restarts. "Advance time" moves the simulated anchor forward.
// Retry/backoff timers in the sync worker deliberately use real wall time, not this clock.
import { col } from "./db";

type Anchor = {
  sim: number;
  real: number;
};

let anchor: Anchor | null = null;

export async function initClock(simulatedNow: string, reset = false) {
  const existing = reset ? null : await col.settings().findOne({ _id: "clock" });
  if (existing) {
    anchor = { sim: existing.sim as number, real: existing.real as number };
    return;
  }
  anchor = { sim: Date.parse(simulatedNow), real: Date.now() };
  await col.settings().updateOne({ _id: "clock" }, { $set: { ...anchor } }, { upsert: true });
}

export function now(): Date {
  if (!anchor) throw new Error("clock not initialised");
  return new Date(anchor.sim + (Date.now() - anchor.real));
}

export async function advance(ms: number) {
  if (!anchor) throw new Error("clock not initialised");
  anchor = { sim: anchor.sim + ms, real: anchor.real };
  await col.settings().updateOne({ _id: "clock" }, { $set: { ...anchor } }, { upsert: true });
  return now();
}

/** For tests only. */
export function setClockForTest(at: Date) {
  anchor = { sim: at.getTime(), real: Date.now() };
}
