import type { PrismaClient } from "../../prisma/generated";
import { openIncidentIfNeeded } from "./incidents";
import { lockService, refreshStatus } from "./service-status";

// The sweeper handles the status changes that no check result triggers: time passing (SP-04.6, SP-08.3),
// an override reaching its expiry (SP-04.5), and a service that was disabled (SP-02.9).
// It runs inside the scheduler process. Each service is handled in its own transaction under the service row lock,
// exactly like a worker result, so the two can never decide on the same service at once.

export interface SweepResult {
  examined: number;
  statusChanges: number;
  overridesEnded: number;
  incidentsOpened: number;
  failures: number;
}

/** Services whose status may need to change because of time, not because a result arrived. */
async function candidateServiceIds(
  prisma: PrismaClient,
  now: Date,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id
      FROM services s
     WHERE s.deleted_at IS NULL
       AND (
            -- no result for more than three intervals
            (s.enabled AND s.computed_status <> 'Unknown'
               AND (s.last_result_at IS NULL
                    OR s.last_result_at < ${now}::timestamptz - make_interval(secs => s.interval_seconds * 3)))
            -- disabled, but not yet shown as Unknown
         OR (NOT s.enabled AND (s.current_status <> 'Unknown' OR s.computed_status <> 'Unknown'))
            -- an override whose expiry has passed
         OR EXISTS (SELECT 1 FROM status_overrides o
                     WHERE o.service_id = s.id AND o.ended_at IS NULL AND o.expires_at <= ${now}::timestamptz)
       )`;
  return rows.map((r) => r.id);
}

async function recordFailure(
  prisma: PrismaClient,
  serviceId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await prisma.$executeRaw`
      INSERT INTO scheduler_failures (message, details)
      VALUES ('status sweep failed', ${JSON.stringify({ serviceId, error: message.slice(0, 500) })}::jsonb)`;
  } catch {
    // Recording the failure must never stop the sweep.
  }
}

export async function sweepStatus(
  prisma: PrismaClient,
  now: Date,
): Promise<SweepResult> {
  const ids = await candidateServiceIds(prisma, now);
  const result: SweepResult = {
    examined: ids.length,
    statusChanges: 0,
    overridesEnded: 0,
    incidentsOpened: 0,
    failures: 0,
  };

  for (const id of ids) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const service = await lockService(tx, id);
        if (!service) return null;
        // Ending the override and recalculating happen together, so the shown status never lags behind.
        const ended = await tx.$executeRaw`
          UPDATE status_overrides
             SET ended_at = expires_at, end_reason = 'expired'
           WHERE service_id = ${id}::uuid AND ended_at IS NULL AND expires_at <= ${now}::timestamptz`;
        const change = await refreshStatus(tx, service, now, { at: now });
        const incidentId = await openIncidentIfNeeded(tx, id, change);
        return { ended, change, incidentId };
      });
      if (!outcome) continue;
      result.overridesEnded += outcome.ended;
      if (outcome.change.displayedChanged || outcome.change.computedChanged)
        result.statusChanges += 1;
      if (outcome.incidentId) result.incidentsOpened += 1;
    } catch (err) {
      result.failures += 1;
      await recordFailure(prisma, id, err);
    }
  }
  return result;
}
