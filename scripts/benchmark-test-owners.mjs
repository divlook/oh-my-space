import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { discoverTestContracts } from "./test-inventory-lib.mjs";

const nodeOption = process.argv.indexOf("--node");
const node = nodeOption >= 0 ? process.argv[nodeOption + 1] : process.execPath;
const ownerOption = process.argv.indexOf("--owner");
const requestedOwner = ownerOption >= 0 ? process.argv[ownerOption + 1] : null;
const prefixOption = process.argv.indexOf("--owner-prefix");
const requestedPrefix = prefixOption >= 0 ? process.argv[prefixOption + 1] : null;
if (!node) {
  console.error("Usage: node scripts/benchmark-test-owners.mjs [--node <executable>] [--owner <test-file> | --owner-prefix <prefix>]");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const contracts = discoverTestContracts(root);
const discoveredOwners = [...new Set(contracts.flatMap((contract) => contract.owners))].sort();
if (requestedOwner && !discoveredOwners.includes(requestedOwner)) {
  console.error(`Unknown test owner: ${requestedOwner}`);
  process.exit(2);
}
const owners = requestedOwner
  ? [requestedOwner]
  : requestedPrefix
    ? discoveredOwners.filter((owner) => owner.startsWith(requestedPrefix))
    : discoveredOwners;
const output = resolve(root, "openspec/changes/restore-test-performance-budget/evidence/owner-durations.json");
const previous = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
const measurements = Object.fromEntries(
  discoveredOwners.flatMap((owner) => previous?.owners?.[owner] ? [[owner, previous.owners[owner]]] : []),
);

for (const owner of owners) {
  const executableOwner = owner.endsWith(".ts")
    ? `.test-dist/${owner.slice(0, -3)}.js`
    : owner;
  const started = performance.now();
  const result = spawnSync(node, ["--test", executableOwner], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  const durationMs = Math.round(performance.now() - started);
  measurements[owner] = { durationMs, status: result.status };
  console.log(`${owner}: ${durationMs}ms (${result.status === 0 ? "passed" : `exit ${result.status}`})`);
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  runtime: spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(),
  command: `${node} --test <owner>`,
  owners: measurements,
}, null, 2)}\n`);
console.log(`Recorded ${owners.length} owner measurements in ${output}.`);
