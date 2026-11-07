import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { isCallExpression, isIdentifier, isNoSubstitutionTemplateLiteral, isStringLiteral } from "typescript/unstable/ast/is";

export function discoverTestContracts(root) {
  const testsRoot = resolve(root, "tests");
  const files = collect(testsRoot).filter(isTestSource);
  const contracts = [];
  const api = new API({ cwd: root });

  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    for (const file of files) {
      const source = relative(root, file);
      const sourceFile = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
      if (!sourceFile) throw new Error(`TypeScript did not parse test source ${source}`);
      const names = extractContractNames(sourceFile);
      for (const name of names) {
        contracts.push({
          id: `${source}::${name}`,
          name,
          source,
          layer: layerFor(source),
          owners: [source],
        });
      }
    }
  } finally {
    api.close();
  }

  return contracts.sort((left, right) => left.id.localeCompare(right.id));
}

export function validateTestInventory(inventory, discovered) {
  const errors = [];
  const declaredById = uniqueById(inventory.contracts ?? [], "declared", errors);
  const discoveredById = uniqueById(discovered, "discovered", errors);

  for (const [id, contract] of discoveredById) {
    const declared = declaredById.get(id);
    if (!declared) {
      errors.push(`Missing inventory owner for ${id}`);
      continue;
    }
    if (declared.layer !== contract.layer) errors.push(`Layer mismatch for ${id}: ${declared.layer} != ${contract.layer}`);
    if (!sameStrings(declared.owners, contract.owners)) errors.push(`Owner mismatch for ${id}`);
    if (contract.layer === "blackbox" && !declared.processBoundaryRationale?.trim()) {
      errors.push(`Missing black-box process-boundary rationale for ${id}`);
    }
  }
  for (const id of declaredById.keys()) {
    if (!discoveredById.has(id)) errors.push(`Inventory declares missing contract ${id}`);
  }

  const baselineIds = new Set((inventory.baseline?.contracts ?? []).map((contract) => contract.id));

  const migrations = new Map((inventory.migrations ?? []).map((entry) => [entry.baselineId, entry]));
  for (const id of baselineIds) {
    const migration = migrations.get(id);
    const hasReplacement = Array.isArray(migration?.finalIds) && migration.finalIds.length > 0;
    const hasDeletion = migration?.deleted === true;
    if (hasReplacement === hasDeletion) {
      errors.push(`Migration for ${id} must declare exactly one replacement mapping or deletion`);
      continue;
    }
    if (hasDeletion) {
      if (typeof migration.reason !== "string" || !migration.reason.trim()) {
        errors.push(`Deletion migration for ${id} requires a reason`);
      }
    } else {
      for (const finalId of migration.finalIds) {
        if (!declaredById.has(finalId)) errors.push(`Migration for ${id} references missing contract ${finalId}`);
      }
    }
  }
  const blackboxBudget = inventory.execution?.budgets?.blackbox;
  const blackboxCount = discovered.filter((contract) => contract.layer === "blackbox").length;
  if (!Number.isInteger(blackboxBudget) || blackboxBudget < 0) errors.push("Invalid black-box contract budget");
  else if (blackboxCount > blackboxBudget) errors.push(`Black-box contract budget exceeded: ${blackboxCount} > ${blackboxBudget}`);
  const budgets = inventory.execution?.budgets ?? {};
  const performanceBudgets = [
    ["local median", budgets.localMedianMs],
    ["local maximum", budgets.localMaxMs],
    ["CI maximum", budgets.ciMaxMs],
  ];
  for (const [label, value] of performanceBudgets) {
    if (!Number.isInteger(value) || value < 1) errors.push(`Invalid ${label} performance budget`);
  }
  if (
    Number.isInteger(budgets.localMedianMs)
    && Number.isInteger(budgets.localMaxMs)
    && budgets.localMaxMs < budgets.localMedianMs
  ) {
    errors.push("Local maximum performance budget is below the local median budget");
  }


  const discoveredBlackboxOwners = [...new Set(discovered.filter((contract) => contract.layer === "blackbox").flatMap((contract) => contract.owners))];
  const declaredBlackboxOwners = inventory.execution?.layers?.blackbox?.ownerOrder ?? [];
  if (!sameStrings(discoveredBlackboxOwners, declaredBlackboxOwners)) errors.push("Black-box owner order does not match discovered owners");
  if (declaredBlackboxOwners.length !== new Set(declaredBlackboxOwners).size) errors.push("Black-box owner order contains duplicates");
  for (const layer of ["integration", "blackbox"]) {
    const concurrency = inventory.execution?.layers?.[layer]?.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) errors.push(`Invalid ${layer} concurrency`);
  }

  return errors;
}

export function extractContractNames(source) {
  const names = [];
  visit(source);
  return names;

  function visit(node) {
    if (
      isCallExpression(node)
      && isIdentifier(node.expression)
      && node.expression.text === "test"
      && node.arguments.length > 0
      && (isStringLiteral(node.arguments[0]) || isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      names.push(node.arguments[0].text);
    }
    node.forEachChild(visit);
  }
}

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function isTestSource(path) {
  return /\.test\.(?:js|ts)$/.test(path);
}

function layerFor(source) {
  if (source.includes("/unit/")) return "unit";
  if (source.includes("/integration/")) return "integration";
  return "blackbox";
}

function uniqueById(contracts, label, errors) {
  const result = new Map();
  for (const contract of contracts) {
    if (result.has(contract.id)) errors.push(`Duplicate ${label} contract ${contract.id}`);
    result.set(contract.id, contract);
    if (!Array.isArray(contract.owners) || contract.owners.length !== new Set(contract.owners).size || contract.owners.length === 0) {
      errors.push(`Invalid ${label} ownership for ${contract.id}`);
    }
  }
  return result;
}

function sameStrings(left = [], right = []) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
