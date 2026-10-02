import type { Pool, PoolClient } from "pg";
import type { Clock } from "../core/clock";

export interface ClaimedJob {
  id: string;
  service_id: string;
  scheduled_for: Date;
  status: string;
  lease_until: Date | null;
  attempts: number;
}

/**
 * Insert one job per enabled service for the slot containing `now`.
 * Epoch-aligned scheduled_for + UNIQUE (service_id, scheduled_for) → exactly one job per slot.
 */
export async function enqueueJobs(pool: Pool | PoolClient, now: Date): Promise<number> {
  const result = await pool.query(
    `INSERT INTO check_jobs (service_id, scheduled_for)
     SELECT s.id,
            to_timestamp(
              floor(extract(epoch FROM $1::timestamptz) / s.interval_seconds) * s.interval_seconds
            )
     FROM services s
     WHERE s.enabled AND s.deleted_at IS NULL
     ON CONFLICT (service_id, scheduled_for) DO NOTHING`,
    [now.toISOString()],
  );
  return result.rowCount ?? 0;
}

/**
 * Claim the oldest current-slot job with FOR UPDATE SKIP LOCKED.
 * Expired leases become claimable again.
 */
export async function claimJob(
  pool: Pool | PoolClient,
  now: Date,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<ClaimedJob | null> {
  const result = await pool.query<ClaimedJob>(
    `UPDATE check_jobs j
        SET status = 'leased',
            lease_until = $1::timestamptz + make_interval(secs => $2::double precision),
            attempts = j.attempts + 1
      WHERE j.id = (
        SELECT j2.id
          FROM check_jobs j2
          JOIN services s ON s.id = j2.service_id
         WHERE (j2.status = 'queued' OR (j2.status = 'leased' AND j2.lease_until < $1::timestamptz))
           AND j2.attempts < $3
           AND j2.scheduled_for <= $1::timestamptz
           AND j2.scheduled_for + make_interval(secs => s.interval_seconds) > $1::timestamptz
         ORDER BY j2.scheduled_for, j2.id
         FOR UPDATE OF j2 SKIP LOCKED
         LIMIT 1)
      RETURNING j.id, j.service_id, j.scheduled_for, j.status, j.lease_until, j.attempts`,
    [now.toISOString(), leaseSeconds, maxAttempts],
  );
  return result.rows[0] ?? null;
}

/** Mark jobs whose slot has passed as skipped (sweeper). */
export async function skipStaleJobs(pool: Pool | PoolClient, now: Date): Promise<number> {
  const result = await pool.query(
    `UPDATE check_jobs j
        SET status = 'skipped', lease_until = NULL
       FROM services s
      WHERE s.id = j.service_id
        AND (j.status = 'queued' OR (j.status = 'leased' AND j.lease_until < $1::timestamptz))
        AND j.scheduled_for + make_interval(secs => s.interval_seconds) <= $1::timestamptz`,
    [now.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function markJobDone(pool: Pool | PoolClient, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE check_jobs SET status = 'done', lease_until = NULL WHERE id = $1`,
    [jobId],
  );
}

/** Lock a service row for status updates (FOR UPDATE). */
export async function lockService(
  client: PoolClient,
  serviceId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client.query(`SELECT * FROM services WHERE id = $1 FOR UPDATE`, [serviceId]);
  return result.rows[0] ?? null;
}

/** Run a tick: enqueue + skip stale. Used by the scheduler process. */
export async function schedulerTick(pool: Pool, clock: Clock): Promise<{ enqueued: number; skipped: number }> {
  const now = clock.now();
  const enqueued = await enqueueJobs(pool, now);
  const skipped = await skipStaleJobs(pool, now);
  return { enqueued, skipped };
}
