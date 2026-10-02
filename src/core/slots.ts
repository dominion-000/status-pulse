/**
 * Start of the interval-aligned slot that contains `now`.
 * Slots are aligned to the Unix epoch, so every scheduler computes the same value for the same
 * moment. That is what lets a unique constraint on (service, slot) reject duplicate jobs (SP-03.1).
 */
export function slotStart(now: Date, intervalSeconds: number): Date {
  const ms = intervalSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** True while `slot` is the current slot for this interval; older jobs are stale and are skipped (SP-03.7). */
export function isCurrentSlot(slot: Date, now: Date, intervalSeconds: number): boolean {
  return slotStart(now, intervalSeconds).getTime() === slot.getTime();
}
