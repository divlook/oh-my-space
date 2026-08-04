import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { isCallExpression, isIdentifier, isNoSubstitutionTemplateLiteral, isStringLiteral } from "typescript/unstable/ast/is";


/** Discovers executable test contracts and their deterministic owners. */
export function discoverTestContracts(root) {
  const testsRoot = resolve(root, "tests");
  const files = collect(testsRoot).filter(isTestSource);
  const sources = new Map(files.map((file) => [relative(root, file), readFileSync(file, "utf8")]));
  const wrappers = discoverWrappers(sources);
  const contracts = [];
  const api = new API({ cwd: root });

  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    for (const [source] of sources) {
      const file = resolve(root, source);
      const sourceFile = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
      if (!sourceFile) throw new Error(`TypeScript did not parse test source ${source}`);
      const names = extractContractNames(sourceFile);
      for (const [ordinal, name] of names.entries()) {
        const owners = ownersFor(source, name, ordinal, wrappers);
        contracts.push({
          id: `${source}::${name}`,
          name,
          source,
          layer: layerFor(source),
          owners,
        });
      }
    }
  } finally {
    api.close();
  }

  return contracts.sort((left, right) => left.id.localeCompare(right.id));
}

/** Validates discovered contracts against the committed ownership inventory. */
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
  const migrations = new Map((inventory.migrations ?? []).map((entry) => [entry.baselineId, entry.finalIds]));
  for (const id of baselineIds) {
    const finalIds = migrations.get(id);
    if (!Array.isArray(finalIds) || finalIds.length === 0) errors.push(`Missing migration mapping for ${id}`);
    else for (const finalId of finalIds) {
      if (!declaredById.has(finalId)) errors.push(`Migration for ${id} references missing contract ${finalId}`);
    }
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

/** Extracts literal node:test contract names in declaration order. */
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
  return /(?:\.test|\.contracts)\.(?:js|ts)$/.test(path);
}

function discoverWrappers(sources) {
  const wrappers = new Map();
  for (const [owner, content] of sources) {
    const imported = content.match(/await import\(["'](\.\/[^"']+\.contracts\.(?:js|ts))["']\)/)?.[1];
    if (!imported) continue;
    const source = resolveImport(owner, imported);
    const numeric = content.match(/OMS_TEST_SHARD\s*=\s*["'](\d+)\/(\d+)["']/);
    const namedBody = content.match(/OMS_TEST_SHARD_NAMES\s*=\s*JSON\.stringify\(\[([\s\S]*?)\]\)/)?.[1];
    const names = namedBody ? [...namedBody.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]) : null;
    const entries = wrappers.get(source) ?? [];
    entries.push({
      owner,
      index: numeric ? Number.parseInt(numeric[1], 10) : null,
      count: numeric ? Number.parseInt(numeric[2], 10) : null,
      names,
    });
    wrappers.set(source, entries);
  }
  return wrappers;
}

function resolveImport(owner, imported) {
  const ownerParts = owner.split("/");
  ownerParts.pop();
  for (const part of imported.split("/")) {
    if (part === ".") continue;
    if (part === "..") ownerParts.pop();
    else ownerParts.push(part);
  }
  return ownerParts.join("/");
}

function ownersFor(source, name, ordinal, wrappers) {
  const candidates = wrappers.get(source);
  if (!candidates) return [source];
  const named = candidates.filter((candidate) => candidate.names?.includes(name));
  if (named.length > 0) return named.map((candidate) => candidate.owner).sort();
  const numeric = candidates.filter((candidate) => candidate.count && ordinal % candidate.count === candidate.index);
  return numeric.map((candidate) => candidate.owner).sort();
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
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
