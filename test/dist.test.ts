// Smoke test of the published files: the ESM and CommonJS builds load and export the same API.
// Needs `npm run build` first; skipped (with a note) when dist/ is missing.
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const esm = new URL("dist/esm/index.js", root);
const cjs = new URL("dist/cjs/index.js", root);
const built = existsSync(fileURLToPath(esm)) && existsSync(fileURLToPath(cjs));

test("dist: ESM and CJS builds export the same API", { skip: built ? false : "run `npm run build` first" }, async () => {
  const m = (await import(esm.href)) as Record<string, unknown>;
  const require = createRequire(import.meta.url);
  const c = require(fileURLToPath(cjs)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(m).sort(), Object.keys(c).sort());
  for (const name of ["Client", "Mailbox", "TmailorError", "MailboxNotFoundError", "WaitTimeoutError", "BaseURLError", "VERSION"]) {
    assert.ok(name in m, `ESM export ${name}`);
  }
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { version: string };
  assert.equal(m["VERSION"], pkg.version);
  assert.equal(c["VERSION"], pkg.version);
  assert.ok(existsSync(fileURLToPath(new URL("dist/esm/index.d.ts", root))));
  assert.ok(existsSync(fileURLToPath(new URL("dist/cjs/index.d.ts", root))));
  const cjsPkg = JSON.parse(readFileSync(new URL("dist/cjs/package.json", root), "utf8")) as { type: string };
  assert.equal(cjsPkg.type, "commonjs");
});
