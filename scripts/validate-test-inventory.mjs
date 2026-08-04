import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverTestContracts, validateTestInventory } from "./test-inventory-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const inventoryPath = resolve(root, "tests/test-inventory.json");
const evidencePath = resolve(root, "openspec/changes/restore-test-performance-budget/evidence/owner-durations.json");
const migrationOverridesPath = resolve(root, "tests/test-migration-overrides.json");
const discovered = discoverTestContracts(root);

if (process.argv.includes("--write")) {
  if (!existsSync(evidencePath)) {
    console.error(`Owner-duration evidence is required before writing the inventory: ${evidencePath}`);
    process.exit(1);
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const contracts = discovered.map((contract) => ({
    ...contract,
    boundary: boundaryFor(contract),
    processBoundaryRationale: contract.layer === "blackbox" ? rationaleFor(contract) : null,
  }));
  const previous = existsSync(inventoryPath) ? JSON.parse(readFileSync(inventoryPath, "utf8")) : null;
  const initialBaselineContracts = contracts.map((contract) => {
    const preparation = contract.source === "tests/cli-preparation.contracts.js";
    const source = preparation ? "tests/cli-preparation.test.js" : contract.source;
    const id = `${source}::${contract.name}`;
    const owner = preparation ? "tests/cli-preparation.test.js" : contract.owners[0];
    return {
      id,
      name: contract.name,
      source,
      owner,
      layer: contract.layer,
      boundary: contract.boundary,
      measuredOwnerDurationMs: preparation ? 47800 : evidence.owners[owner]?.durationMs,
    };
  });
  const baseline = previous?.baseline ?? {
    capturedRuntime: evidence.runtime,
    capturedOwnerDurationsAt: evidence.measuredAt,
    preparationHistoricalOwnerDurationMs: 47800,
    contracts: initialBaselineContracts,
  };
  const overrides = existsSync(migrationOverridesPath) ? JSON.parse(readFileSync(migrationOverridesPath, "utf8")) : {};
  const currentIds = new Set(contracts.map((contract) => contract.id));
  const previousMigrations = new Map((previous?.migrations ?? []).map((entry) => [entry.baselineId, entry.finalIds]));
  const migrations = baseline.contracts.map((contract) => ({
    baselineId: contract.id,
    finalIds: overrides[contract.id]
      ?? (currentIds.has(contract.id) ? [contract.id] : previousMigrations.get(contract.id) ?? []),
  }));
  const blackboxOwners = [...new Set(contracts.filter((contract) => contract.layer === "blackbox").flatMap((contract) => contract.owners))];
  blackboxOwners.sort((left, right) => (evidence.owners[right]?.durationMs ?? 0) - (evidence.owners[left]?.durationMs ?? 0) || left.localeCompare(right));
  const inventory = {
    schemaVersion: 1,
    execution: {
      layers: {
        integration: { concurrency: 4 },
        blackbox: { concurrency: 10, ownerOrder: blackboxOwners },
      },
    },
    baseline,
    contracts,
    migrations,
  };
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`Wrote ${contracts.length} contracts to ${inventoryPath}.`);
}

if (!existsSync(inventoryPath)) {
  console.error(`Test inventory does not exist: ${inventoryPath}`);
  process.exit(1);
}

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const errors = validateTestInventory(inventory, discovered);
for (const contract of inventory.baseline?.contracts ?? []) {
  if (!Number.isFinite(contract.measuredOwnerDurationMs)) errors.push(`Missing measured owner duration for ${contract.id}`);
}
if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Validated ${discovered.length} test contracts and deterministic shard ownership.`);

function boundaryFor(contract) {
  if (contract.layer === "unit") return "in-process-decision";
  if (contract.layer === "integration") return "owned-filesystem-or-process";
  if (/help|exposed|unknown command/i.test(contract.name)) return "production-bundle-wiring";
  if (/recover|preserv|conflict|detached|failure|failed|reject|refuse|atomic|rollback/i.test(contract.name)) {
    return "process-integrity-or-recovery";
  }
  return "production-cli-journey";
}

function rationaleFor(contract) {
  if (boundaryFor(contract) === "production-bundle-wiring") {
    return "Runs the production bundle to prove public command routing and rendered CLI wiring.";
  }
  if (boundaryFor(contract) === "process-integrity-or-recovery") {
    return "Uses the production process with owned Git/filesystem state to prove exit status, diagnostics, and preserved-state behavior.";
  }
  return "Exercises an independently owned end-to-end workspace journey through the production CLI bundle.";
}
