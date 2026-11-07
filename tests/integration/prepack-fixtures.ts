import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after } from "node:test";
import { collectEnvironmentIdentity, normalizedTestEnvironment } from "../../scripts/verification/environment.mjs";
import { computeFingerprint } from "../../scripts/verification/fingerprint.mjs";
import { writeVerificationRecord } from "../../scripts/verification/record.mjs";

const roots: string[] = [];

const prepackScript = resolve("scripts/prepack.mjs");

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

export function fixture(): { root: string; env: NodeJS.ProcessEnv; capture: string } {
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

export function recordCurrent(root: string, env: NodeJS.ProcessEnv): void {
  const current = computeFingerprint({ cwd: root, env });
  writeVerificationRecord(root, {
    fingerprint: current.fingerprint,
    environment: collectEnvironmentIdentity({ cwd: root, env }),
    verifiedAt: "2026-07-31T00:00:00.000Z",
  });
}

export function runPrepack(root: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [prepackScript], { cwd: root, env, encoding: "utf8" });
}
