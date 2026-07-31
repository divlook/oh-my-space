import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after } from "node:test";
import test from "../sharded-test.js";
import { collectEnvironmentIdentity, normalizedTestEnvironment } from "../../scripts/verification/environment.mjs";
import { computeFingerprint } from "../../scripts/verification/fingerprint.mjs";
import { readVerificationRecord, writeVerificationRecord } from "../../scripts/verification/record.mjs";

const roots: string[] = [];
const prepackScript = resolve("scripts/prepack.mjs");

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; env: NodeJS.ProcessEnv; capture: string } {
  const root = mkdtempSync(join(tmpdir(), "oms-prepack-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const capture = join(root, "openspec", "npm-calls");
  mkdirSync(bin);
  mkdirSync(join(root, "openspec"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.2.3", type: "module" }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.2.3" } } }, null, 2)}\n`);
  const fakeNpm = join(bin, "npm");
  writeFileSync(fakeNpm, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(capture)}
if [ "$1 $2" = "run build" ]; then
  mkdir -p dist
  version="${"${OMS_TEST_ARTIFACT_VERSION:-1.2.3}"}"
  cat > dist/oms.js <<EOF
console.log("$version");
EOF
fi
exit 0
`);
  chmodSync(fakeNpm, 0o755);
  const env = normalizedTestEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });
  execFileSync("git", ["init", "-b", "main", root], { env, stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "package.json", "package-lock.json"], { env });
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"], { env, stdio: "ignore" });
  return { root, env, capture };
}

function recordCurrent(root: string, env: NodeJS.ProcessEnv): void {
  const current = computeFingerprint({ cwd: root, env });
  writeVerificationRecord(root, {
    fingerprint: current.fingerprint,
    environment: collectEnvironmentIdentity({ cwd: root, env }),
    verifiedAt: "2026-07-31T00:00:00.000Z",
  });
}

function runPrepack(root: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [prepackScript], { cwd: root, env, encoding: "utf8" });
}

test("matching verification skips only tests, rebuilds, and reports concise or verbose audit output", () => {
  const { root, env, capture } = fixture();
  recordCurrent(root, env);
  const concise = runPrepack(root, env);
  assert.equal(concise.status, 0, concise.stdout + concise.stderr);
  assert.match(concise.stdout, /Reusing canonical tests verified at/);
  assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n"), ["run build"]);

  const verbose = runPrepack(root, { ...env, OMS_VERIFICATION_VERBOSE: "1" });
  assert.equal(verbose.status, 0, verbose.stdout + verbose.stderr);
  assert.match(verbose.stdout, /"fingerprint"/);
  assert.match(verbose.stdout, /"command": "npm test"/);
});

test("missing, malformed, and forced verification run the canonical suite before rebuilding", () => {
  for (const mode of ["missing", "malformed", "forced"] as const) {
    const { root, env, capture } = fixture();
    if (mode === "malformed") writeFileSync(join(root, ".oms-verification.json"), "{");
    if (mode === "forced") recordCurrent(root, env);
    const result = runPrepack(root, mode === "forced" ? { ...env, OMS_FORCE_TEST: "1" } : env);
    assert.equal(result.status, 0, `${mode}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(readFileSync(capture, "utf8").trim().split("\n"), ["test", "run build"], mode);
  }
});

test("artifact version failure blocks packaging and invalidates the matching record", () => {
  const { root, env } = fixture();
  recordCurrent(root, env);
  const result = runPrepack(root, { ...env, OMS_TEST_ARTIFACT_VERSION: "9.9.9" });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /does not match package version/);
  assert.equal(readVerificationRecord(root), null);
});
