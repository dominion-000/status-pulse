import type { PrismaClient } from "../../prisma/generated";
import {
  createVerificationToken,
  hashToken,
} from "../core/tokens";
import type { Clock } from "../core/clock";
import { systemClock } from "../core/clock";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type SubscribeResult =
  | {
      ok: true;
      alreadyVerified: true;
    }
  | {
      ok: true;
      alreadyVerified: false;
      subscriberId: string;
      email: string;
      verificationToken: string;
      serviceNames: string[];
      projectName: string;
    }
  | {
      ok: false;
      reason: "project_not_found" | "no_public_services" | "services_invalid";
    };

/**
 * Create or refresh a public-status subscription and queue a verification message.
 * Verified addresses are left unchanged (no service attach, no new token).
 */
export async function subscribeToPublicProject(
  prisma: PrismaClient,
  input: {
    projectSlug: string;
    email: string;
    serviceIds: string[];
    clock?: Clock;
  },
): Promise<SubscribeResult> {
  const clock = input.clock ?? systemClock;
  const email = input.email.trim().toLowerCase();
  const now = clock.now();

  const project = await prisma.project.findUnique({
    where: { slug: input.projectSlug },
    select: { id: true, name: true },
  });
  if (!project) return { ok: false, reason: "project_not_found" };

  const publicServices = await prisma.service.findMany({
    where: {
      projectId: project.id,
      id: { in: input.serviceIds },
      isPublic: true,
      enabled: true,
      deletedAt: null,
    },
    select: { id: true, name: true },
  });
  if (publicServices.length === 0) {
    return { ok: false, reason: "no_public_services" };
  }
  if (publicServices.length !== input.serviceIds.length) {
    return { ok: false, reason: "services_invalid" };
  }

  const { raw, hash } = createVerificationToken();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  const serviceNames = publicServices.map((s) => s.name);

  const outcome = await prisma.$transaction(async (tx) => {
    let subscriber = await tx.subscriber.findUnique({
      where: { projectId_email: { projectId: project.id, email } },
    });

    if (subscriber?.verifiedAt) {
      return { alreadyVerified: true as const };
    }

    if (!subscriber) {
      subscriber = await tx.subscriber.create({
        data: {
          projectId: project.id,
          email,
          verificationTokenHash: hash,
          verificationExpiresAt: expiresAt,
        },
      });
    } else {
      subscriber = await tx.subscriber.update({
        where: { id: subscriber.id },
        data: {
          verificationTokenHash: hash,
          verificationExpiresAt: expiresAt,
        },
      });
    }

    for (const svc of publicServices) {
      await tx.subscriberService.upsert({
        where: {
          subscriberId_serviceId: {
            subscriberId: subscriber.id,
            serviceId: svc.id,
          },
        },
        create: { subscriberId: subscriber.id, serviceId: svc.id },
        update: {},
      });
    }

    await tx.outboxMessage.create({
      data: {
        projectId: project.id,
        kind: "subscription_verification",
        recipientEmail: email,
        subject: `Verify your subscription to ${project.name}`,
        body:
          `Confirm your subscription to ${serviceNames.join(", ")} in ${project.name}. ` +
          `Use this verification token: ${raw}`,
      },
    });

    return {
      alreadyVerified: false as const,
      subscriberId: subscriber.id,
      email,
      verificationToken: raw,
      serviceNames,
      projectName: project.name,
    };
  });

  if (outcome.alreadyVerified) {
    return { ok: true, alreadyVerified: true };
  }
  return {
    ok: true,
    alreadyVerified: false,
    subscriberId: outcome.subscriberId,
    email: outcome.email,
    verificationToken: outcome.verificationToken,
    serviceNames: outcome.serviceNames,
    projectName: outcome.projectName,
  };
}

export type VerifyResult =
  | {
      ok: true;
      subscriber: { id: string; email: string };
    }
  | { ok: false; reason: "gone" };

/**
 * Consume a single-use verification token. Concurrent requests with the same
 * token yield exactly one success.
 */
export async function verifySubscription(
  prisma: PrismaClient,
  input: { token: string; clock?: Clock },
): Promise<VerifyResult> {
  const clock = input.clock ?? systemClock;
  const hash = hashToken(input.token);
  const now = clock.now();

  const subscriber = await prisma.subscriber.findFirst({
    where: { verificationTokenHash: hash },
  });
  if (
    !subscriber ||
    !subscriber.verificationExpiresAt ||
    subscriber.verificationExpiresAt.getTime() < now.getTime() ||
    subscriber.verifiedAt
  ) {
    return { ok: false, reason: "gone" };
  }

  const claimed = await prisma.subscriber.updateMany({
    where: {
      id: subscriber.id,
      verificationTokenHash: hash,
      verifiedAt: null,
      verificationExpiresAt: { gte: now },
    },
    data: {
      verifiedAt: now,
      verificationTokenHash: null,
      verificationExpiresAt: null,
    },
  });
  if (claimed.count !== 1) {
    return { ok: false, reason: "gone" };
  }
  return {
    ok: true,
    subscriber: { id: subscriber.id, email: subscriber.email },
  };
}
