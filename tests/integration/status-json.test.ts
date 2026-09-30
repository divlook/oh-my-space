import assert from "node:assert/strict";
import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runStatus } from "../../scripts/lib/status.js";
import { git, tempWorkspace, workspaceWithApi } from "../helpers.js";

test("status JSON keeps its schema and canonical workspace path through a symlinked cwd", async () => {
  const { cwd } = workspaceWithApi();
  const linked = join(tempWorkspace(), "workspace");
  symlinkSync(cwd, linked);

  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(linked);
    assert.equal(await runStatus([], { all: true, json: true }), 0);
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalWrite;
  }

  assert.ok(output.startsWith("{"));
  assert.match(output, /\n  "schemaVersion": 1,/);
  assert.ok(output.endsWith("}\n"));
  const data = JSON.parse(output);
  assert.equal(output, `${JSON.stringify(data, null, 2)}\n`);
  assert.deepEqual(Object.keys(data).sort(), [
    "currentAlias",
    "errors",
    "repos",
    "root",
    "schemaVersion",
    "toolVersion",
    "trees",
    "workspaceRoot",
  ]);
  assert.equal(data.schemaVersion, 1);
  assert.equal(typeof data.toolVersion, "string");
  assert.equal(data.workspaceRoot, realpathSync(cwd));
  assert.equal(data.currentAlias, null);
  assert.deepEqual(data.errors, []);
  assert.ok(data.root && typeof data.root === "object");
  const repo = data.repos[0];
  assert.equal(repo.alias, "api");
  assert.equal(repo.path, "oms/api");
  assert.equal(repo.absolutePath, join(realpathSync(cwd), "oms", "api"));
  assert.equal(repo.configured, true);
  assert.equal(repo.initialized, true);
  assert.equal(repo.pin, "ok");
  assert.equal(repo.error, null);
});

async function statusJsonAt(cwd: string) {
  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(cwd);
    assert.equal(await runStatus([], { all: true, json: true }), 0);
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output);
}

test("status JSON projects branch, source, and pointer states in one Git journey", async () => {
  const { cwd } = workspaceWithApi();
  const api = join(cwd, "oms", "api");
  git(api, "switch", "-c", "feature/no-upstream");
  const untracked = (await statusJsonAt(cwd)).repos[0];
  assert.equal(untracked.trackingBranch, null);
  assert.equal(untracked.ahead, null);
  assert.equal(untracked.behind, null);

  git(api, "switch", "main");
  writeFileSync(join(api, "ahead.txt"), "x");
  git(api, "add", "-A");
  git(api, "commit", "-m", "local work");
  const ahead = (await statusJsonAt(cwd)).repos[0];
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.behind, 0);

  writeFileSync(join(cwd, "NOTES.md"), "hi");
  writeFileSync(join(api, "feature.txt"), "x");
  git(api, "add", "-A");
  git(api, "commit", "-m", "feature");
  writeFileSync(join(api, "scratch.txt"), "y");
  let data = await statusJsonAt(cwd);
  assert.equal(data.root.changes.untracked, 1);
  assert.equal(data.root.changes.staged, 0);
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  assert.equal(data.repos[0].changes.untracked, 1);
  assert.equal(data.repos[0].dirty, true);

  git(cwd, "add", "oms/api");
  data = await statusJsonAt(cwd);
  assert.deepEqual(data.root.submodulePointers.staged, ["api"]);
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  assert.deepEqual(data.root.submodulePointers.split, []);

  writeFileSync(join(api, "second.txt"), "next");
  git(api, "add", "second.txt");
  git(api, "commit", "-m", "second");
  data = await statusJsonAt(cwd);
  assert.deepEqual(data.root.submodulePointers.split, ["api"]);
  assert.deepEqual(data.root.submodulePointers.staged, ["api"]);
});
