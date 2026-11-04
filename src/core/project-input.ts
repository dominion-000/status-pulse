import { z } from "zod";

export function slugifyProjectName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base.length >= 2 ? base : `project-${Date.now().toString(36)}`;
}

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().max(64).optional(),
  })
  .superRefine((data, ctx) => {
    const raw = (data.slug ?? "").trim().toLowerCase();
    const slug = raw || slugifyProjectName(data.name);
    if (slug.length < 2 || !slugRegex.test(slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: "slug must be lowercase alphanumeric with hyphens (min 2 chars)",
      });
    }
  })
  .transform((data) => {
    const raw = (data.slug ?? "").trim().toLowerCase();
    const slug = raw || slugifyProjectName(data.name);
    return { name: data.name, slug };
  });
