import assert from "node:assert/strict";
import test from "node:test";
import { sourceBaseline } from "../../scripts/lib/source-branch-context.js";
import { loadRepos } from "../../scripts/lib/manifest.js";
import { git, localBranchExists, testEnv, workspaceWithApi, writeSources } from "../helpers.js";
import { clean } from "./branch-clean-fixtures.js";

Object.assign(process.env, testEnv);

test("baseline inspection uses the explicit manifest branch and only a reliable direct origin default", async () => {
  const { cwd, wt } = workspaceWithApi();
  const loaded = loadRepos({ cwd });
  assert.ok(loaded);
  const repo = loaded.repos[0];
  assert.equal(sourceBaseline(wt, repo, false), "main");

  const omitted = { ...repo, branch: undefined };
  git(wt, "update-ref", "refs/remotes/origin/release/next", "HEAD");
  git(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/next");
  assert.equal(sourceBaseline(wt, omitted), "release/next");
  assert.equal(sourceBaseline(wt, omitted, false), null);

  git(wt, "symbolic-ref", "refs/remotes/origin/indirect", "refs/remotes/origin/main");
  for (const ref of ["refs/heads/main", "refs/remotes/origin/indirect", "refs/remotes/origin/missing"]) {
    git(wt, "symbolic-ref", "refs/remotes/origin/HEAD", ref);
    assert.equal(sourceBaseline(wt, omitted), null, ref);
    assert.equal(sourceBaseline(wt, repo), "main", ref);
  }
  git(wt, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  assert.equal(sourceBaseline(wt, omitted), null);

  const baseline = "release/next\u00a0";
  git(wt, "update-ref", `refs/remotes/origin/${baseline}`, "HEAD");
  git(wt, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${baseline}`);
  git(wt, "branch", baseline);
  git(wt, "branch", "merged-topic");
  writeSources(cwd, JSON.stringify({ repos: [omitted] }));
  const result = await clean(cwd, { base: "main", responses: [{ type: "confirm", value: true }] });
  assert.equal(result.code, 0, result.output);
  assert.equal(localBranchExists(wt, "merged-topic"), false);
  assert.equal(localBranchExists(wt, baseline), true, result.output);
});
