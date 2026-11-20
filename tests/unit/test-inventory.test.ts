import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { extractContractNames, validateTestInventory } from "../../scripts/test-inventory-lib.mjs";

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
  const invalidOwners = [{ ...contract, owners: [contract.owners[0], contract.owners[0]] }];
  assert.match(validateTestInventory(inventory({ contracts: invalidOwners }), [contract]).join("\n"), /Invalid declared ownership/);
  for (const rationale of [undefined, "  ", 7]) {
    const contracts = [{ ...contract, processBoundaryRationale: rationale }];
    assert.match(validateTestInventory(inventory({ contracts }), [contract]).join("\n"), /Missing black-box process-boundary rationale/);
  }
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

test("inventory discovery requires direct statically named test registrations", () => {
  const fixtures = [
    [
      'import run, { it as check, after } from "node:test";\n'
        + 'after(() => {});\nrun("plain", () => {});\ncheck(`literal template`, {}, () => {});\n'
        + 'const unrelated = { test: "not a registration" }; unrelated.test;\n'
        + 'check("node:test", () => assert.equal(specifier, "node:test"));',
      ["plain", "literal template", "node:test"],
    ],
    ['import test from "node:test";\ntest(`case ${suffix}`, () => {});', /:2:1:.*literal name/],
    ['import test from "node:test";\ntest.skip("modified", () => {});', /direct call/],
    ['import test from "node:test";\nconst register = test;\nregister("indirect", () => {});', /direct call/],
    ['import test from "node:test";\nfor (const item of items) test("one per item", () => {});', /top level/],
    ['import test from "node:test";\ntest("parent", (ctx) => ctx.test("nested", () => {}));', /subtests/],
    ['import * as runner from "node:test";\nrunner.test("namespace", () => {});', /named or default imports/],
    ['const test = require("node:test");\ntest("require", () => {});', /static node:test import/],
    ['const test = await import("node:test");\ntest.test("dynamic", () => {});', /static node:test import/],
  ] as const;
  const paths = fixtures.map((_, index) => resolve("test-inventory-fixtures", `fixture-${index}.test.js`).replaceAll("\\", "/"));
  const fs = createVirtualFileSystem(Object.fromEntries(paths.map((path, index) => [path, fixtures[index][0]])));
  const api = new API({ cwd: process.cwd(), fs });
  try {
    const snapshot = api.updateSnapshot({ openFiles: paths });
    for (const [index, path] of paths.entries()) {
      const source = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
      assert.ok(source, `TypeScript did not parse ${path}`);
      const expected = fixtures[index][1];
      if (expected instanceof RegExp) assert.throws(() => extractContractNames(source), expected);
      else assert.deepEqual(extractContractNames(source), expected);
    }
  } finally {
    api.close();
  }
});

