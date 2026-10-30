import { z } from "zod";
import { checkServiceUrl } from "./url-safety";

// The rules for a service configuration. The API and the browser UI both validate with these, so a service means
// the same thing wherever it was created.

export const INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const;

export const intervalField = z
  .number()
  .int()
  .refine((n) => (INTERVALS as readonly number[]).includes(n), {
    message: `must be one of ${INTERVALS.join(", ")}`,
  });
export const codesField = z.array(z.number().int().min(100).max(599)).min(1);

export const createServiceSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
  intervalSeconds: intervalField,
  timeoutSeconds: z.number().int().positive(),
  expectedStatusCodes: codesField.default([200]),
  expectedBodyText: z.string().max(500).optional(),
  isPublic: z.boolean().default(false),
  credentials: z.string().max(2000).optional(),
  failThreshold: z.number().int().min(1).max(20).default(3),
  recoveryThreshold: z.number().int().min(1).max(20).default(2),
  slowThreshold: z.number().int().min(1).max(20).default(3),
  degradedMs: z.number().int().positive().optional(),
});

export type CreateServiceInput = z.infer<typeof createServiceSchema>;

/** Rules that depend on more than one field, checked on the complete configuration. */
export function configIssues(c: {
  url: string;
  intervalSeconds: number;
  timeoutSeconds: number;
}): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (c.timeoutSeconds >= c.intervalSeconds)
    issues.push({
      path: "timeoutSeconds",
      message: "must be less than intervalSeconds",
    });
  for (const m of checkServiceUrl(c.url).issues)
    issues.push({ path: "url", message: m });
  return issues;
}
