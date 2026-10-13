import type { PrismaClient } from "../../prisma/generated";
import { openIncidentIfNeeded } from "./incidents";
import {
  lockService,
  refreshStatus,
  type StatusChange,
} from "./service-status";

export interface CheckOutcome {
  statusCode: number | null;
  latencyMs: number | null;
  passed: boolean;
  failureReason: string | null;
}

export interface RecordInput {
  jobId: string;
  serviceId: string;
  configVersion: number;
  outcome: CheckOutcome;
  checkedAt: Date;
}

export interface Recorded {
  /** False when the job already had a result: a retry, which changes nothing. */
  stored: boolean;
  resultId: string | null;
  change: StatusChange | null;
  incidentId: string | null;
}

/**
 * Saves a check result and everything that follows from it in ONE transaction (SP-03.3, SP-04, SP-05):
 * the result, the job closing, the service's status and history, and a new incident if the service went down.
 * A failure at any point leaves nothing half-written; the job's lease then expires and it is retried.
 *
 * Order matters: the result is inserted first with ON CONFLICT DO NOTHING, so a retried job is recognised without an
 * exception that would abort the transaction; only then is the service row locked and the status recalculated.
 */
export async function recordCheckResult(
  prisma: PrismaClient,
  input: RecordInput,
): Promise<Recorded> {
  const { jobId, serviceId, configVersion, outcome, checkedAt } = input;
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO check_results (job_id, service_id, status_code, latency_ms, passed, failure_reason, config_version, checked_at)
      VALUES (${jobId}::uuid, ${serviceId}::uuid, ${outcome.statusCode}, ${outcome.latencyMs}, ${outcome.passed},
              ${outcome.failureReason}, ${configVersion}, ${checkedAt})
      ON CONFLICT (job_id) DO NOTHING
      RETURNING id`;
    await tx.$executeRaw`UPDATE check_jobs SET status = 'done', lease_until = NULL WHERE id = ${jobId}::uuid`;

    const resultId = inserted[0]?.id ?? null;
    if (!resultId)
      return { stored: false, resultId: null, change: null, incidentId: null };

    const service = await lockService(tx, serviceId);
    if (!service)
      return { stored: true, resultId, change: null, incidentId: null };

    // Results can finish out of order; the latest one wins.
    const lastResultAt =
      service.lastResultAt && service.lastResultAt > checkedAt
        ? service.lastResultAt
        : checkedAt;
    await tx.$executeRaw`UPDATE services SET last_result_at = ${lastResultAt} WHERE id = ${serviceId}::uuid`;

    const change = await refreshStatus(
      tx,
      { ...service, lastResultAt },
      checkedAt,
      { at: checkedAt, resultId },
    );
    const incidentId = await openIncidentIfNeeded(tx, serviceId, change);
    return { stored: true, resultId, change, incidentId };
  });
}
