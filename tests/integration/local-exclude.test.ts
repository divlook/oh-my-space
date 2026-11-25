import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cloneSource } from "../../scripts/lib/clone-source.js";
import { openSourceWorkspace } from "../../scripts/lib/source-checkout.js";
import { ensureTreeExcluded } from "../../scripts/lib/tree-exclude.js";
import { runIndependentTreeAdd } from "../../scripts/lib/tree-ops.js";
import { git, gitOut, testEnv, workspaceWithApi } from "../helpers.js";

Object.assign(process.env, testEnv);

test("clone and tree updates honor a competing writer on the shared root exclude", async () => {
  const { cwd, bare } = workspaceWithApi();
  const workspace = openSourceWorkspace(cwd);
  const linked = join(workspace.root, "linked checkout");
  git(workspace.root, "worktree", "add", "--detach", linked);
  const linkedWorkspace = openSourceWorkspace(linked);
  const repo = { alias: "api", remotes: { origin: `file://${bare}` } };
  const exclude = join(workspace.commonDir, "info", "exclude");
  const lock = `${exclude}.lock`;
  const original = "# existing rule follows\n*.log";
  const pending = Buffer.from(`${original}\ninvalid-utf8-\xFF\n*.tmp`, "latin1");
  writeFileSync(exclude, original);
  writeFileSync(lock, pending, { flag: "wx" });
  chmodSync(lock, 0o640);

  const contention = { code: "EEXIST", path: lock };
  assert.throws(() => cloneSource(workspace, repo), contention);
  assert.throws(() => ensureTreeExcluded(linkedWorkspace), contention);
  const previous = process.cwd();
  try {
    process.chdir(workspace.root);
    assert.equal(await runIndependentTreeAdd("api", "contended", {}), 1);
  } finally {
    process.chdir(previous);
  }
  assert.equal(existsSync(join(workspace.root, ".oms-tree", "api", "contended")), false);
  assert.equal(gitOut(join(workspace.root, "oms", "api"), "branch", "--list", "contended"), "");
  assert.equal(readFileSync(exclude, "utf8"), original);
  assert.deepEqual(readFileSync(lock), pending);

  renameSync(lock, exclude);
  assert.equal(cloneSource(workspace, repo), "existing");
  ensureTreeExcluded(linkedWorkspace);
  const expected = Buffer.concat([pending, Buffer.from("\n/oms/api/\n# managed by oms\n.oms-tree/\n")]);
  assert.deepEqual(readFileSync(exclude), expected);
  ensureTreeExcluded(linkedWorkspace);
  assert.deepEqual(readFileSync(exclude), expected);
  const anchored = Buffer.concat([pending, Buffer.from("\n/oms/api/\n/.oms-tree/\n")]);
  writeFileSync(exclude, anchored);
  ensureTreeExcluded(linkedWorkspace);
  assert.deepEqual(readFileSync(exclude), anchored);
  assert.equal(statSync(exclude).mode & 0o777, 0o640);
  assert.equal(existsSync(lock), false);
});
