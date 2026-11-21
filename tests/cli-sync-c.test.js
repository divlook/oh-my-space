import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { configIdentity, git, gitOut, initBareUpstream, initGitWorkspace, queueEnv, run, sourceFor, sourcesFor, statusJson, tempFixture, testEnv, workspaceWithApi, writeSources } from "./helpers.js";

test("clone accepts aliases with underscore, dash, and at-sign", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const alias = "alfred_af-101@prod";
  writeSources(cwd, sourceFor(alias, bare));
  const result = run(["clone", alias], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lstatSync(join(cwd, "oms", alias, ".git")).isDirectory(), true);
  assert.equal(gitOut(cwd, "check-ignore", `oms/${alias}`), `oms/${alias}`);
});

test("switch onto an existing local branch just switches", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "branch", "work");
  const branchTip = gitOut(wt, "rev-parse", "refs/heads/work");
  git(wt, "commit", "--allow-empty", "-m", "advance main");
  const result = run(["branch", "switch", "api", "work", "--from", "HEAD"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "branch", "--show-current"), "work");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), branchTip);
});

test("switch and checkout error without hanging when args are omitted in a non-TTY", () => {
  const { cwd, bare } = workspaceWithApi();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  const cloned = run(["clone", "web"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  for (const command of ["switch", "checkout"]) {
    const ambiguousAlias = run(["branch", command], { cwd });
    assert.equal(ambiguousAlias.status, 1, ambiguousAlias.stdout + ambiguousAlias.stderr);
    assert.match(ambiguousAlias.stdout + ambiguousAlias.stderr, /Pass an alias explicitly/);
    const noBranch = run(["branch", command, "api"], { cwd });
    assert.equal(noBranch.status, 1, noBranch.stdout + noBranch.stderr);
    assert.match(noBranch.stdout + noBranch.stderr, /not a TTY/);
  }
});

test("push --record is unsupported and fails before pushing", () => {
  const { cwd, bare, wt } = workspaceWithApi();
  const head = gitOut(bare, "rev-parse", "main");
  git(wt, "commit", "--allow-empty", "-m", "local work");
  const result = run(["push", "api", "--record"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown option.*--record/);
  assert.equal(gitOut(bare, "rev-parse", "main"), head);
});

test("pull --ff-only succeeds on the source branch and refuses divergence", () => {
  const { cwd, bare, wt } = workspaceWithApi();
  const current = run(["pull", "api"], { cwd });
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.match(current.stdout + current.stderr, /git pull --ff-only/);

  const scratch = tempFixture("oms-pull-diverge-");
  execFileSync("git", ["clone", bare, scratch], { stdio: "ignore", env: testEnv });
  configIdentity(scratch);
  git(scratch, "commit", "--allow-empty", "-m", "upstream side");
  git(scratch, "push", "origin", "main");
  git(wt, "commit", "--allow-empty", "-m", "local side");
  const local = gitOut(wt, "rev-parse", "HEAD");
  const diverged = run(["pull", "api"], { cwd });
  assert.equal(diverged.status, 2, diverged.stdout + diverged.stderr);
  assert.match(diverged.stdout + diverged.stderr, /fast-forward/i);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), local);
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "status", "--porcelain"), "");
});

test("status --json keeps a configured alias without a local checkout", () => {
  const { cwd } = workspaceWithApi();
  const fresh = tempFixture("oms-fresh-workspace-");
  execFileSync("git", ["clone", cwd, fresh], { stdio: "ignore", env: testEnv });
  assert.equal(existsSync(join(fresh, "oms", "api")), false);
  const result = statusJson(fresh);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(result.repos.length, 1);
  const [repo] = result.repos;
  assert.equal(repo.alias, "api");
  assert.equal(repo.initialized, false);
  assert.equal(repo.head, null);
  assert.equal(repo.branch, null);
  assert.equal(repo.ahead, null);
  assert.equal(repo.error, null);
  assert.equal(existsSync(join(fresh, "oms", "api")), false);
});

test("guarded multiselect drives an omitted selection and fails closed when malformed", () => {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  const picked = run(["clone"], { cwd, env: queueEnv([{ type: "multiselect", values: ["api"] }]) });
  assert.equal(picked.status, 0, picked.stdout + picked.stderr);
  assert.equal(lstatSync(join(cwd, "oms", "api", ".git")).isDirectory(), true);
  assert.equal(existsSync(join(cwd, "oms", "web")), false);

  const malformed = run(["clone"], { cwd, env: queueEnv([{ type: "multiselect", values: ["web", 7] }]) });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stdout + malformed.stderr, /must be an array of strings/);
  const wrongType = run(["clone"], { cwd, env: queueEnv([{ type: "select", value: "web" }]) });
  assert.equal(wrongType.status, 1, wrongType.stdout + wrongType.stderr);
  assert.equal(existsSync(join(cwd, "oms", "web")), false);
});

test("clone and remove preserve occupied paths that are not source checkouts", () => {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", ".DS_Store"), "metadata");
  writeFileSync(join(cwd, "oms", "web"), "regular file");

  for (const [alias, message] of [["api", /not an independent Git checkout/], ["web", /not a canonical directory/]]) {
    for (const args of [["clone", alias], ["remove", alias, "--yes", "--force"]]) {
      const result = run(args, { cwd });
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, message);
    }
  }
  assert.equal(readFileSync(join(cwd, "oms", "api", ".DS_Store"), "utf8"), "metadata");
  assert.equal(readFileSync(join(cwd, "oms", "web"), "utf8"), "regular file");
  assert.deepEqual(readdirSync(join(cwd, "oms")).sort(), ["api", "web"]);
});

test("a dirty source checkout blocks removal of the entire selection", () => {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  const cloned = run(["clone", "--all"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  const dirty = join(cwd, "oms", "web", "dirty.txt");
  writeFileSync(dirty, "preserved");
  const blocked = run(["remove", "--all", "--yes"], { cwd });
  assert.equal(blocked.status, 2, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /web: checkout has staged, unstaged, untracked, or ignored files/);
  assert.match(blocked.stdout + blocked.stderr, /No checkout was removed/);
  assert.equal(readFileSync(dirty, "utf8"), "preserved");
  assert.equal(lstatSync(join(cwd, "oms", "api", ".git")).isDirectory(), true);
  assert.equal(lstatSync(join(cwd, "oms", "web", ".git")).isDirectory(), true);
});

test("remove keeps oms.yaml and a later clone works", () => {
  const { cwd, wt, bare } = workspaceWithApi();
  const manifest = readFileSync(join(cwd, "oms.yaml"));
  const head = gitOut(cwd, "rev-parse", "HEAD");
  const removed = run(["remove", "api", "--yes"], { cwd });
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(existsSync(wt), false);
  assert.deepEqual(readFileSync(join(cwd, "oms.yaml")), manifest);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");

  const cloned = run(["clone", "api"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), gitOut(bare, "rev-parse", "main"));
});

test("clone does not disturb an already-attached working branch", () => {
  const { cwd, wt, bare } = workspaceWithApi();
  git(wt, "switch", "-c", "work");
  git(wt, "commit", "--allow-empty", "-m", "local work");
  writeFileSync(join(wt, "dirty.txt"), "preserved");
  const head = gitOut(wt, "rev-parse", "HEAD");
  writeSources(cwd, sourceFor("api", bare, "does-not-exist"));

  const result = run(["clone", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /existing checkout kept unchanged/);
  assert.equal(gitOut(wt, "branch", "--show-current"), "work");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "status", "--porcelain"), "?? dirty.txt");
});

test("clone leaves an existing detached checkout unchanged after the baseline advances", () => {
  const { cwd, wt } = workspaceWithApi();
  const head = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "commit", "--allow-empty", "-m", "advance baseline");
  git(wt, "push", "origin", "main");
  const baseline = gitOut(wt, "rev-parse", "refs/heads/main");
  git(wt, "switch", "--detach", head);
  const result = run(["clone", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /existing checkout kept unchanged/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "rev-parse", "refs/heads/main"), baseline);
  assert.equal(gitOut(wt, "branch", "--show-current"), "");
});

test("clone uses origin's default branch and refuses an unusable default", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/ghost");
  const failed = run(["clone", "api"], { cwd });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /usable baseline branch/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);

  git(bare, "symbolic-ref", "HEAD", "refs/heads/dev");
  const cloned = run(["clone", "api"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
});
