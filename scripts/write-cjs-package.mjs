// dist/cjs holds CommonJS files inside a "type": "module" package: mark the folder as CommonJS for Node and TypeScript.
import { writeFileSync } from "node:fs";

writeFileSync(new URL("../dist/cjs/package.json", import.meta.url), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
