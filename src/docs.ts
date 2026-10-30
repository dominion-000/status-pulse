import { readFileSync } from "node:fs";
import path from "node:path";
import type { Express } from "express";
import swaggerUi from "swagger-ui-express";
import { parse as parseYaml } from "yaml";

/**
 * Serves the OpenAPI document and an interactive Swagger UI.
 * UI at /api/docs, raw contract at /api/v1/openapi.yaml.
 * Contract file: src/doc/openapi.yaml
 */
export function mountApiDocs(app: Express): void {
  const yamlPath = path.join(process.cwd(), "src", "doc", "openapi.yaml");
  let document: object;
  try {
    document = parseYaml(readFileSync(yamlPath, "utf8")) as object;
  } catch (err) {
    console.warn("OpenAPI document not loaded; /api/docs disabled", err);
    return;
  }

  app.get("/api/v1/openapi.yaml", (_req, res) => {
    res.type("application/yaml").send(readFileSync(yamlPath, "utf8"));
  });

  app.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(document, {
      customSiteTitle: "Status Pulse API",
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
      },
    }),
  );
}
