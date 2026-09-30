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
    execution: {
      budgets: { blackbox: 1, localMedianMs: 110_000, localMaxMs: 135_000, ciMaxMs: 55_000 },
      layers: { integration: { concurrency: 4 }, blackbox: { concurrency: 6, ownerOrder: contract.owners } },
    },
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

test("migration records accept reasoned deletions and reject missing or conflicting outcomes", () => {
  const deletion = { baselineId: contract.id, deleted: true, reason: "Redundant observable assertion." };
  assert.deepEqual(validateTestInventory(inventory({ migrations: [deletion] }), [contract]), []);
  assert.match(
    validateTestInventory(inventory({ migrations: [{ ...deletion, finalIds: [contract.id] }] }), [contract]).join("\n"),
    /exactly one replacement mapping or deletion/,
  );
  assert.match(
    validateTestInventory(inventory({ migrations: [{ baselineId: contract.id, deleted: true }] }), [contract]).join("\n"),
    /requires a reason/,
  );
  assert.match(
    validateTestInventory(inventory({ migrations: [{ baselineId: contract.id }] }), [contract]).join("\n"),
    /exactly one replacement mapping or deletion/,
  );
});

test("inventory validation rejects black-box contracts over budget", () => {
  const budgetError = validateTestInventory(inventory({ execution: {
    budgets: { blackbox: 0, localMedianMs: 110_000, localMaxMs: 135_000, ciMaxMs: 55_000 },
    layers: { integration: { concurrency: 4 }, blackbox: { concurrency: 6, ownerOrder: contract.owners } },
  } }), [contract]).join("\n");
  assert.match(budgetError, /Black-box contract budget exceeded: 1 > 0/);
});

test("inventory validation requires ordered positive local and CI performance budgets", () => {
  const invalidBudgets = {
    blackbox: 1,
    localMedianMs: 115_000,
    localMaxMs: 110_000,
    ciMaxMs: 0,
  };
  const execution = {
    budgets: invalidBudgets,
    layers: { integration: { concurrency: 4 }, blackbox: { concurrency: 6, ownerOrder: contract.owners } },
  };
  const error = validateTestInventory(inventory({ execution }), [contract]).join("\n");
  assert.match(error, /Invalid CI maximum performance budget/);
  assert.match(error, /Local maximum performance budget is below the local median budget/);
});

test("discovery reconciles every preparation contract to exactly one stable shard", () => {
  const root = process.cwd();
  const preparation = discoverTestContracts(root).filter((entry: typeof contract) => entry.source === "tests/cli-preparation.contracts.js");
  assert.equal(new Set(preparation.map((entry: typeof contract) => entry.id)).size, preparation.length);
  assert.ok(preparation.every((entry: typeof contract) => entry.owners.length === 1));
});
