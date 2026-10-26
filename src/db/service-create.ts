import type { PrismaClient } from "../../prisma/generated";
import type { Config } from "../config";
import { encryptSecret } from "../core/secrets";
import { configIssues, type CreateServiceInput } from "../core/service-config";
import { lockProject } from "./project-lock";

export type CreateServiceOutcome =
  | { kind: "ok"; service: Awaited<ReturnType<PrismaClient["service"]["create"]>> }
  | { kind: "invalid"; issues: { path: string; message: string }[] }
  | { kind: "plan_limit"; message: string };

/**
 * Creates a service (SP-02). The API and the browser UI both call this, so the address guard, the plan limit,
 * configuration version 1 and the audit row cannot be skipped by one of them. The input has already been parsed
 * with createServiceSchema; the rules that span several fields and the address guard run here.
 * The project row is locked while the services are counted, so the limit holds under concurrent requests.
 */
export async function createService(
  prisma: PrismaClient,
  config: Config,
  args: { projectId: string; actorUserId: string; input: CreateServiceInput },
): Promise<CreateServiceOutcome> {
  const { projectId, actorUserId, input } = args;

  const issues = configIssues(input);
  if (issues.length) return { kind: "invalid", issues };

  const credentialsEnc = input.credentials
    ? new Uint8Array(encryptSecret(input.credentials, config.credentialsEncKey))
    : null;
  const snapshot = {
    name: input.name,
    url: input.url,
    method: input.method,
    intervalSeconds: input.intervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    expectedStatusCodes: input.expectedStatusCodes,
    expectedBodyText: input.expectedBodyText ?? null,
    isPublic: input.isPublic,
    failThreshold: input.failThreshold,
    recoveryThreshold: input.recoveryThreshold,
    slowThreshold: input.slowThreshold,
    degradedMs: input.degradedMs ?? null,
    hasCredentials: credentialsEnc !== null,
  };

  return prisma.$transaction(
    async (tx): Promise<CreateServiceOutcome> => {
    await lockProject(tx, projectId);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { plan: true },
    });
    const count = await tx.service.count({
      where: { projectId, deletedAt: null },
    });
    if (count >= project.plan.maxServices)
      return {
        kind: "plan_limit",
        message: `Plan limit reached: ${project.plan.name} allows ${project.plan.maxServices} services`,
      };

    const service = await tx.service.create({
      data: {
        projectId,
        name: input.name,
        url: input.url,
        method: input.method,
        intervalSeconds: input.intervalSeconds,
        timeoutSeconds: input.timeoutSeconds,
        expectedStatusCodes: input.expectedStatusCodes,
        expectedBodyText: input.expectedBodyText ?? null,
        isPublic: input.isPublic,
        credentialsEnc,
        failThreshold: input.failThreshold,
        recoveryThreshold: input.recoveryThreshold,
        slowThreshold: input.slowThreshold,
        degradedMs: input.degradedMs ?? null,
        version: 1,
      },
    });
    await tx.serviceConfigVersion.create({
      data: { serviceId: service.id, version: 1, snapshot, actorUserId },
    });
    await tx.auditLog.create({
      data: {
        projectId,
        actorUserId,
        action: "service.created",
        entityType: "service",
        entityId: service.id,
        details: { name: input.name, url: input.url },
      },
    });
    return { kind: "ok", service };
  },
    { maxWait: 15_000, timeout: 30_000 },
  );
}
