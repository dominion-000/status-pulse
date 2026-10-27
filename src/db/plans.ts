import { Prisma, type PrismaClient } from "../../prisma/generated";
import { processPlanPayment } from "../payments/paystack";
import { lockProject } from "./project-lock";

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
  | { kind: "over_limit"; message: string }
  | { kind: "payment_failed"; message: string };

const planView = (p: PlanView): PlanView => ({
  name: p.name,
  maxServices: p.maxServices,
  maxMembers: p.maxMembers,
  priceCents: p.priceCents,
});

/**
 * Plan upgrade with an Idempotency-Key and Paystack payment (SP-07.4, SP-07.5). The API and the browser UI both
 * call this, so they cannot drift apart. The unique (project, key) constraint is the guard: when two requests with
 * the same key race, the loser hits the constraint and answers with what the winner stored instead of failing.
 * A failed payment is recorded and leaves the plan unchanged; the same key then keeps answering with that failure,
 * and a new attempt needs a new key. Only a successful upgrade is audited.
 * A plan whose limits are below what the project already has is refused (over_limit), so a project never holds more
 * services or members than its plan allows. The project row is locked for that check, which keeps it consistent with
 * concurrent creations. Nothing is recorded for a refused change, so the same key can be used again after cleaning up.
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
    const actor = await prisma.user.findUnique({ where: { id: args.actorUserId } });
    const pay = await processPlanPayment(
      {
        email: actor?.email ?? "billing@example.com",
        amountCents: target.priceCents,
        reference: `${args.projectId.slice(0, 8)}-${args.key}`.slice(0, 100),
        planName: target.name,
      },
      { failPayments: args.failPayments },
    );
    if (!pay.ok) {
      await prisma.paymentAttempt.create({
        data: {
          projectId: args.projectId,
          planId: target.id,
          idempotencyKey: args.key,
          status: "failed",
          amountCents: target.priceCents,
          errorMessage: pay.errorMessage ?? "Payment failed",
        },
      });
      return {
        kind: "payment_failed",
        message: pay.errorMessage ?? "Payment failed",
      };
    }
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: args.projectId },
      include: { plan: true },
    });
    const result = await prisma.$transaction(
      async (tx) => {
      await lockProject(tx, args.projectId);
      const services = await tx.service.count({
        where: { projectId: args.projectId, deletedAt: null },
      });
      const members = await tx.membership.count({
        where: { projectId: args.projectId },
      });
      if (services > target.maxServices || members > target.maxMembers)
        return {
          over: `The project has ${services} services and ${members} members; the ${target.name} plan allows ${target.maxServices} and ${target.maxMembers}`,
        } as const;
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
            paymentProvider: pay.provider,
            paymentReference: pay.reference,
          },
        },
      });
      return { payment: created } as const;
    },
      { maxWait: 15_000, timeout: 30_000 },
    );
    if ("over" in result) return { kind: "over_limit", message: result.over };
    const payment = result.payment;
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
