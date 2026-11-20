import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isArrowFunction,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExpressionStatement,
  isExternalModuleReference,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
} from "typescript/unstable/ast/is";

export function discoverTestContracts(root) {
  const testsRoot = resolve(root, "tests");
  const files = collect(testsRoot).filter((file) => /\.(?:js|ts)$/.test(file) && !file.endsWith(".d.ts"));
  const contracts = [];
  const api = new API({ cwd: root });

  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    for (const file of files) {
      const source = relative(root, file);
      const sourceFile = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
      if (!sourceFile) throw new Error(`TypeScript did not parse test source ${source}`);
      const names = extractContractNames(sourceFile);
      if (names.length > 0 && !isTestSource(source)) {
        throw new Error(`Test registrations must belong to a .test.js or .test.ts owner: ${source}`);
      }
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
    if (contract.layer === "blackbox"
      && (typeof declared.processBoundaryRationale !== "string" || !declared.processBoundaryRationale.trim())) {
      errors.push(`Missing black-box process-boundary rationale for ${id}; add processBoundaryRationale to its inventory entry`);
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
  const bindings = new Map();
  const callbacks = new Map();
  const names = [];
  const isNodeTestImport = (node) => isImportDeclaration(node)
    && literalText(node.moduleSpecifier) === "node:test";

  for (const statement of source.statements) {
    if (!isNodeTestImport(statement)) continue;
    const clause = statement.importClause;
    if (clause?.phaseModifier === SyntaxKind.TypeKeyword) continue;
    if (clause?.name) bindings.set(clause.name.text, true);
    if (!clause?.namedBindings) continue;
    if (!isNamedImports(clause.namedBindings)) unsupported(clause.namedBindings, "use named or default imports");
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (["default", "test", "it"].includes(imported)) bindings.set(specifier.name.text, true);
      else if (["after", "afterEach", "before", "beforeEach"].includes(imported)) bindings.set(specifier.name.text, false);
      else if (imported !== "mock" && imported !== "assert") unsupported(specifier, `unsupported node:test export ${imported}`);
    }
  }

  for (const statement of source.statements) {
    if (!isNodeTestImport(statement)) visit(statement);
  }
  return names;

  function visit(node, contextName) {
    const parent = node.parent;
    contextName = callbacks.get(node) ?? contextName;
    if (literalText(node) === "node:test"
      && ((isCallExpression(parent) && parent.arguments[0] === node
        && (parent.expression.kind === SyntaxKind.ImportKeyword
          || (isIdentifier(parent.expression) && parent.expression.text === "require")))
        || isExportDeclaration(parent) || isExternalModuleReference(parent))) {
      unsupported(node, "use a static node:test import");
    }
    if (isIdentifier(node) && bindings.has(node.text)
      && !((isPropertyAssignment(parent) || isPropertyAccessExpression(parent)) && parent.name === node)) {
      const registersTest = bindings.get(node.text);
      if (!isCallExpression(parent) || parent.expression !== node || parent.questionDotToken) {
        unsupported(node, "use a direct call to the imported binding");
      }
      if (registersTest) {
        if (!isExpressionStatement(parent.parent) || parent.parent.parent !== source) {
          unsupported(parent, "put each test call at the top level");
        }
        const name = parent.arguments.length > 0 ? literalText(parent.arguments[0]) : undefined;
        if (!name?.trim()) unsupported(parent, "give each test a nonempty literal name");
        names.push(name);
      }
      const callback = parent.arguments.at(-1);
      if (!callback || !(isArrowFunction(callback) || isFunctionExpression(callback))) {
        unsupported(parent, "use an inline test or hook callback");
      }
      const parameter = callback.parameters[0]?.name;
      if (parameter) {
        if (!isIdentifier(parameter)) unsupported(parameter, "use a plain test-context parameter, not destructuring");
        callbacks.set(callback, parameter.text);
      }
    }
    if (contextName && (isPropertyAccessExpression(node) || isElementAccessExpression(node))
      && isIdentifier(node.expression) && node.expression.text === contextName) {
      const name = isPropertyAccessExpression(node) ? node.name.text : literalText(node.argumentExpression);
      if (name === "test" || name === undefined) unsupported(node, "register subtests as separate top-level tests");
    }
    node.forEachChild((child) => visit(child, contextName));
  }

  function unsupported(node, reason) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    throw new Error(`Unsupported test registration in ${source.fileName}:${line + 1}:${character + 1}: ${reason}`);
  }
}

function literalText(node) {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
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
