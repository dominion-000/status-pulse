import { Prisma, type PrismaClient } from "../../prisma/generated";

export interface PlanView {
  name: string;
  maxServices: number;
  maxMembers: number;
  priceCents: number;
}

export type UpgradeOutcome =
  | {
      kind: "ok";
      /** True when an earlier request with the same key already did the work. */
      replayed: boolean;
      plan: PlanView;
      payment: { id: string; status: string; amountCents: number };
    }
  | { kind: "unknown_plan" }
  | { kind: "key_conflict" }
  | { kind: "payment_failed"; message: string };

const planView = (p: PlanView): PlanView => ({
  name: p.name,
  maxServices: p.maxServices,
  maxMembers: p.maxMembers,
  priceCents: p.priceCents,
});

/**
 * Plan upgrade with an Idempotency-Key and a simulated payment (SP-07.4, SP-07.5). The API and the browser UI both
 * call this, so they cannot drift apart. The unique (project, key) constraint is the guard: when two requests with
 * the same key race, the loser hits the constraint and answers with what the winner stored instead of failing.
 * A failed payment is recorded and leaves the plan unchanged; the same key then keeps answering with that failure,
 * and a new attempt needs a new key. Only a successful upgrade is audited.
 */
export async function upgradePlan(
  prisma: PrismaClient,
  args: {
    projectId: string;
    actorUserId: string;
    planName: string;
    key: string;
    failPayments: boolean;
  },
): Promise<UpgradeOutcome> {
  const target = await prisma.plan.findUnique({ where: { name: args.planName } });
  if (!target) return { kind: "unknown_plan" };

  const replay = async (): Promise<UpgradeOutcome | null> => {
    const existing = await prisma.paymentAttempt.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId: args.projectId,
          idempotencyKey: args.key,
        },
      },
      include: { plan: true },
    });
    if (!existing) return null;
    if (existing.planId !== target.id) return { kind: "key_conflict" };
    if (existing.status !== "succeeded")
      return {
        kind: "payment_failed",
        message: existing.errorMessage ?? "Previous payment attempt failed",
      };
    return {
      kind: "ok",
      replayed: true,
      plan: planView(existing.plan),
      payment: {
        id: existing.id,
        status: existing.status,
        amountCents: existing.amountCents,
      },
    };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  try {
    if (args.failPayments) {
      await prisma.paymentAttempt.create({
        data: {
          projectId: args.projectId,
          planId: target.id,
          idempotencyKey: args.key,
          status: "failed",
          amountCents: target.priceCents,
          errorMessage: "PAYMENT_FAIL_ALL is set",
        },
      });
      return { kind: "payment_failed", message: "Simulated payment failed" };
    }
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: args.projectId },
      include: { plan: true },
    });
    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.paymentAttempt.create({
        data: {
          projectId: args.projectId,
          planId: target.id,
          idempotencyKey: args.key,
          status: "succeeded",
          amountCents: target.priceCents,
        },
      });
      await tx.project.update({
        where: { id: args.projectId },
        data: { planId: target.id },
      });
      await tx.auditLog.create({
        data: {
          projectId: args.projectId,
          actorUserId: args.actorUserId,
          action: "plan.upgraded",
          entityType: "project",
          entityId: args.projectId,
          details: {
            from: project.plan.name,
            to: target.name,
            paymentId: created.id,
          },
        },
      });
      return created;
    });
    return {
      kind: "ok",
      replayed: false,
      plan: planView(target),
      payment: {
        id: payment.id,
        status: payment.status,
        amountCents: payment.amountCents,
      },
    };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw err;
  }
}
