import assert from "node:assert/strict";
import test from "node:test";
import { validateSources } from "../../scripts/lib/manifest.js";
import { exitFromResults } from "../../scripts/lib/operation-results.js";
import {
  inferAliasFromCwd,
  isDirtyCounts,
  pendingAddTopology,
  pendingRemovalTopology,
  partialRemovalTopology,
  recordVerdict,
  rootFollowupHint,
  type GitlinkState,
} from "../../scripts/lib/status.js";

const oid = "a".repeat(40);

function state(overrides: Partial<GitlinkState> = {}): GitlinkState {
  return {
    alias: "api",
    headOid: oid,
    indexOid: oid,
    worktreeOid: oid,
    conflict: false,
    initialized: true,
    pathExists: true,
    gitmodulesEntry: true,
    moved: false,
    staged: false,
    split: false,
    pin: "ok",
    ...overrides,
  };
}

test("manifest validation normalizes valid repositories and rejects structural ambiguity", () => {
  assert.deepEqual(
    validateSources({ repos: [{ alias: "api", remotes: { origin: "https://example.com/api.git", backup: "ssh://backup/api.git" }, branch: "main" }] }),
    [{ alias: "api", remotes: { origin: "https://example.com/api.git", backup: "ssh://backup/api.git" }, branch: "main" }],
  );
  const invalid: Array<[unknown, RegExp]> = [
    [null, /root must be a mapping/],
    [{ repos: [] }, /at least one item/],
    [{ repos: [{ alias: "api", url: "https:\/\/example.com" }] }, /url is no longer supported/],
    [{ repos: [{ alias: "api", remotes: { upstream: "https:\/\/example.com" } }] }, /include an "origin"/],
    [{ repos: [{ alias: "api", remotes: { origin: "x" } }, { alias: "api", remotes: { origin: "y" } }] }, /duplicate alias/],
  ];
  for (const [value, message] of invalid) assert.throws(() => validateSources(value), message);
});

test("status topology and record decisions distinguish add, removal, split, no-op, and movement", () => {
  const pendingAdd = state({ headOid: null });
  assert.equal(pendingAddTopology(pendingAdd), true);
  const pendingAddVerdict = recordVerdict(pendingAdd, "api");
  assert.match(pendingAddVerdict.kind === "problem" ? pendingAddVerdict.message : "", /initial topology commit/);
  assert.equal(rootFollowupHint("api", pendingAdd), 'Run "oms sync api --commit" to create the topology commit.');

  const removal = state({ pathExists: false, gitmodulesEntry: false, initialized: false, worktreeOid: null, pin: "missing" });
  assert.equal(pendingRemovalTopology(removal), true);
  assert.equal(partialRemovalTopology(state({ pathExists: false })), true);
  const removalVerdict = recordVerdict(removal, "api");
  assert.match(removalVerdict.kind === "problem" ? removalVerdict.message : "", /pending submodule removal/);

  const splitVerdict = recordVerdict(state({ split: true }), "api");
  assert.match(splitVerdict.kind === "problem" ? splitVerdict.message : "", /differs from the working tree/);
  assert.deepEqual(recordVerdict(state(), "api"), { kind: "benign", message: "Nothing to record for api." });
  const moved = state({ worktreeOid: "b".repeat(40), moved: true, pin: "moved" });
  assert.deepEqual(recordVerdict(moved, "api"), { kind: "recordable" });
  assert.equal(rootFollowupHint("api", moved), 'Run "oms record api" to record the root pointer update.');
  assert.equal(rootFollowupHint("api", { ...moved, conflict: true }), null);
});

test("status path inference, dirty counts, and operation result exits are deterministic", () => {
  const repos = [{ alias: "api", remotes: { origin: "x" } }, { alias: "api-extra", remotes: { origin: "y" } }];
  assert.equal(inferAliasFromCwd("/workspace", repos, "/workspace/oms/api/src"), "api");
  assert.equal(inferAliasFromCwd("/workspace", repos, "/workspace/oms/api-extra"), "api-extra");
  assert.equal(inferAliasFromCwd("/workspace", repos, "/outside/oms/api"), null);
  assert.equal(isDirtyCounts({ staged: 0, unstaged: 0, untracked: 0 }), false);
  assert.equal(isDirtyCounts({ staged: 0, unstaged: 1, untracked: 0 }), true);
  assert.equal(exitFromResults(["added", "pulled"]), 0);
  assert.equal(exitFromResults(["added", "failed"]), 2);
});
