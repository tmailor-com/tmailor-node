// Runs the compiled node:test files with an explicit file list (works the same on Node 18, 20 and 22).
//   node scripts/run-tests.mjs              every *.test.js (offline, no network)
//   node scripts/run-tests.mjs conformance  only files whose name contains "conformance"
//   node scripts/run-tests.mjs --live       the live tests (real API, needs TMAILOR_API_KEY)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../.test-build/test/", import.meta.url));
const args = process.argv.slice(2);
const live = args.includes("--live");
const filter = args.find((a) => !a.startsWith("--"));
const suffix = live ? ".live.js" : ".test.js";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(suffix) && (!filter || f.includes(filter)))
  .sort()
  .map((f) => dir + f);
if (files.length === 0) {
  console.error(`no test files (${suffix}) in ${dir}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
