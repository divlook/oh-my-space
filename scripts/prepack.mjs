import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectEnvironmentIdentity, normalizedTestEnvironment } from "./verification/environment.mjs";
import { computeFingerprint } from "./verification/fingerprint.mjs";
import {
  invalidateVerificationRecord,
  readVerificationRecord,
  recordMatches,
  verificationKey,
} from "./verification/record.mjs";

const env = normalizedTestEnvironment();
const current = computeFingerprint({ env });
const environment = collectEnvironmentIdentity({ cwd: current.root, env });
const currentKey = verificationKey(current.fingerprint, environment);
const record = readVerificationRecord(current.root);
const forced = process.env.OMS_FORCE_TEST === "1";
const reusable = !forced && recordMatches(record, current.fingerprint, environment);

if (reusable) {
  console.log(`Reusing canonical tests verified at ${record.verifiedAt}.`);
  if (process.env.OMS_VERIFICATION_VERBOSE === "1") {
    console.log(JSON.stringify({
      verification: "reused",
      verifiedAt: record.verifiedAt,
      fingerprint: record.fingerprint,
      environment: record.environment,
      command: record.command,
    }, null, 2));
  }
} else {
  const reason = forced ? "OMS_FORCE_TEST=1" : record ? "verification inputs changed" : "no valid verification record";
  console.log(`Running canonical tests (${reason}).`);
  run("npm", ["test"], false);
}

try {
  run("npm", ["run", "build"], true);
  verifyArtifact(current.root);
} catch (error) {
  const latest = readVerificationRecord(current.root);
  if (latest?.key === currentKey) invalidateVerificationRecord(current.root, currentKey);
  throw error;
}

function run(command, args, artifactPhase) {
  const result = spawnSync(command, args, {
    cwd: current.root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status === 0) return;
  const detail = result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
  const error = new Error(`${command} ${args.join(" ")} failed with ${detail}`);
  if (artifactPhase) error.artifactPhase = true;
  throw error;
}

function verifyArtifact(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
    throw new Error("Package and lockfile versions do not agree.");
  }
  const result = spawnSync(process.execPath, ["dist/oms.js", "--version"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Fresh CLI smoke check failed: ${result.stderr || result.stdout}`);
  if (result.stdout.trim() !== packageJson.version) {
    throw new Error(`Fresh CLI version ${JSON.stringify(result.stdout.trim())} does not match package version ${JSON.stringify(packageJson.version)}.`);
  }
}
