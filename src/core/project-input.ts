import { z } from "zod";

// The rules for a project name and slug. The API and the browser UI validate with the same schema.
export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "slug must be lowercase alphanumeric with hyphens",
    ),
});
