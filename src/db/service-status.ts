import type { Prisma, PrismaClient } from "../../prisma/generated";
import {
  evaluate,
  evaluationWindow,
  type ActiveOverride,
  type CheckSample,
  type Evaluation,
  type ServiceStatus,
} from "../core/status";

// The only place where a service's status is written (SP-04). The worker, the API and the sweeper each open a
// transaction, lock the service row with `lockService`, and call `refreshStatus`. The row lock is what stops an
// override and a check result from deciding at the same moment on stale data.

export type Tx = Prisma.TransactionClient;

export interface LockedService {
  id: string;
  projectId: string;
  enabled: boolean;
  isPublic: boolean;
  intervalSeconds: number;
  failThreshold: number;
  recoveryThreshold: number;
  slowThreshold: number;
  degradedMs: number | null;
  /** The status shown to users (the override while one is active). */
  currentStatus: ServiceStatus;
  /** The status derived from results, underneath any override. */
  computedStatus: ServiceStatus;
  statusSince: Date;
  computedSince: Date;
  lastResultAt: Date | null;
}

/** When a refresh happens and what caused it. `at` becomes the time of any transition it records. */
export interface Cause {
  at: Date;
  resultId?: string;
}

export interface StatusChange {
  previousDisplayed: ServiceStatus;
  previousComputed: ServiceStatus;
  evaluation: Evaluation;
  displayedChanged: boolean;
  computedChanged: boolean;
}

/**
 * SELECT ... FOR UPDATE on the service row. Other transactions that try to lock the same service wait until
 * this one commits, then see its changes. Returns null for a service that does not exist or was deleted.
 */
export async function lockService(
  tx: Tx,
  serviceId: string,
): Promise<LockedService | null> {
  const rows = await tx.$queryRaw<LockedService[]>`
    SELECT id,
           project_id AS "projectId",
           enabled,
           is_public AS "isPublic",
           interval_seconds AS "intervalSeconds",
           fail_threshold AS "failThreshold",
           recovery_threshold AS "recoveryThreshold",
           slow_threshold AS "slowThreshold",
           degraded_ms AS "degradedMs",
           current_status AS "currentStatus",
           computed_status AS "computedStatus",
           status_since AS "statusSince",
           computed_since AS "computedSince",
           last_result_at AS "lastResultAt"
      FROM services
     WHERE id = ${serviceId}::uuid AND deleted_at IS NULL
       FOR UPDATE`;
  return rows[0] ?? null;
}

async function loadSamples(
  tx: Tx,
  service: LockedService,
): Promise<CheckSample[]> {
  const window = evaluationWindow(service);
  // Only results recorded after the last computed transition count: each status step is earned with new results.
  const rows = await tx.$queryRaw<CheckSample[]>`
    SELECT passed, latency_ms AS "latencyMs"
      FROM check_results
     WHERE service_id = ${service.id}::uuid AND checked_at > ${service.computedSince}
     ORDER BY checked_at DESC
     LIMIT ${window}`;
  return rows.reverse(); // evaluate wants the oldest first
}

async function loadOverride(
  tx: Tx,
  serviceId: string,
): Promise<ActiveOverride | null> {
  const rows = await tx.$queryRaw<{ status: ServiceStatus; expiresAt: Date }[]>`
    SELECT status, expires_at AS "expiresAt"
      FROM status_overrides
     WHERE service_id = ${serviceId}::uuid AND ended_at IS NULL
     LIMIT 1`;
  return rows[0] ?? null; // evaluate ignores one whose expiry has passed
}

/**
 * Recalculates the service's status and writes only what changed: the service row and one history row.
 * Must be called inside the transaction that holds the lock from `lockService`.
 * Calling it again with nothing new to see changes nothing, so retries and repeated sweeps are harmless.
 */
export async function refreshStatus(
  tx: Tx,
  service: LockedService,
  now: Date,
  cause: Cause,
): Promise<StatusChange> {
  const [results, override] = await Promise.all([
    loadSamples(tx, service),
    loadOverride(tx, service.id),
  ]);

  const evaluation = evaluate({
    previous: service.computedStatus,
    results,
    lastResultAt: service.lastResultAt,
    enabled: service.enabled,
    thresholds: {
      failThreshold: service.failThreshold,
      recoveryThreshold: service.recoveryThreshold,
      slowThreshold: service.slowThreshold,
      degradedMs: service.degradedMs,
      intervalSeconds: service.intervalSeconds,
    },
    override,
    now,
  });

  const displayedChanged = evaluation.displayed !== service.currentStatus;
  const computedChanged = evaluation.computed !== service.computedStatus;
  const change: StatusChange = {
    previousDisplayed: service.currentStatus,
    previousComputed: service.computedStatus,
    evaluation,
    displayedChanged,
    computedChanged,
  };
  if (!displayedChanged && !computedChanged) return change;

  await tx.$executeRaw`
    INSERT INTO service_status_history (service_id, status, computed_status, source, caused_by_result_id, started_at)
    VALUES (${service.id}::uuid, ${evaluation.displayed}, ${evaluation.computed}, ${evaluation.source},
            ${cause.resultId ?? null}::uuid, ${cause.at})`;
  await tx.$executeRaw`
    UPDATE services
       SET current_status = ${evaluation.displayed},
           computed_status = ${evaluation.computed},
           status_since = CASE WHEN ${displayedChanged}::boolean THEN ${cause.at}::timestamptz ELSE status_since END,
           computed_since = CASE WHEN ${computedChanged}::boolean THEN ${cause.at}::timestamptz ELSE computed_since END
     WHERE id = ${service.id}::uuid`;
  return change;
}

/** Lock, refresh and commit in one transaction. For callers that have nothing else to write, such as the sweeper. */
export async function refreshServiceStatus(
  prisma: PrismaClient,
  serviceId: string,
  now: Date,
  cause: Cause,
): Promise<StatusChange | null> {
  return prisma.$transaction(async (tx) => {
    const service = await lockService(tx, serviceId);
    return service ? refreshStatus(tx, service, now, cause) : null;
  });
}
