import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { git, gitOut, initBareUpstream, initGitWorkspace, run, sourceFor, sourcesFor, statusJson, tempFixture, testEnv, workspaceWithApi, workspaceWithMovedApi, writeSources } from "./helpers.js";

test("clone provisions the declared baseline without tracking it in the workspace root", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  const wt = join(cwd, "oms", "probe");
  writeSources(cwd, sourceFor("probe", bare, "dev"));
  writeFileSync(join(cwd, "keep.txt"), "staged");
  git(cwd, "add", "oms.yaml", "keep.txt");
  const index = gitOut(cwd, "ls-files", "--stage");
  const head = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["clone", "probe"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lstatSync(join(wt, ".git")).isDirectory(), true);
  assert.equal(gitOut(wt, "branch", "--show-current"), "dev");
  assert.equal(gitOut(wt, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/dev");
  assert.equal(gitOut(cwd, "check-ignore", "oms/probe"), "oms/probe");
  writeFileSync(join(cwd, "oms", "AGENTS.md"), "root instructions");
  assert.match(gitOut(cwd, "status", "--porcelain", "--untracked-files=all"), /^\?\? oms\/AGENTS\.md$/m);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), index);
});

test("switch creates a brand-new local branch without any remote precondition", () => {
  const { cwd, wt, bare } = workspaceWithApi();
  renameSync(bare, join(tempFixture("oms-offline-origin-"), "origin.git"));
  const result = run(["branch", "switch", "api", "feature/new"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /created new local branch/);
  assert.equal(gitOut(wt, "branch", "--show-current"), "feature/new");
  const upstreamCheck = spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: wt, env: testEnv });
  assert.notEqual(upstreamCheck.status, 0);
});

test("checkout refuses a branch absent on origin and points at switch", () => {
  const { cwd, wt } = workspaceWithApi();
  const result = run(["branch", "checkout", "api", "feature/new"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not found on origin/);
  assert.match(output, /oms branch switch api feature\/new/);
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
});

test("push --commit is unsupported and fails before pushing", () => {
  const { bare, cwd } = workspaceWithMovedApi();
  const remoteHead = gitOut(bare, "rev-parse", "main");
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const result = run(["push", "api", "--commit"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown option.*--commit/);
  assert.equal(gitOut(bare, "rev-parse", "main"), remoteHead);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
});

test("status --json represents a detached source HEAD explicitly", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "checkout", "--detach");
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.branch, null);
  assert.equal(repo.detached, true);
  assert.equal(repo.head, gitOut(wt, "rev-parse", "--short", "HEAD"));
});

test("status --json narrows repos to the selected aliases", () => {
  const { cwd, wt, bare } = workspaceWithMovedApi();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  writeFileSync(join(wt, "staged.txt"), "staged");
  git(wt, "add", "staged.txt");
  writeFileSync(join(wt, "untracked.txt"), "untracked");

  const data = statusJson(cwd, ["api"]);
  assert.equal(data.schemaVersion, 2);
  assert.deepEqual(data.repos.map(({ alias }) => alias), ["api"]);
  const [api] = data.repos;
  assert.equal(api.trackingBranch, "origin/main");
  assert.equal(api.ahead, 1);
  assert.equal(api.behind, 0);
  assert.deepEqual(api.changes, { staged: 1, unstaged: 0, untracked: 1 });
  assert.equal(Object.hasOwn(data.root, "submodulePointers"), false);
  assert.equal(Object.hasOwn(api, "pin"), false);
  assert.equal(data.root.branch, "main");
  assert.equal(data.currentAlias, null);
});

test("status --json keeps valid JSON and exits non-zero when a repo read fails", () => {
  const { cwd, wt } = workspaceWithApi();
  renameSync(join(wt, ".git", "HEAD"), join(wt, ".git", "HEAD.broken"));
  const data = statusJson(cwd, [], 2);
  const [api] = data.repos;
  assert.equal(api.initialized, false);
  assert.match(api.error, /^api:/);
  assert.equal(api.head, null);
  assert.deepEqual(api.changes, { staged: 0, unstaged: 0, untracked: 0 });
  assert.deepEqual(data.errors, [api.error]);
});

test("omitted selection fails with an actionable message in a non-interactive shell", () => {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  for (const command of ["clone", "fetch", "pull", "push", "remove"]) {
    const result = run([command], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${command}: ${output}`);
    if (command !== "remove") assert.match(output, /not a TTY/, command);
    assert.match(output, new RegExp(`oms ${command} --all`), command);
  }
  assert.equal(existsSync(join(cwd, "oms")), false);
});

test("multi-alias clone keeps the successful alias when another fails", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `${sourceFor("api", bare)}  - alias: web\n    remotes:\n      origin: file://${bare}\n    branch: nope\n`);
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const result = run(["clone", "api", "web"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /api: cloned/);
  assert.match(result.stdout + result.stderr, /web: git clone failed/);
  assert.equal(lstatSync(join(cwd, "oms", "api", ".git")).isDirectory(), true);
  assert.equal(existsSync(join(cwd, "oms", "web")), false);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), "");
});

test("pull rejects a dirty source checkout before running", () => {
  const { cwd, wt } = workspaceWithApi();
  const head = gitOut(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "dirty.txt"), "x");
  const result = run(["pull", "api"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /uncommitted changes/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "status", "--porcelain"), "?? dirty.txt");
});

test("push warns about a dirty source checkout but still pushes the current HEAD", () => {
  const { cwd, wt, bare } = workspaceWithMovedApi();
  writeFileSync(join(wt, "dirty.txt"), "y");
  const result = run(["push", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /only the current HEAD will be pushed/);
  assert.equal(gitOut(bare, "rev-parse", "main"), gitOut(wt, "rev-parse", "HEAD"));
  assert.equal(gitOut(wt, "status", "--porcelain"), "?? dirty.txt");
});
