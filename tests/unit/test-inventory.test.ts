import assert from "node:assert/strict";
import test from "node:test";
import { discoverTestContracts, validateTestInventory } from "../../scripts/test-inventory-lib.mjs";

const contract = {
  id: "tests/example.test.js::example contract",
  name: "example contract",
  source: "tests/example.test.js",
  layer: "blackbox",
  owners: ["tests/example.test.js"],
};

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    contracts: [{
      ...contract,
      boundary: "production-cli-journey",
      processBoundaryRationale: "Exercises the production process boundary.",
    }],
    execution: { layers: { integration: { concurrency: 4 }, blackbox: { concurrency: 6, ownerOrder: contract.owners } } },
    baseline: { contracts: [{ id: contract.id }] },
    migrations: [{ baselineId: contract.id, finalIds: [contract.id] }],
    ...overrides,
  };
}

test("inventory validation accepts complete deterministic ownership", () => {
  assert.deepEqual(validateTestInventory(inventory(), [contract]), []);
});

test("inventory validation rejects omissions, duplicate ownership, and missing black-box rationale", () => {
  assert.match(validateTestInventory(inventory({ contracts: [] }), [contract]).join("\n"), /Missing inventory owner/);
  assert.match(
    validateTestInventory(inventory({ contracts: [{ ...contract, owners: [contract.owners[0], contract.owners[0]] }] }), [contract]).join("\n"),
    /Invalid declared ownership|Missing black-box process-boundary rationale/,
  );
});

test("discovery reconciles every preparation contract to exactly one stable shard", () => {
  const root = process.cwd();
  const preparation = discoverTestContracts(root).filter((entry: typeof contract) => entry.source === "tests/cli-preparation.contracts.js");
  assert.equal(preparation.length, 14);
  assert.equal(new Set(preparation.map((entry: typeof contract) => entry.id)).size, preparation.length);
  assert.ok(preparation.every((entry: typeof contract) => entry.owners.length === 1));
});
