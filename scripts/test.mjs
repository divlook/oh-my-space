import { spawn, spawnSync } from "node:child_process";
import { collectEnvironmentIdentity, normalizedTestEnvironment } from "./verification/environment.mjs";
import { computeFingerprint } from "./verification/fingerprint.mjs";
import {
  invalidateVerificationRecord,
  readVerificationRecord,
  verificationKey,
  writeVerificationRecord,
} from "./verification/record.mjs";

const env = normalizedTestEnvironment();
const before = computeFingerprint({ env });
const environment = collectEnvironmentIdentity({ cwd: before.root, env });
const key = verificationKey(before.fingerprint, environment);
const previous = readVerificationRecord(before.root);

const buildPhases = [
  [process.execPath, ["scripts/build.mjs"]],
  [process.execPath, ["scripts/compile-tests.mjs"]],
];
const phases = [
  [process.execPath, ["scripts/validate-test-inventory.mjs"]],
  [process.execPath, ["scripts/run-test-layer.mjs", ".test-dist/tests/unit", "unit"]],
];
const realGitPhases = [
  [process.execPath, ["scripts/run-test-layer.mjs", ".test-dist/tests/integration", "integration"]],
  [process.execPath, ["scripts/run-test-layer.mjs", "tests", "blackbox"]],
];

for (const outcome of await Promise.all(buildPhases.map(runConcurrentPhase))) {
  exitOnFailure(outcome);
}
for (const [command, args] of phases) {
  const result = spawnSync(command, args, {
    cwd: before.root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  exitOnFailure({ command, args, status: result.status, signal: result.signal, error: result.error });
}
for (const outcome of await Promise.all(realGitPhases.map(runConcurrentPhase))) {
  exitOnFailure(outcome);
}

const after = computeFingerprint({ cwd: before.root, env });
if (after.fingerprint !== before.fingerprint) {
  console.warn("Warning: test-relevant inputs changed during npm test; no verification record was written.");
  if (previous?.key === key) invalidateVerificationRecord(before.root, key);
  process.exit(0);
}

try {
  writeVerificationRecord(before.root, {
    fingerprint: before.fingerprint,
    environment,
    command: "npm test",
  });
  console.log(`Recorded canonical verification ${key.slice(0, 12)}.`);
} catch (error) {
  console.warn(`Warning: canonical tests passed but the verification record could not be written: ${error instanceof Error ? error.message : String(error)}`);
}

function runConcurrentPhase([command, args]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: before.root,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", (error) => resolve({ command, args, status: null, signal: null, error }));
    child.on("close", (status, signal) => resolve({ command, args, status, signal }));
  });
}

function exitOnFailure({ command, args, status, signal, error }) {
  if (status === 0) return;
  if (previous?.key === key) invalidateVerificationRecord(before.root, key);
  const detail = error?.message ?? (status === null ? `signal ${signal ?? "unknown"}` : `exit ${status}`);
  console.error(`Canonical verification failed: ${command} ${args.join(" ")} (${detail})`);
  process.exit(status ?? 1);
}
