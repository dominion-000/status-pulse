import type { Tx } from "./service-status";

/**
 * Enqueue simulated emails for verified subscribers of a public service when a
 * public incident event happens (SP-07 / SP-HSD0).
 */
export async function notifySubscribersOfPublicUpdate(
  tx: Tx,
  args: {
    projectId: string;
    serviceId: string;
    serviceName: string;
    projectName: string;
    incidentTitle: string;
    message: string;
    /** When false, nothing is written. */
    isPublicUpdate: boolean;
  },
): Promise<number> {
  if (!args.isPublicUpdate) return 0;

  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    WITH recipients AS (
      SELECT DISTINCT s.id AS subscriber_id, s.email
        FROM subscribers s
        JOIN subscriber_services ss ON ss.subscriber_id = s.id
        JOIN services svc ON svc.id = ss.service_id
       WHERE s.project_id = ${args.projectId}::uuid
         AND ss.service_id = ${args.serviceId}::uuid
         AND s.verified_at IS NOT NULL
         AND svc.is_public = true
         AND svc.enabled = true
         AND svc.deleted_at IS NULL
    ),
    inserted AS (
      INSERT INTO outbox_messages (project_id, kind, recipient_email, subject, body)
      SELECT ${args.projectId}::uuid,
             'subscriber_notification',
             r.email,
             '[' || ${args.projectName} || '] ' || ${args.serviceName} || ': ' || ${args.incidentTitle},
             ${args.message}
        FROM recipients r
      RETURNING id
    )
    SELECT count(*)::bigint AS n FROM inserted`;

  return Number(rows[0]?.n ?? 0);
}
