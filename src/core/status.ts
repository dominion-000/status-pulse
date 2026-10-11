// Service status calculation (SP-04). Pure: no database, no clock, no I/O.
// The worker, the API and the sweeper all call this one function, each inside a transaction that holds the
// service row lock, so the rules exist in exactly one place.

export type ServiceStatus = "Operational" | "Degraded" | "Outage" | "Unknown";

export interface CheckSample {
  passed: boolean;
  latencyMs: number | null;
}

export interface Thresholds {
  /** Consecutive failures before Outage. */
  failThreshold: number;
  /** Consecutive passes for each recovery step. */
  recoveryThreshold: number;
  /** Consecutive slow results before Degraded. */
  slowThreshold: number;
  /** A passing result slower than this is slow. Null: the service never becomes Degraded. */
  degradedMs: number | null;
  intervalSeconds: number;
}

export interface ActiveOverride {
  status: ServiceStatus;
  expiresAt: Date;
}

export interface EvaluationInput {
  /** The computed status as of the last computed transition (never the override). */
  previous: ServiceStatus;
  /**
   * Results recorded after the last computed transition, oldest first. Only the most recent
   * `evaluationWindow(thresholds)` results are needed; longer lists give the same answer.
   */
  results: readonly CheckSample[];
  /** When the most recent result of any age was recorded, or null if there never was one. */
  lastResultAt: Date | null;
  enabled: boolean;
  thresholds: Thresholds;
  /** An override that has not been cancelled. It stops applying at its expiry. */
  override: ActiveOverride | null;
  now: Date;
}

export type StatusSource = "computed" | "stale" | "disabled" | "override";

export interface Evaluation {
  /** Derived from the results, staleness and the enabled flag. Overrides never change it. */
  computed: ServiceStatus;
  /** What is shown: the override while it is active, otherwise `computed`. */
  displayed: ServiceStatus;
  overrideActive: boolean;
  /** Why `displayed` has its value. */
  source: StatusSource;
}

/** A service with no result for more than this many intervals is Unknown (SP-04.6). */
export const STALE_AFTER_INTERVALS = 3;

/** How many recent results `evaluate` needs. */
export function evaluationWindow(t: Pick<Thresholds, "failThreshold" | "recoveryThreshold" | "slowThreshold">): number {
  return Math.max(t.failThreshold, t.recoveryThreshold, t.slowThreshold) + 1;
}

function isSlow(r: CheckSample, degradedMs: number | null): boolean {
  return r.passed && degradedMs !== null && r.latencyMs !== null && r.latencyMs > degradedMs;
}

function trailing(results: readonly CheckSample[], matches: (r: CheckSample) => boolean): number {
  let n = 0;
  for (let i = results.length - 1; i >= 0 && matches(results[i]!); i--) n++;
  return n;
}

/**
 * Length of the current recovery streak from Outage.
 * A failure restarts it. The first slow-but-successful result after the failures counts, because the
 * service may be waking up. Any later slow result does not count and restarts the streak.
 */
function recoveryStreakFromOutage(results: readonly CheckSample[], degradedMs: number | null): number {
  let streak = 0;
  let afterFailure = true; // Outage is only entered through failures, so the result before the window was one
  for (const r of results) {
    if (!r.passed) {
      streak = 0;
      afterFailure = true;
    } else if (isSlow(r, degradedMs)) {
      streak = afterFailure ? 1 : 0;
      afterFailure = false;
    } else {
      streak += 1;
      afterFailure = false;
    }
  }
  return streak;
}

function nextComputed(input: EvaluationInput): ServiceStatus {
  const { previous, results, thresholds: t } = input;
  const failures = trailing(results, (r) => !r.passed);
  const slow = trailing(results, (r) => isSlow(r, t.degradedMs));
  const fastPasses = trailing(results, (r) => r.passed && !isSlow(r, t.degradedMs));
  const last = results[results.length - 1];

  switch (previous) {
    case "Unknown":
      if (last?.passed) return "Operational"; // SP-04.7: the first passing result
      return failures >= t.failThreshold ? "Outage" : "Unknown";
    case "Operational":
      if (failures >= t.failThreshold) return "Outage";
      return slow >= t.slowThreshold ? "Degraded" : "Operational";
    case "Degraded":
      if (failures >= t.failThreshold) return "Outage";
      return fastPasses >= t.recoveryThreshold ? "Operational" : "Degraded";
    case "Outage":
      return recoveryStreakFromOutage(results, t.degradedMs) >= t.recoveryThreshold ? "Degraded" : "Outage";
  }
}

export function evaluate(input: EvaluationInput): Evaluation {
  const { now, override, thresholds: t } = input;

  let computed: ServiceStatus;
  let source: StatusSource = "computed";
  const staleAfterMs = STALE_AFTER_INTERVALS * t.intervalSeconds * 1000;
  if (!input.enabled) {
    computed = "Unknown";
    source = "disabled";
  } else if (input.lastResultAt === null || now.getTime() - input.lastResultAt.getTime() > staleAfterMs) {
    computed = "Unknown";
    source = "stale";
  } else {
    computed = nextComputed(input);
  }

  // A disabled service shows Unknown whatever an override says: no checks are running (SP-02.9).
  const overrideActive = input.enabled && override !== null && now.getTime() < override.expiresAt.getTime();
  if (overrideActive && override) {
    return { computed, displayed: override.status, overrideActive: true, source: "override" };
  }
  return { computed, displayed: computed, overrideActive: false, source };
}
