import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const inventory = JSON.parse(readFileSync(resolve(root, "tests/test-inventory.json"), "utf8"));
const options = parseOptions(process.argv.slice(2), inventory.execution.layers);
const durationsMs = [];
const runtime = spawnSync(options.node, ["--version"], { encoding: "utf8" }).stdout.trim();

for (let run = 1; run <= options.runs; run += 1) {
  const started = performance.now();
  const result = spawnSync(options.node, ["scripts/test.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      OMS_TEST_BENCHMARK: "1",
      OMS_TEST_INTEGRATION_CONCURRENCY: String(options.integration),
      OMS_TEST_BLACKBOX_CONCURRENCY: String(options.blackbox),
    },
  });
  const durationMs = Math.round(performance.now() - started);
  durationsMs.push(durationMs);
  console.log(`${options.label} run ${run}/${options.runs}: ${durationMs}ms on ${runtime}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const sorted = [...durationsMs].sort((left, right) => left - right);
const medianMs = sorted[Math.floor(sorted.length / 2)];
const meanMs = durationsMs.reduce((sum, duration) => sum + duration, 0) / durationsMs.length;
const varianceMs2 = Math.round(durationsMs.reduce((sum, duration) => sum + (duration - meanMs) ** 2, 0) / durationsMs.length);
const maxMs = Math.max(...durationsMs);
const entry = {
  label: options.label,
  measuredAt: new Date().toISOString(),
  runtime,
  runs: options.runs,
  integrationConcurrency: options.integration,
  blackboxConcurrency: options.blackbox,
  durationsMs,
  medianMs,
  varianceMs2,
  maxMs,
  gating: options.gating || options.ciGating,
};
const output = resolve(root, "openspec/changes/restore-test-performance-budget/evidence/suite-benchmarks.json");
mkdirSync(dirname(output), { recursive: true });
const evidence = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : { schemaVersion: 1, measurements: [] };
evidence.measurements = [...evidence.measurements.filter((measurement) => measurement.label !== options.label), entry];
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(entry));
if (options.gating || options.ciGating) {
  const failures = options.ciGating
    ? [
        ...(!/^v(?:20\.19\.0|24\.)/.test(runtime) ? [`Expected Node 20.19.0 or Node 24, received ${runtime}`] : []),
        ...(maxMs > 60_000 ? [`Maximum ${maxMs}ms exceeds 60000ms`] : []),
      ]
    : [
        ...(!/^v24\./.test(runtime) ? [`Expected Node 24, received ${runtime}`] : []),
        ...(options.runs < 3 ? [`Expected at least 3 runs, received ${options.runs}`] : []),
        ...(medianMs > 60_000 ? [`Median ${medianMs}ms exceeds 60000ms`] : []),
        ...(maxMs > 75_000 ? [`Maximum ${maxMs}ms exceeds 75000ms`] : []),
      ];
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
}

function parseOptions(args, layers) {
  const value = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const node = value("--node", process.execPath);
  const runs = Number.parseInt(value("--runs", "1"), 10);
  const integration = Number.parseInt(value("--integration", String(layers.integration.concurrency)), 10);
  const blackbox = Number.parseInt(value("--blackbox", String(layers.blackbox.concurrency)), 10);
  const label = value("--label", "manual");
  const gating = args.includes("--gating");
  const ciGating = args.includes("--ci-gating");
  if (!node || !label || !Number.isInteger(runs) || runs < 1 || !Number.isInteger(integration) || integration < 1 || !Number.isInteger(blackbox) || blackbox < 1) {
    console.error("Usage: node scripts/benchmark-test-suite.mjs [--node <executable>] [--runs N] [--integration N] [--blackbox N] [--label name] [--gating | --ci-gating]");
    process.exit(2);
  }
  return { node, runs, integration, blackbox, label, gating, ciGating };
}
