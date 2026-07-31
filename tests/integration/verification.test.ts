import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { normalizedTestEnvironment } from "../../scripts/verification/environment.mjs";
import { computeFingerprint } from "../../scripts/verification/fingerprint.mjs";
import {
  invalidateVerificationRecord,
  readVerificationRecord,
  verificationKey,
  writeVerificationRecord,
} from "../../scripts/verification/record.mjs";

const roots: string[] = [];
const env = normalizedTestEnvironment();

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "oms-verification-test-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main", root], { env, stdio: "ignore" });
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
}

function commitAll(root: string): void {
  git(root, "add", "-A");
  git(root, "commit", "-m", "fixture");
}

test("fingerprint is stable and sensitive to path, content, mode, and relevant untracked files", () => {
  const root = repository();
  writeFileSync(join(root, "source.txt"), "one\n");
  commitAll(root);

  const initial = computeFingerprint({ cwd: root, env });
  assert.deepEqual(computeFingerprint({ cwd: root, env }), initial);
  const trackedTree = execFileSync("git", ["ls-tree", "-r", "HEAD"], { cwd: root, env });
  assert.equal(
    computeFingerprint({ cwd: root, env, includeUntracked: false }).fingerprint,
    createHash("sha256").update(trackedTree).digest("hex"),
  );

  writeFileSync(join(root, "source.txt"), "two\n");
  assert.notEqual(computeFingerprint({ cwd: root, env }).fingerprint, initial.fingerprint);
  writeFileSync(join(root, "source.txt"), "one\n");
  chmodSync(join(root, "source.txt"), 0o755);
  assert.notEqual(computeFingerprint({ cwd: root, env }).fingerprint, initial.fingerprint);
  chmodSync(join(root, "source.txt"), 0o644);

  writeFileSync(join(root, "new-source.ts"), "export {};\n");
  assert.notEqual(computeFingerprint({ cwd: root, env }).fingerprint, initial.fingerprint);
  assert.equal(computeFingerprint({ cwd: root, env, includeUntracked: false }).fingerprint, initial.fingerprint);
});

test("fingerprint excludes only declared generated and record paths and includes unknown paths", () => {
  const root = repository();
  writeFileSync(join(root, "source.txt"), "one\n");
  commitAll(root);
  const initial = computeFingerprint({ cwd: root, env }).fingerprint;

  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "oms.js"), "generated\n");
  mkdirSync(join(root, "openspec"));
  writeFileSync(join(root, "openspec", "notes.md"), "planning\n");
  writeFileSync(join(root, ".oms-verification.json"), "record\n");
  assert.equal(computeFingerprint({ cwd: root, env }).fingerprint, initial);

  writeFileSync(join(root, "unknown.config"), "affects outcomes until proven otherwise\n");
  assert.notEqual(computeFingerprint({ cwd: root, env }).fingerprint, initial);
});

test("beta normalization accepts only the expected HEAD-derived three-field transform", () => {
  const root = repository();
  const stable = "1.2.3";
  const packageJson = { name: "fixture", version: stable, scripts: { test: "node test.js" } };
  const packageLock = { name: "fixture", version: stable, lockfileVersion: 3, packages: { "": { name: "fixture", version: stable } } };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`);
  commitAll(root);
  const stableFingerprint = computeFingerprint({ cwd: root, env }).fingerprint;
  const beta = `${stable}-beta.sha-${git(root, "rev-parse", "--short=7", "HEAD")}`;

  writeFileSync(join(root, "package.json"), `${JSON.stringify({ ...packageJson, version: beta }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ ...packageLock, version: beta, packages: { "": { ...packageLock.packages[""], version: beta } } }, null, 2)}\n`);
  assert.equal(computeFingerprint({ cwd: root, env }).fingerprint, stableFingerprint);

  const changed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  changed.scripts.test = "node other.js";
  writeFileSync(join(root, "package.json"), `${JSON.stringify(changed, null, 2)}\n`);
  assert.notEqual(computeFingerprint({ cwd: root, env }).fingerprint, stableFingerprint);

  changed.scripts.test = packageJson.scripts.test;
  changed.version = `${stable}-beta.sha-deadbee`;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(changed, null, 2)}\n`);
  assert.notEqual(computeFingerprint({ cwd: root, env }).fingerprint, stableFingerprint);
});

test("records are atomic, malformed-safe, matching-key invalidated, and worktree-local", () => {
  const first = repository();
  const second = repository();
  const environment = { node: "v24", git: "git version 2", os: "Darwin", osVersion: "25", arch: "arm64" };
  const fingerprint = "f".repeat(64);
  const record = writeVerificationRecord(first, { fingerprint, environment, verifiedAt: "2026-07-31T00:00:00.000Z" });

  assert.deepEqual(readVerificationRecord(first), record);
  assert.equal(readVerificationRecord(second), null);
  assert.equal(invalidateVerificationRecord(first, verificationKey("0".repeat(64), environment)), false);
  assert.ok(readVerificationRecord(first));
  assert.equal(invalidateVerificationRecord(first, record.key), true);
  assert.equal(readVerificationRecord(first), null);

  writeFileSync(join(first, ".oms-verification.json"), "not json");
  assert.equal(readVerificationRecord(first), null);

  rmSync(join(first, ".oms-verification.json"), { force: true });
  mkdirSync(join(first, ".oms-verification.json"));
  assert.throws(
    () => writeVerificationRecord(first, { fingerprint, environment }),
    /directory|EISDIR|ENOTDIR/i,
  );
  assert.equal(readVerificationRecord(first), null);
});
