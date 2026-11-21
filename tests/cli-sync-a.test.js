import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { configIdentity, git, gitOut, initBareUpstream, initGitWorkspace, run, sourceFor, tempFixture, testEnv, workspaceWithApi, writeSources } from "./helpers.js";

test("clone rejects a missing branch and leaves no debris", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("probe", bare, "nonexistent"));
  const head = gitOut(cwd, "rev-parse", "HEAD");
  const before = gitOut(cwd, "ls-files", "--stage");
  const result = run(["clone", "probe"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /probe: git clone failed/);
  assert.deepEqual(readdirSync(join(cwd, "oms")), []);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), before);
});

test("checkout switches onto an existing remote branch with tracking", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const cloned = run(["clone", "api"], { cwd });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);

  const result = run(["branch", "checkout", "api", "dev"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const wt = join(cwd, "oms", "api");
  assert.equal(gitOut(wt, "branch", "--show-current"), "dev");
  assert.equal(gitOut(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), "origin/dev");
});

test("push lazily creates the exact remote branch without staging anything in the root", () => {
  const { bare, cwd, wt } = workspaceWithApi();
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "ls-files", "--stage");
  const similarBranch = "feature/x\u2028y";
  const switched = run(["branch", "switch", "api", similarBranch], { cwd });
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  git(wt, "commit", "--allow-empty", "-m", "work");
  const localSha = gitOut(wt, "rev-parse", "HEAD");
  const exactBranch = `${similarBranch}\u00a0`;
  git(wt, "branch", exactBranch);
  git(wt, "switch", "--detach", localSha);
  git(wt, "branch", "-f", similarBranch, "HEAD^");
  git(wt, "tag", exactBranch, "HEAD^");
  git(wt, "tag", `refs/heads/${exactBranch}`, "HEAD^");

  const result = run(["push", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pushed/);
  assert.equal(gitOut(bare, "rev-parse", `refs/heads/${exactBranch}`), localSha);
  assert.equal(gitOut(bare, "for-each-ref", "--format=%(refname)", `refs/heads/${similarBranch}`), "");
  assert.equal(gitOut(bare, "for-each-ref", "--format=%(refname)", "refs/tags/"), "");

  git(wt, "commit", "--allow-empty", "-m", "more work on the attached branch");
  const attached = run(["push", "api"], { cwd });
  assert.equal(attached.status, 0, attached.stdout + attached.stderr);
  assert.equal(gitOut(bare, "rev-parse", `refs/heads/${exactBranch}`), gitOut(wt, "rev-parse", "HEAD"));
  assert.equal(gitOut(bare, "for-each-ref", "--format=%(refname)", `refs/heads/${similarBranch}`), "");

  git(wt, "update-ref", "refs/heads/--all", localSha);
  git(wt, "symbolic-ref", "HEAD", "refs/heads/--all");
  const literal = run(["push", "api"], { cwd });
  assert.equal(literal.status, 0, literal.stdout + literal.stderr);
  assert.equal(gitOut(bare, "rev-parse", "refs/heads/--all"), localSha);
  assert.equal(gitOut(bare, "for-each-ref", "--format=%(refname)", `refs/heads/${similarBranch}`), "");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), rootIndex);
});

test("status reports branch and dirtiness", () => {
  const { cwd, wt } = workspaceWithApi();
  const clean = run(["status"], { cwd });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /ALIAS\s+BRANCH\s+DIRTY/);
  assert.match(clean.stdout, /^api\s+main\s*$/m);

  writeFileSync(join(wt, "dirty.txt"), "x");
  const dirty = run(["status", "api"], { cwd });
  assert.equal(dirty.status, 0, dirty.stdout + dirty.stderr);
  assert.match(dirty.stdout, /^api\s+main\s+yes\b/m);
});

test("status --json fails before emitting JSON for an unknown alias", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "missing-alias", "--json"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown alias/);
});

test("clone and remove refuse an unreadable alias path", {
  skip: (process.platform === "win32" || process.getuid?.() === 0) && "requires POSIX directory permissions",
}, () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", initBareUpstream()));
  const path = join(cwd, "oms", "api");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "keep.txt"), "preserved");
  chmodSync(path, 0o000);
  try {
    for (const args of [["clone", "api"], ["remove", "api", "--yes", "--force"]]) {
      const result = run(args, { cwd });
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /EACCES|permission denied/i);
    }
  } finally {
    chmodSync(path, 0o755);
  }
  assert.deepEqual(readdirSync(path), ["keep.txt"]);
});

test("pull advances the source branch without staging and never pulls a matching tag instead", () => {
  const { cwd, bare, wt } = workspaceWithApi();
  const head = gitOut(cwd, "rev-parse", "HEAD");
  const scratch = tempFixture("oms-scratch-");
  execFileSync("git", ["clone", bare, scratch], { stdio: "ignore", env: testEnv });
  configIdentity(scratch);
  writeFileSync(join(scratch, "up.txt"), "upstream");
  git(scratch, "add", "-A");
  git(scratch, "commit", "-m", "upstream");
  git(scratch, "push", "origin", "main");
  git(bare, "update-ref", "refs/tags/main", gitOut(scratch, "rev-parse", "HEAD^"));
  git(wt, "tag", "main", "HEAD");

  const result = run(["pull", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pulled/);
  const pulled = gitOut(scratch, "rev-parse", "HEAD");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), pulled);
  assert.equal(gitOut(wt, "show", "HEAD:up.txt"), "upstream");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), head);

  git(scratch, "commit", "--allow-empty", "-m", "tag-only descendant");
  git(scratch, "push", "origin", "HEAD:refs/tags/refs/heads/main");
  git(bare, "update-ref", "-d", "refs/heads/main");
  const tagOnly = run(["pull", "api"], { cwd });
  assert.equal(tagOnly.status, 2, tagOnly.stdout + tagOnly.stderr);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), pulled);
});
