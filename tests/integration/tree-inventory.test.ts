import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runStatus } from "../../scripts/lib/status.js";
import { runTreeAdd, runTreeList, runTreeRemove } from "../../scripts/lib/tree-ops.js";
import { testEnv, workspaceWithApi } from "../helpers.js";

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
  const { cwd } = workspaceWithApi();
  assert.equal((await capture(cwd, () => runTreeAdd("api", "t1", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeAdd("api", "broken", {}))).code, 0);
  rmSync(join(cwd, ".oms-tree", "api", "broken"), { recursive: true, force: true });
  mkdirSync(join(cwd, ".oms-tree", "api", "stray"), { recursive: true });
  mkdirSync(join(cwd, ".oms-tree", "web", "foreign"), { recursive: true });

  const allResult = await capture(cwd, () => runStatus([], { all: true, json: true }));
  assert.equal(allResult.code, 0, allResult.output);
  const all = JSON.parse(allResult.output);
  const healthy = all.trees.find((entry: { task: string }) => entry.task === "t1");
  const broken = all.trees.find((entry: { task: string }) => entry.task === "broken");
  const stray = all.trees.find((entry: { task: string }) => entry.task === "stray");
  const foreign = all.trees.find((entry: { task: string }) => entry.task === "foreign");
  assert.equal(healthy.dirty, false);
  assert.equal(healthy.error, null);
  assert.match(broken.error, /worktree link is broken/);
  assert.equal(stray.error, "not a registered worktree of any submodule");
  assert.equal(foreign.alias, "web");

  const filteredResult = await capture(cwd, () => runStatus(["api"], { json: true }));
  const filtered = JSON.parse(filteredResult.output);
  assert.deepEqual(filtered.trees.map((entry: { alias: string }) => entry.alias), ["api", "api", "api"]);

  assert.equal((await capture(cwd, () => runTreeRemove("api", "t1", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("api", "broken", {}))).code, 0);
  assert.equal((await capture(cwd, () => runTreeRemove("api", "stray", {}))).code, 0);
  rmSync(join(cwd, ".oms-tree", "web"), { recursive: true, force: true });
  const emptyResult = await capture(cwd, () => runStatus([], { all: true, json: true }));
  assert.deepEqual(JSON.parse(emptyResult.output).trees, []);
});
