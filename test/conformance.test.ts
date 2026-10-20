// Replays the language-neutral scenarios of conformance/scenarios/ (no network). Every Tmailor SDK passes the same set.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EXPECTED_SCENARIOS, loadScenarios, runScenario, scenarioDir } from "./conformance-runner.js";

const scenarios = loadScenarios();

test(`conformance: ${EXPECTED_SCENARIOS} scenarios found in ${scenarioDir()}`, () => {
  assert.ok(scenarios.length >= EXPECTED_SCENARIOS, `${scenarios.length} scenarios found, expected ${EXPECTED_SCENARIOS}`);
  for (const s of scenarios) assert.ok(s.id && s.call && s.exchanges && s.expect, `malformed scenario ${s.id}`);
});

for (const scn of scenarios) {
  test(`conformance: ${scn.id}`, async () => {
    const fails = await runScenario(scn);
    assert.deepEqual(fails, []);
  });
}
