import type { Pool, PoolClient } from "pg";

export interface ClaimedOutboxMessage {
  id: string;
  project_id: string;
  kind: string;
  alert_id: string | null;
  recipient_email: string;
  subject: string;
  body: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  lease_until: Date | null;
  delivered_at: Date | null;
}

/**
 * Claim the oldest pending outbox message with FOR UPDATE SKIP LOCKED.
 * Only messages with attempts < maxAttempts and next_attempt_at <= now are eligible.
 * Expired leases become claimable again.
 */
export async function claimOutboxMessage(
  pool: Pool | PoolClient,
  now: Date,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<ClaimedOutboxMessage | null> {
  const result = await pool.query<ClaimedOutboxMessage>(
    `UPDATE outbox_messages m
        SET lease_until = $1::timestamptz + make_interval(secs => $2::double precision),
            attempts = m.attempts + 1
      WHERE m.id = (
        SELECT m2.id
          FROM outbox_messages m2
         WHERE m2.delivered_at IS NULL
           AND m2.next_attempt_at <= $1::timestamptz
           AND (m2.lease_until IS NULL OR m2.lease_until < $1::timestamptz)
           AND m2.attempts < $3
         ORDER BY m2.next_attempt_at, m2.id
         FOR UPDATE OF m2 SKIP LOCKED
         LIMIT 1)
      RETURNING m.id, m.project_id, m.kind, m.alert_id, m.recipient_email,
                m.subject, m.body, m.attempts, m.last_error, m.next_attempt_at,
                m.lease_until, m.delivered_at`,
    [now.toISOString(), leaseSeconds, maxAttempts],
  );
  return result.rows[0] ?? null;
}

/** Mark a message as successfully delivered. delivered_at is set only here. */
export async function markOutboxDelivered(
  pool: Pool | PoolClient,
  messageId: string,
  now: Date,
): Promise<void> {
  await pool.query(
    `UPDATE outbox_messages
        SET delivered_at = $2::timestamptz,
            lease_until = NULL,
            last_error = NULL
      WHERE id = $1 AND delivered_at IS NULL`,
    [messageId, now.toISOString()],
  );
}

/**
 * Record a failed send: clear the lease, store the error, schedule the next attempt.
 * Backoff is computed by the caller (5 s doubling, capped at 5 min).
 */
export async function markOutboxFailed(
  pool: Pool | PoolClient,
  messageId: string,
  error: string,
  nextAttemptAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE outbox_messages
        SET lease_until = NULL,
            last_error = $2,
            next_attempt_at = $3::timestamptz
      WHERE id = $1 AND delivered_at IS NULL`,
    [messageId, error.slice(0, 2000), nextAttemptAt.toISOString()],
  );
}

/**
 * Reset a message so the dispatcher can claim it again (API retry).
 * Zeros attempts so a manual retry is always allowed even after the soft limit of 6.
 */
export async function resetOutboxForRetry(
  pool: Pool | PoolClient,
  messageId: string,
  now: Date,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE outbox_messages
        SET attempts = 0,
            next_attempt_at = $2::timestamptz,
            lease_until = NULL,
            last_error = NULL
      WHERE id = $1 AND delivered_at IS NULL
      RETURNING id`,
    [messageId, now.toISOString()],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Backoff after a failed attempt: 5 s × 2^(attempts-1), capped at 300 s. */
export function outboxBackoffSeconds(attempts: number): number {
  const base = 5 * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(base, 300);
}
