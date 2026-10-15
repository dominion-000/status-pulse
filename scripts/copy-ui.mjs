import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const src = join("src", "ui");
const dest = join("dist", "ui");
if (!existsSync(join(src, "views"))) {
  console.warn("src/ui/views missing; skip copy");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(join(src, "views"), join(dest, "views"), { recursive: true });
cpSync(join(src, "public"), join(dest, "public"), { recursive: true });
console.log("copied ui assets to dist/ui");
