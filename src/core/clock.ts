// All time-dependent logic takes a Clock instead of calling Date.now(), so tests can move time.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to. Used by tests. */
export function fixedClock(at: Date): Clock & { advance(ms: number): void } {
  let t = at.getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}
