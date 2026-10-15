import { readFileSync } from "node:fs";
import path from "node:path";
import ejs from "ejs";
import type { Response } from "express";

const viewsRoot = path.join(__dirname, "views");

function template(rel: string): string {
  return readFileSync(path.join(viewsRoot, rel), "utf8");
}

/**
 * Render a view inside layouts/main.ejs.
 * `view` is a path under views/ without extension, e.g. "public/status".
 */
export function renderPage(
  res: Response,
  view: string,
  data: Record<string, unknown> = {},
  status = 200,
): void {
  const body = ejs.render(template(`${view}.ejs`), data, {
    filename: path.join(viewsRoot, `${view}.ejs`),
  });
  const html = ejs.render(
    template("layouts/main.ejs"),
    { ...data, body },
    { filename: path.join(viewsRoot, "layouts/main.ejs") },
  );
  res.status(status).type("html").send(html);
}
