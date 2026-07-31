import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const [directory, concurrency] = process.argv.slice(2);
if (!directory) {
  console.error("Usage: node scripts/run-test-layer.mjs <directory> [concurrency]");
  process.exit(2);
}

const files = collect(resolve(directory));
if (files.length === 0) {
  console.error(`No test files found under ${directory}.`);
  process.exit(1);
}
const args = ["--test"];
if (concurrency) args.push(`--test-concurrency=${concurrency}`);
args.push(...files);
const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
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
