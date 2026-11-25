import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runIndependentStatus as runStatus } from "../../scripts/lib/status.js";
import { git, gitOut, sourcesFor, tempWorkspace, testEnv, workspaceWithApi, writeSources } from "../helpers.js";

Object.assign(process.env, testEnv);

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

  const data = JSON.parse(output);
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
  assert.equal(data.schemaVersion, 2);
  assert.equal(typeof data.toolVersion, "string");
  assert.equal(data.workspaceRoot, realpathSync(cwd));
  assert.equal(data.currentAlias, null);
  assert.deepEqual(data.errors, []);
  assert.deepEqual(data.root, {
    branch: "main",
    head: gitOut(cwd, "rev-parse", "--short", "HEAD"),
    detached: false,
    dirty: false,
    changes: { staged: 0, unstaged: 0, untracked: 0 },
  });
  const repo = data.repos[0];
  assert.equal(repo.alias, "api");
  assert.equal(repo.path, "oms/api");
  assert.equal(repo.absolutePath, join(realpathSync(cwd), "oms", "api"));
  assert.equal(repo.configured, true);
  assert.equal(repo.initialized, true);
  assert.equal(Object.hasOwn(repo, "pin"), false);
  assert.equal(repo.error, null);
});

async function statusJsonAt(cwd: string, aliases: string[] = [], expectedExit = 0) {
  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    process.chdir(cwd);
    assert.equal(await runStatus(aliases, { json: true }), expectedExit);
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output);
}

test("status JSON projects branch, tracking, and independent root and source changes in one Git journey", async () => {
  const { cwd, bare } = workspaceWithApi();
  const api = join(cwd, "oms", "api");
  git(api, "switch", "-c", "feature/no-upstream");
  const untracked = (await statusJsonAt(cwd)).repos[0];
  assert.equal(untracked.branch, "feature/no-upstream");
  assert.equal(untracked.trackingBranch, null);
  assert.equal(untracked.ahead, null);
  assert.equal(untracked.behind, null);

  git(api, "switch", "main");
  writeFileSync(join(api, "ahead.txt"), "x");
  git(api, "add", "-A");
  git(api, "commit", "-m", "local work");
  const ahead = (await statusJsonAt(cwd)).repos[0];
  assert.equal(ahead.trackingBranch, "origin/main");
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.behind, 0);

  const remoteWriter = tempWorkspace();
  git(remoteWriter, "clone", "--branch", "main", `file://${bare}`, ".");
  writeFileSync(join(remoteWriter, "upstream.txt"), "remote");
  git(remoteWriter, "add", "upstream.txt");
  git(remoteWriter, "commit", "-m", "upstream work");
  git(remoteWriter, "push", "origin", "main");
  git(api, "fetch", "origin");

  writeFileSync(join(cwd, "NOTES.md"), "root notes");
  writeFileSync(join(api, "staged.txt"), "staged");
  git(api, "add", "staged.txt");
  writeFileSync(join(api, "ahead.txt"), "changed");
  writeFileSync(join(api, "scratch.txt"), "untracked");
  const data = await statusJsonAt(api, ["api"]);
  assert.equal(data.currentAlias, "api");
  assert.deepEqual(data.root.changes, { staged: 0, unstaged: 0, untracked: 1 });
  assert.equal(data.root.dirty, true);
  assert.deepEqual(data.repos[0].changes, { staged: 1, unstaged: 1, untracked: 1 });
  assert.equal(data.repos[0].dirty, true);
  assert.equal(data.repos[0].ahead, 1);
  assert.equal(data.repos[0].behind, 1);

  git(api, "switch", "--detach");
  const detached = (await statusJsonAt(cwd)).repos[0];
  assert.equal(detached.branch, null);
  assert.equal(detached.detached, true);
  assert.equal(detached.head, gitOut(api, "rev-parse", "--short", "HEAD"));
  assert.equal(detached.trackingBranch, null);
  assert.equal(detached.ahead, null);
  assert.equal(detached.behind, null);
});

test("status JSON isolates unavailable source errors and preserves the occupied path", async () => {
  const { cwd, bare } = workspaceWithApi();
  writeSources(cwd, sourcesFor(["api", "api-extra", "missing"].map((alias) => ({ alias, bare }))));
  const occupiedPath = join("oms", "api-extra", "with\ta newline\nand spaces ");
  mkdirSync(join(cwd, "oms", "api-extra"));
  writeFileSync(join(cwd, occupiedPath), "root-owned file");
  git(cwd, "add", "--", occupiedPath);
  const index = gitOut(cwd, "ls-files", "--stage");

  const data = await statusJsonAt(cwd, ["api-extra", "api", "api-extra", "missing"], 2);
  assert.deepEqual(data.repos.map(({ alias }: { alias: string }) => alias), ["api-extra", "api", "missing"]);
  const [blocked, ready, absent] = data.repos;
  assert.equal(blocked.initialized, false);
  assert.match(blocked.error, /oms\/api-extra is tracked by the workspace root/);
  assert.equal(blocked.branch, null);
  assert.equal(blocked.head, null);
  assert.deepEqual(blocked.changes, { staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(ready.initialized, true);
  assert.equal(ready.error, null);
  assert.equal(absent.initialized, false);
  assert.equal(absent.error, null);
  assert.deepEqual(data.errors, [blocked.error]);
  assert.equal(data.root.changes.staged, 1);
  assert.deepEqual((await statusJsonAt(cwd, ["api"])).errors, []);
  assert.equal(readFileSync(join(cwd, occupiedPath), "utf8"), "root-owned file");
  assert.equal(gitOut(cwd, "ls-files", "--stage"), index);
});
