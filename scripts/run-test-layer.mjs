import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const [directory, concurrencyOption] = process.argv.slice(2);
if (!directory) {
  console.error("Usage: node scripts/run-test-layer.mjs <directory> [unit|integration|blackbox|concurrency]");
  process.exit(2);
}
const inventory = JSON.parse(readFileSync(resolve("tests/test-inventory.json"), "utf8"));
const layerConfig = inventory.execution?.layers?.[concurrencyOption];
const benchmarkOverride = process.env.OMS_TEST_BENCHMARK === "1" && concurrencyOption
  ? process.env[`OMS_TEST_${concurrencyOption.toUpperCase()}_CONCURRENCY`]
  : undefined;
const namedLayer = ["unit", "integration", "blackbox"].includes(concurrencyOption);
const concurrency = benchmarkOverride ?? layerConfig?.concurrency ?? (namedLayer ? undefined : concurrencyOption);
const executionMode = concurrencyOption === "blackbox" ? "owned-processes" : "node-test";
if ((executionMode === "owned-processes" && concurrency === undefined)
  || (concurrency !== undefined && (!/^[1-9]\d*$/.test(String(concurrency)) || !Number.isSafeInteger(Number(concurrency))))) {
  console.error(`Invalid test concurrency: ${concurrency}`);
  process.exit(2);
}

const files = collect(resolve(directory));
if (layerConfig?.ownerOrder) {
  const order = new Map(layerConfig.ownerOrder.map((owner, index) => [owner, index]));
  files.sort((left, right) => (order.get(relative(process.cwd(), left)) ?? Number.MAX_SAFE_INTEGER)
    - (order.get(relative(process.cwd(), right)) ?? Number.MAX_SAFE_INTEGER));
}
if (files.length === 0) {
  console.error(`No test files found under ${directory}.`);
  process.exit(1);
}
let env = process.env;
if (executionMode === "owned-processes" || concurrencyOption === "integration") {
  const { prepareSharedFixtures } = await import("../tests/helpers.js");
  env = prepareSharedFixtures();
}
if (executionMode === "owned-processes") {
  const statuses = await runOwnedFiles(files, Number.parseInt(concurrency, 10), env);
  process.exit(statuses.every((status) => status === 0) ? 0 : 1);
}
const args = ["--test", "--test-reporter=dot"];
if (concurrency) args.push(`--test-concurrency=${concurrency}`);
args.push(...files);
const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function collect(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
  }
  return files.sort();
}

async function runOwnedFiles(files, concurrency, env) {
  const statuses = new Array(files.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      statuses[index] = await runOwnedFile(files[index], env);
    }
  });
  await Promise.all(workers);
  return statuses;
}

function runOwnedFile(file, env) {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(process.execPath, ["--test", file], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      if (spawnError) return reject(spawnError);
      if (code === 0) {
        console.log(`[OK] ${relative(process.cwd(), file)}`);
      } else {
        process.stdout.write(Buffer.concat(stdout));
        process.stderr.write(Buffer.concat(stderr));
      }
      resolveStatus(code ?? 1);
    });
  });
}
