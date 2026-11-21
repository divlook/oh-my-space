import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { git, gitOut, initBareUpstream, initEmptyBare, initGitWorkspace, queueEnv, run, sourceFor, writeSources } from "./helpers.js";
import { workspaceWithThree } from "./cli-commit-fixtures.js";

test("commit gives an explicit alias precedence over the current source context", () => {
  const { cwd } = workspaceWithThree();
  const api = join(cwd, "oms", "api");
  const web = join(cwd, "oms", "web");
  const apiHead = gitOut(api, "rev-parse", "HEAD");
  writeFileSync(join(api, "api.txt"), "api");
  writeFileSync(join(web, "web.txt"), "web");

  const result = run(["commit", "web", "-m", "feat: explicit web"], { cwd: api });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(web, "log", "-1", "--pretty=%s"), "feat: explicit web");
  assert.equal(gitOut(api, "rev-parse", "HEAD"), apiHead);
  assert.equal(gitOut(api, "status", "--porcelain"), "?? api.txt");
});

test("clone configures every declared remote on the source checkout", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  const wt = join(cwd, "oms", "api");
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  const result = run(["clone", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(gitOut(wt, "remote").split("\n"), ["origin", "upstream"]);
  assert.equal(gitOut(wt, "remote", "get-url", "origin"), `file://${origin}`);
  assert.equal(gitOut(wt, "remote", "get-url", "upstream"), `file://${upstream}`);
});

test("fetch --remote accepts multiple remotes", () => {
  const origin = initBareUpstream();
  const upstream = initBareUpstream({ branches: ["main", "integration"] });
  const cwd = initGitWorkspace();
  const wt = join(cwd, "oms", "api");
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  const cloned = run(["clone", "api"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  git(wt, "update-ref", "-d", "refs/remotes/origin/main");

  const result = run(["fetch", "api", "--remote", "origin", "--remote", "upstream"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /fetched \(origin, upstream\)/);
  assert.equal(gitOut(wt, "rev-parse", "refs/remotes/origin/main"), gitOut(origin, "rev-parse", "refs/heads/main"));
  assert.equal(gitOut(wt, "rev-parse", "refs/remotes/upstream/integration"), gitOut(upstream, "rev-parse", "refs/heads/integration"));
});

test("push with an omitted alias list resolves through the multi-select prompt", () => {
  const { cwd, bares } = workspaceWithThree();
  const before = Object.fromEntries(Object.entries(bares).map(([alias, bare]) => [alias, gitOut(bare, "rev-parse", "main")]));
  for (const alias of Object.keys(bares)) {
    git(join(cwd, "oms", alias), "commit", "--allow-empty", "-m", "feature");
  }
  const result = run(["push"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api"] }]) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(bares.api, "rev-parse", "main"), gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD"));
  assert.notEqual(gitOut(bares.api, "rev-parse", "main"), before.api);
  assert.equal(gitOut(bares.web, "rev-parse", "main"), before.web);
  assert.equal(gitOut(bares.core, "rev-parse", "main"), before.core);
});

test("oms.yaml without an origin remote is rejected", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, "repos:\n  - alias: api\n    remotes:\n      upstream: git@example.com:org/repo.git\n");
  const result = run(["clone", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /must include an "origin" entry/);
});
