import { shouldOpenIncident } from "../core/incident";
import type { StatusChange, Tx } from "./service-status";

// Opening an incident is decided by core/incident.ts. This file does the writing, inside the transaction that
// already holds the service row lock, so the worker, the sweeper and the API all behave the same way.

/**
 * Opens an automatic incident for a service. The partial unique index on (service_id) WHERE status <> 'Resolved'
 * is the last safety net: if one is already active the insert is skipped and null is returned.
 * The incident follows its service's public or private setting (SP-05.5).
 */
export async function openAutoIncident(
  tx: Tx,
  serviceId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO incidents (project_id, service_id, title, origin, is_public)
    SELECT project_id, id, name || ': outage detected', 'auto', is_public
      FROM services
     WHERE id = ${serviceId}::uuid
    ON CONFLICT (service_id) WHERE status <> 'Resolved' DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/** Opens an incident when the status change calls for one (SP-05.1, SP-04.8). Returns its id, or null. */
export async function openIncidentIfNeeded(
  tx: Tx,
  serviceId: string,
  change: StatusChange,
): Promise<string | null> {
  const active = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM incidents WHERE service_id = ${serviceId}::uuid AND status <> 'Resolved'`;
  const open = shouldOpenIncident({
    previousDisplayed: change.previousDisplayed,
    evaluation: change.evaluation,
    hasActiveIncident: (active[0]?.n ?? 0) > 0,
  });
  return open ? openAutoIncident(tx, serviceId) : null;
}
