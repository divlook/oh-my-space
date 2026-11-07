import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { reportBaselines, resolveBaselines } from "../../scripts/lib/branch-baseline.js";
import { loadRepos } from "../../scripts/lib/manifest.js";
import { git, testEnv, workspaceWithApi } from "../helpers.js";

Object.assign(process.env, testEnv);

test("baseline inspection preserves config value boundaries and refuses invalid metadata from every source", () => {
  const { cwd } = workspaceWithApi();
  const loaded = loadRepos({ cwd });
  assert.ok(loaded);
  const repo = loaded.repos[0];
  const path = join(cwd, ".gitmodules");
  const prefix = '[submodule "oms/api"]\n path = oms/api\n';
  const valid = prefix + " branch = main\n";

  writeFileSync(path, '[submodule "oms/api"]\n PaTh = oms/api\n BrAnCh = drift\n');
  const drift = resolveBaselines(cwd, repo);
  assert.equal(drift.ok, true);
  if (drift.ok) assert.deepEqual(drift.protectedReasons.map((entry) => entry.branch), ["main", "drift"]);
  const report = reportBaselines(cwd, repo, ["main", "drift"], true);
  assert.equal(report.state, "incomplete");
  assert.equal(report.baselines.find((entry) => entry.branch === "drift")?.reason, "working tree .gitmodules baseline");

  for (const branch of [' branch = "   "\n', " branch\n"]) {
    writeFileSync(path, prefix + branch);
    const empty = resolveBaselines(cwd, repo);
    assert.equal(empty.ok, true);
    if (empty.ok) assert.deepEqual(empty.protectedReasons, [{ branch: "main", reason: "oms.yaml baseline" }]);
  }

  for (const [content, reason] of [
    [prefix + ' branch = "main\\nnext"\n', /multiple "branch"/],
    [prefix + " branch = main\n branch = main\n", /multiple "branch"/],
    [prefix + " path = other\n branch = main\n", /multiple "path"/],
    [valid + "[invalid\n", /invalid Git config syntax/],
  ] as const) {
    writeFileSync(path, content);
    const refused = resolveBaselines(cwd, repo);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.match(refused.reason, /working tree \.gitmodules/);
      assert.match(refused.reason, reason);
    }
  }

  writeFileSync(path, valid + "[invalid\n");
  git(cwd, "add", ".gitmodules");
  writeFileSync(path, valid);
  const staged = resolveBaselines(cwd, repo);
  assert.equal(staged.ok, false);
  if (!staged.ok) assert.match(staged.reason, /index \.gitmodules has invalid Git config syntax/);

  git(cwd, "commit", "-m", "record invalid metadata for inspection");
  git(cwd, "add", ".gitmodules");
  const committed = resolveBaselines(cwd, repo);
  assert.equal(committed.ok, false);
  if (!committed.ok) assert.match(committed.reason, /HEAD \.gitmodules has invalid Git config syntax/);
});
