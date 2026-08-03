import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { delimiter, join, resolve } from "node:path";
import test, { after } from "node:test";
import { collectEnvironmentIdentity, normalizedTestEnvironment } from "../../scripts/verification/environment.mjs";
import { computeFingerprint } from "../../scripts/verification/fingerprint.mjs";
import { readVerificationRecord, writeVerificationRecord } from "../../scripts/verification/record.mjs";

const roots: string[] = [];
const publisher = resolve("scripts/publish-beta.mjs");
const prepack = resolve("scripts/prepack.mjs");

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oms-beta-test-"));
  roots.push(root);
  const bin = join(root, ".fake-bin");
  const captureDir = join(root, ".captures");
  const calls = join(captureDir, "npm-calls");
  const versions = join(captureDir, "versions");
  mkdirSync(bin);
  mkdirSync(captureDir);
  mkdirSync(join(root, ".changeset"));
  writeFileSync(join(root, ".changeset", "config.json"), `${JSON.stringify({
    changelog: false,
    commit: false,
    fixed: [],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    ignore: [],
  }, null, 2)}\n`);
  writeFileSync(join(root, ".changeset", "beta.md"), '---\n"oh-my-space": major\n---\n\nPrepare the next beta.\n');
  writeFileSync(join(root, ".gitignore"), ".fake-bin/\n.captures/\n.oms-verification.json\ndist/\n");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "oh-my-space", version: "1.2.3", type: "module" }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ name: "oh-my-space", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "oh-my-space", version: "1.2.3" } } }, null, 2)}\n`);

  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [ "$1 $2" = "run build" ]; then
  mkdir -p dist
  version=$(${JSON.stringify(process.execPath)} -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
  printf 'console.log(%s);\\n' "\\\"$version\\\"" > dist/oms.js
  exit 0
fi
if [ "$1" = "test" ]; then exit 97; fi
if [ "$1" = "pack" ] || [ "$1" = "publish" ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(prepack)} || exit $?
  ${JSON.stringify(process.execPath)} -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("package.json")); const l=JSON.parse(fs.readFileSync("package-lock.json")); fs.appendFileSync(process.argv[1], JSON.stringify([p.version,l.version,l.packages[""].version])+"\\n")' ${JSON.stringify(versions)}
  if [ "$OMS_TEST_NPM_SLEEP" = "1" ]; then echo OMS_SIGNAL_READY; exec sleep 30; fi
  if [ "$OMS_TEST_NPM_FAIL" = "1" ]; then exit 42; fi
  exit 0
fi
exit 0
`);
  chmodSync(npm, 0o755);
  const env = normalizedTestEnvironment({ PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` });
  execFileSync("git", ["init", "-b", "main", root], { env, stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", ".gitignore", "package.json", "package-lock.json", ".changeset"], { env });
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"], { env, stdio: "ignore" });
  const current = computeFingerprint({ cwd: root, env });
  writeVerificationRecord(root, {
    fingerprint: current.fingerprint,
    environment: collectEnvironmentIdentity({ cwd: root, env }),
  });
  return { root, env, calls, versions };
}

function runPublisher(root: string, env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [publisher, ...args], { cwd: root, env, encoding: "utf8" });
}

function packageVersions(root: string): [string, string, string] {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  return [packageJson.version, packageLock.version, packageLock.packages[""].version];
}

test("beta dry-run and publish reuse stable verification, rebuild exact beta artifacts, restore metadata, and retain registry retries", async () => {
  const { root, env, calls, versions } = fixture();
  const stableRecord = readVerificationRecord(root);
  assert.ok(stableRecord);
  const shortHead = execFileSync("git", ["-C", root, "rev-parse", "--short=7", "HEAD"], { env, encoding: "utf8" }).trim();
  const expectedBeta = `2.0.0-beta.sha-${shortHead}`;

  const dryRun = runPublisher(root, env, ["--allow-dirty"]);
  assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr);
  assert.match(dryRun.stdout, /Reusing canonical tests verified at/);
  assert.deepEqual(packageVersions(root), ["1.2.3", "1.2.3", "1.2.3"]);

  const publish = runPublisher(root, env, ["--publish"]);
  assert.equal(publish.status, 0, publish.stdout + publish.stderr);
  assert.match(publish.stdout, /Reusing canonical tests verified at/);
  assert.deepEqual(packageVersions(root), ["1.2.3", "1.2.3", "1.2.3"]);
  assert.deepEqual(readFileSync(versions, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    [expectedBeta, expectedBeta, expectedBeta],
    [expectedBeta, expectedBeta, expectedBeta],
  ]);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /^test$/m);

  const registryFailure = runPublisher(root, { ...env, OMS_TEST_NPM_FAIL: "1" }, ["--publish"]);
  assert.notEqual(registryFailure.status, 0);
  assert.deepEqual(packageVersions(root), ["1.2.3", "1.2.3", "1.2.3"]);
  assert.deepEqual(readVerificationRecord(root), stableRecord);

  const child = spawn(process.execPath, [publisher, "--allow-dirty"], {
    cwd: root,
    env: { ...env, OMS_TEST_NPM_SLEEP: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  for await (const line of createInterface({ input: child.stdout })) {
    if (line === "OMS_SIGNAL_READY") break;
  }
  child.kill("SIGTERM");
  const [exit] = await once(child, "exit");
  assert.equal(exit, 143);
  assert.deepEqual(packageVersions(root), ["1.2.3", "1.2.3", "1.2.3"]);
  assert.deepEqual(readVerificationRecord(root), stableRecord);
});
