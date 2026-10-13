import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runStatus } from "../../scripts/lib/status.js";
import { runTreeAdd, runTreeList, runTreeRemove } from "../../scripts/lib/tree-ops.js";
import { git, testEnv, workspaceWithApi } from "../helpers.js";

Object.assign(process.env, testEnv);

async function capture(cwd: string, action: () => Promise<number>): Promise<{ code: number; output: string }> {
  const originalCwd = process.cwd();
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let output = "";
  const write = (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  try {
    process.chdir(cwd);
    return { code: await action(), output };
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

test("tree list reports healthy and foreign entries and succeeds when inventory is empty", async () => {
  const { cwd } = workspaceWithApi();
  assert.equal((await capture(cwd, () => runTreeAdd("api", "t1", {}))).code, 0);
  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });

  const listed = await capture(cwd, () => runTreeList());
  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.output, /api\s+t1\s+t1\s+no\s+ok/);
  assert.match(listed.output, /api\s+stray\s+-\s+-\s+not a registered worktree/);

  assert.equal((await capture(cwd, () => runTreeRemove("api", "stray", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("api", "t1", {}))).code, 0);
  const empty = await capture(cwd, () => runTreeList());
  assert.equal(empty.code, 0, empty.output);
  assert.match(empty.output, /No managed trees/);
});

test("status JSON includes broken, foreign, and healthy trees and narrows aliases", async () => {
  const { cwd, bare } = workspaceWithApi();
  for (const alias of ["web", "orphan"]) {
    git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-b", "main", `file://${bare}`, `oms/${alias}`);
  }
  appendFileSync(join(cwd, "oms.yaml"), `  - alias: web\n    remotes:\n      origin: file://${bare}\n    branch: main\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add tree inventory sources");
  assert.equal((await capture(cwd, () => runTreeAdd("api", "t1", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeAdd("api", "broken", {}))).code, 0);
  rmSync(join(cwd, ".oms-tree", "api", "broken"), { recursive: true, force: true });
  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });
  mkdirSync(join(cwd, ".oms-tree", "web", "foreign"), { recursive: true });
  assert.equal((await capture(cwd, () => runTreeAdd("web", "other", {}))).code, 0);
  const orphanTree = join(cwd, ".oms-tree", "orphan", "task");
  git(join(cwd, "oms", "orphan"), "worktree", "add", "-b", "task", orphanTree);
  writeFileSync(join(cwd, ".oms-tree", "api", "t1", "scratch"), "selected dirty tree");
  writeFileSync(join(cwd, ".oms-tree", "web", "other", "scratch"), "unselected dirty tree");

  const allResult = await capture(cwd, () => runStatus([], { all: true, json: true }));
  assert.equal(allResult.code, 0, allResult.output);
  const all = JSON.parse(allResult.output);
  const healthy = all.trees.find((entry: { task: string }) => entry.task === "t1");
  const broken = all.trees.find((entry: { task: string }) => entry.task === "broken");
  const stray = all.trees.find((entry: { task: string }) => entry.task === "stray");
  const foreign = all.trees.find((entry: { task: string }) => entry.task === "foreign");
  assert.equal(all.schemaVersion, 1);
  assert.deepEqual(all.trees.map((entry: { path: string }) => entry.path), [
    ".oms-tree/api/broken",
    ".oms-tree/api/stray",
    ".oms-tree/api/t1",
    ".oms-tree/orphan/task",
    ".oms-tree/web/foreign",
    ".oms-tree/web/other",
  ]);
  assert.equal(healthy.dirty, true);
  assert.equal(all.trees.find((entry: { alias: string }) => entry.alias === "orphan").dirty, false);
  assert.equal(all.trees.find((entry: { task: string }) => entry.task === "other").dirty, true);
  assert.equal(healthy.error, null);
  assert.match(broken.error, /worktree link is broken/);
  assert.equal(stray.error, "not a registered worktree of any submodule");
  assert.equal(foreign.alias, "web");

  const filteredResult = await capture(cwd, () => runStatus(["api"], { json: true }));
  const filtered = JSON.parse(filteredResult.output);
  assert.deepEqual(filtered.trees.map((entry: { alias: string }) => entry.alias), ["api", "api", "api"]);
  assert.equal(filtered.trees.find((entry: { task: string }) => entry.task === "t1").dirty, true);
  const filteredText = await capture(cwd, () => runStatus(["api"], {}));
  assert.match(filteredText.output, /\.oms-tree\/api\/t1\s+t1\s+dirty/);
  assert.doesNotMatch(filteredText.output, /\.oms-tree\/(?:web|orphan)\//);
  const allText = await capture(cwd, () => runStatus([], {}));
  assert.match(allText.output, /\.oms-tree\/web\/other\s+other\s+dirty/);
  assert.match(allText.output, /\.oms-tree\/orphan\/task\s+task\s+clean/);

  assert.equal((await capture(cwd, () => runTreeRemove("api", "t1", { force: true }))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("web", "other", { force: true }))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("orphan", "task", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("api", "broken", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("api", "stray", {}))).code, 0);
  rmSync(join(cwd, ".oms-tree", "web"), { recursive: true, force: true });
  const emptyResult = await capture(cwd, () => runStatus([], { all: true, json: true }));
  assert.deepEqual(JSON.parse(emptyResult.output).trees, []);
});
