import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { configIdentity, git, gitOut, initEmptyBare, queueEnv, run, sourceFor, tempFixture, testEnv, workspaceWithApi, workspaceWithMovedApi, writeSources } from "./helpers.js";
import { workspaceWithThree } from "./cli-commit-fixtures.js";

test("commit rejects an in-progress merge inside the source checkout", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "conflict.txt"), "base\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "base");
  git(wt, "checkout", "-b", "other");
  writeFileSync(join(wt, "conflict.txt"), "other\n");
  git(wt, "commit", "-am", "other");
  git(wt, "checkout", "main");
  writeFileSync(join(wt, "conflict.txt"), "main\n");
  git(wt, "commit", "-am", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd: wt, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
  const mergeHead = gitOut(wt, "rev-parse", "MERGE_HEAD");
  const result = run(["commit", "api", "-m", "x"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /merge.*in progress/);
  assert.equal(gitOut(wt, "rev-parse", "MERGE_HEAD"), mergeHead);
  assert.match(gitOut(wt, "status", "--porcelain"), /^UU conflict\.txt$/m);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit without an alias resolves by candidate count, not by the terminal", () => {
  const { cwd } = workspaceWithThree();
  const api = join(cwd, "oms", "api");
  const web = join(cwd, "oms", "web");
  const none = run(["commit", "-m", "x"], { cwd });
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout + none.stderr, /Nothing to commit in eligible source checkouts/);

  writeFileSync(join(api, "work.txt"), "x");
  const one = run(["commit", "-m", "feat: work"], { cwd });
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.equal(gitOut(api, "log", "-1", "--pretty=%s"), "feat: work");

  writeFileSync(join(api, "work.txt"), "y");
  writeFileSync(join(web, "work.txt"), "x");
  const two = run(["commit", "-m", "x"], { cwd });
  assert.equal(two.status, 1, two.stdout + two.stderr);
  assert.match(two.stdout + two.stderr, /Pass an alias explicitly: "oms commit <alias>"/);
  assert.equal(gitOut(api, "log", "-1", "--pretty=%s"), "feat: work");

  const queued = run(["commit", "-m", "feat: picked"], {
    cwd,
    env: queueEnv([{ type: "select", value: "web" }]),
  });
  assert.equal(queued.status, 0, queued.stdout + queued.stderr);
  assert.equal(gitOut(web, "log", "-1", "--pretty=%s"), "feat: picked");
  assert.equal(gitOut(api, "log", "-1", "--pretty=%s"), "feat: work");
  assert.equal(gitOut(api, "status", "--porcelain"), "M work.txt");
});

test("pull --all advances multiple source branches and leaves root staging alone", () => {
  const { cwd, bares } = workspaceWithThree();
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "keep.txt"), "staged root work");
  git(cwd, "add", "keep.txt");
  const rootIndex = gitOut(cwd, "diff", "--cached", "--binary");
  const core = join(cwd, "oms", "core");
  const coreHead = gitOut(core, "rev-parse", "HEAD");
  const expected = {};
  for (const alias of ["api", "web"]) {
    const clone = tempFixture(`oms-up-${alias}-`);
    execFileSync("git", ["clone", bares[alias], clone], { stdio: "ignore", env: testEnv });
    configIdentity(clone);
    git(clone, "commit", "--allow-empty", "-m", "upstream work");
    git(clone, "push", "origin", "main");
    expected[alias] = gitOut(clone, "rev-parse", "HEAD");
  }

  const result = run(["pull", "--all"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Summary: pulled 3/);
  for (const alias of ["api", "web"]) {
    assert.equal(gitOut(join(cwd, "oms", alias), "rev-parse", "HEAD"), expected[alias]);
  }
  assert.equal(gitOut(core, "rev-parse", "HEAD"), coreHead);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "diff", "--cached", "--binary"), rootIndex);
});

test("push --remote targets the chosen remote and keeps origin as upstream", () => {
  const { cwd, bare, wt } = workspaceWithMovedApi();
  const upstream = initEmptyBare();
  writeSources(cwd, sourceFor("api", bare, "main", { upstream }));
  const head = gitOut(wt, "rev-parse", "HEAD");
  assert.equal(gitOut(wt, "remote"), "origin");
  const result = run(["push", "api", "--remote", "upstream"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(upstream, "rev-parse", "main"), head);
  assert.notEqual(gitOut(bare, "rev-parse", "main"), head);
  assert.equal(gitOut(wt, "rev-parse", "--abbrev-ref", "main@{u}"), "origin/main");
});

test("push --all pushes every declared repo and summarizes the result", () => {
  const { cwd, bares } = workspaceWithThree();
  const heads = {};
  for (const alias of Object.keys(bares)) {
    const wt = join(cwd, "oms", alias);
    git(wt, "commit", "--allow-empty", "-m", "feature");
    heads[alias] = gitOut(wt, "rev-parse", "HEAD");
  }
  const result = run(["push", "--all"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Summary: pushed 3/);
  for (const [alias, bare] of Object.entries(bares)) {
    assert.equal(gitOut(bare, "rev-parse", "main"), heads[alias]);
  }
});

test("an unknown remote fails only its repo and others still push", () => {
  const { cwd, bares } = workspaceWithThree();
  const upstream = initEmptyBare();
  const path = join(cwd, "oms", "web");
  const web = sourceFor("web", bares.web, "main", { upstream });
  writeSources(cwd, `${web}${sourceFor("api", bares.api).slice("repos:\n".length)}${sourceFor("core", bares.core).slice("repos:\n".length)}`);
  git(path, "commit", "--allow-empty", "-m", "web feature");
  const head = gitOut(path, "rev-parse", "HEAD");
  const result = run(["push", "api", "web", "--remote", "upstream"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /api: unknown remote\(s\): upstream/);
  assert.equal(gitOut(upstream, "rev-parse", "main"), head);
});
