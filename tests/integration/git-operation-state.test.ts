import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { gitOperationInProgress, inspectSourceOperations, submoduleOperationInProgress } from "../../scripts/lib/git-operation-state.js";
import { git, gitOut, initGitWorkspace, tempFixture, testEnv } from "../helpers.js";

Object.assign(process.env, testEnv);

const operations = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
  ["sequencer", "cherry-pick or revert"],
] as const;

function markerPath(cwd: string, marker: string) {
  return resolve(cwd, gitOut(cwd, "rev-parse", "--git-path", marker));
}

test("operation checks detect every operation marker, preserve priority, and observe marker removal", () => {
  const cwd = initGitWorkspace();
  assert.deepEqual(inspectSourceOperations(cwd), { kind: "idle" });
  for (const [marker, label] of operations) {
    const path = markerPath(cwd, marker);
    writeFileSync(path, "operation in progress\n");
    assert.equal(submoduleOperationInProgress(cwd), label, marker);
    assert.deepEqual(inspectSourceOperations(cwd), { kind: "active", label }, marker);
    assert.equal(gitOperationInProgress(cwd), marker === "sequencer" ? null : label, marker);
    rmSync(path);
    assert.deepEqual(inspectSourceOperations(cwd), { kind: "idle" }, marker);
  }
  const merge = markerPath(cwd, "MERGE_HEAD");
  const rebase = markerPath(cwd, "rebase-merge");
  writeFileSync(merge, "merge\n");
  mkdirSync(rebase);
  assert.deepEqual(inspectSourceOperations(cwd), { kind: "active", label: "merge" });
  rmSync(merge);
  assert.deepEqual(inspectSourceOperations(cwd), { kind: "active", label: "rebase" });
});

test("operation checks isolate linked worktrees with newline-containing Git directory paths", () => {
  const original = initGitWorkspace();
  const cwd = join(tempFixture("operation-root-"), "root\nwith-newline");
  renameSync(original, cwd);
  const linked = join(tempFixture("operation-linked-"), "checkout");
  git(cwd, "worktree", "add", "-b", "linked", linked);
  const rootMerge = markerPath(cwd, "MERGE_HEAD");
  writeFileSync(rootMerge, "root merge\n");
  assert.deepEqual(inspectSourceOperations(cwd), { kind: "active", label: "merge" });
  assert.deepEqual(inspectSourceOperations(linked), { kind: "idle" });
  rmSync(rootMerge);
  const sequencer = markerPath(linked, "sequencer");
  assert.ok(sequencer.includes("\n"));
  mkdirSync(sequencer);
  assert.equal(submoduleOperationInProgress(linked), "cherry-pick or revert");
  assert.deepEqual(inspectSourceOperations(linked), { kind: "active", label: "cherry-pick or revert" });
  assert.deepEqual(inspectSourceOperations(cwd), { kind: "idle" });
  rmSync(sequencer, { recursive: true });
  assert.deepEqual(inspectSourceOperations(linked), { kind: "idle" });
});
