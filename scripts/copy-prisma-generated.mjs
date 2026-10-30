/**
 * After tsc with rootDir ".", compiled files live under dist/src/...
 * Imports like ../../prisma/generated from dist/src/db resolve to dist/prisma/generated.
 * Prisma generates into ./prisma/generated — copy that tree into dist/prisma/generated.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "prisma", "generated");
const dest = path.join(root, "dist", "prisma", "generated");

if (!existsSync(src)) {
  console.error("prisma/generated missing. Run: pnpm prisma:generate");
  process.exit(1);
}

mkdirSync(path.dirname(dest), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log("copied prisma/generated → dist/prisma/generated");
