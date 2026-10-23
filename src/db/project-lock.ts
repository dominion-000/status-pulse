import type { Tx } from "./service-status";

/**
 * Locks the project row until the transaction ends. Everything that counts what a project has and then adds to it
 * (services, members) or changes its plan takes this lock first, so the plan limit cannot be passed by requests
 * that arrive at the same moment: each one sees the result of the one before.
 */
export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
}
