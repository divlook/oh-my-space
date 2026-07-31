import { spawnSync } from "node:child_process";
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

const phases = [
  ["npm", ["run", "build"]],
  ["npm", ["run", "test:compile"]],
  [process.execPath, ["scripts/run-test-layer.mjs", ".test-dist/tests/unit"]],
  [process.execPath, ["scripts/run-test-layer.mjs", ".test-dist/tests/integration", "4"]],
  [process.execPath, ["scripts/run-test-layer.mjs", "tests", "6"]],
];

for (const [command, args] of phases) {
  const result = spawnSync(command, args, {
    cwd: before.root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status === 0) continue;
  if (previous?.key === key) invalidateVerificationRecord(before.root, key);
  const detail = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
  console.error(`Canonical verification failed: ${command} ${args.join(" ")} (${detail})`);
  process.exit(result.status ?? 1);
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
