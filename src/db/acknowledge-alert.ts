import type { PrismaClient } from "../../prisma/generated";

export type AcknowledgeResult =
  | {
      ok: true;
      acknowledgement: {
        id: string;
        actorUserId: string;
        createdAt: Date;
      };
      created: boolean;
    }
  | { ok: false; reason: "not_found" };

/**
 * Acknowledge an alert for a project. Idempotent under concurrent requests:
 * the unique alert_id constraint ensures at most one acknowledgement row.
 * Always writes an audit row when a new acknowledgement is created.
 */
export async function acknowledgeAlert(
  prisma: PrismaClient,
  input: {
    projectId: string;
    alertId: string;
    actorUserId: string;
  },
): Promise<AcknowledgeResult> {
  const alert = await prisma.alert.findFirst({
    where: { id: input.alertId, projectId: input.projectId },
    include: { acknowledgement: true },
  });
  if (!alert) return { ok: false, reason: "not_found" };

  if (alert.acknowledgement) {
    return {
      ok: true,
      created: false,
      acknowledgement: {
        id: alert.acknowledgement.id,
        actorUserId: alert.acknowledgement.actorUserId,
        createdAt: alert.acknowledgement.createdAt,
      },
    };
  }

  try {
    const ack = await prisma.$transaction(async (tx) => {
      const created = await tx.acknowledgement.create({
        data: {
          alertId: input.alertId,
          actorUserId: input.actorUserId,
        },
      });
      await tx.auditLog.create({
        data: {
          projectId: input.projectId,
          actorUserId: input.actorUserId,
          action: "alert.acknowledge",
          entityType: "alert",
          entityId: input.alertId,
          details: {},
        },
      });
      return created;
    });
    return {
      ok: true,
      created: true,
      acknowledgement: {
        id: ack.id,
        actorUserId: ack.actorUserId,
        createdAt: ack.createdAt,
      },
    };
  } catch (err) {
    // Race: another request created the acknowledgement first.
    const existing = await prisma.acknowledgement.findUnique({
      where: { alertId: input.alertId },
    });
    if (existing) {
      return {
        ok: true,
        created: false,
        acknowledgement: {
          id: existing.id,
          actorUserId: existing.actorUserId,
          createdAt: existing.createdAt,
        },
      };
    }
    throw err;
  }
}
