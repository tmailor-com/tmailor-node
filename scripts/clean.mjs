// Removes build output directories (cross-platform, no dependency).
import { rmSync } from "node:fs";

const dirs = process.argv.slice(2);
for (const dir of dirs.length ? dirs : ["dist", ".test-build"]) {
  rmSync(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true });
}
