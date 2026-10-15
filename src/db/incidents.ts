import { shouldOpenIncident } from "../core/incident";
import type { StatusChange, Tx } from "./service-status";
import { notifySubscribersOfPublicUpdate } from "./subscriber-notify";

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
  const incidentId = rows[0]?.id ?? null;
  if (incidentId) {
    await createAlertForIncident(tx, incidentId);
    // Public automatic open: notify verified subscribers (SP-HSD0).
    const meta = await tx.$queryRaw<
      {
        project_id: string;
        service_id: string;
        service_name: string;
        project_name: string;
        is_public: boolean;
      }[]
    >`SELECT i.project_id, i.service_id, s.name AS service_name, p.name AS project_name, i.is_public
        FROM incidents i
        JOIN services s ON s.id = i.service_id
        JOIN projects p ON p.id = i.project_id
       WHERE i.id = ${incidentId}::uuid`;
    const m = meta[0];
    if (m?.is_public) {
      await notifySubscribersOfPublicUpdate(tx, {
        projectId: m.project_id,
        serviceId: m.service_id,
        serviceName: m.service_name,
        projectName: m.project_name,
        incidentTitle: `${m.service_name}: outage detected`,
        message: `${m.service_name} in ${m.project_name} has entered Outage. An incident was opened automatically.`,
        isPublicUpdate: true,
      });
    }
  }
  return incidentId;
}

export async function createAlertForIncident(
  tx: Tx,
  incidentId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH new_alert AS (
      INSERT INTO alerts (project_id, service_id, incident_id, state)
      SELECT i.project_id, i.service_id, i.id, 'Outage'
        FROM incidents i
       WHERE i.id = ${incidentId}::uuid
      ON CONFLICT (service_id, incident_id, state) DO NOTHING
      RETURNING id, project_id, service_id
    ), recipients AS (
      INSERT INTO outbox_messages (project_id, kind, alert_id, recipient_email, subject, body)
      SELECT a.project_id, 'alert', a.id, u.email,
             '[' || p.name || '] ' || s.name || ' is down',
             s.name || ' in project ' || p.name || ' has entered Outage and an incident has been opened. ' ||
             'Open the dashboard to acknowledge this alert.'
        FROM new_alert a
        JOIN projects p ON p.id = a.project_id
        JOIN services s ON s.id = a.service_id
        JOIN memberships m ON m.project_id = a.project_id AND m.role IN ('Owner', 'Responder')
        JOIN users u ON u.id = m.user_id
      ON CONFLICT (alert_id, recipient_email) DO NOTHING
    )
    SELECT id FROM new_alert`;
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
