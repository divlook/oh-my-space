import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, gitOut, initBareUpstream, initGitWorkspace, localBranchExists, sourceFor, syncedSubmodule, tempFixture, testEnv, writeSources } from "../helpers.js";
import { yes, fixture, snapshot, clean, wrapper } from "./branch-clean-fixtures.js";

test("cleanup deletes sorted true ancestors independently of HEAD and upstream and preserves repository boundaries", async () => {
  const { cwd, wt } = fixture("develop");
  const initial = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "-b", "topic");
  git(wt, "commit", "--allow-empty", "-m", "topic");
  const tip = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "develop");
  git(wt, "merge", "--no-ff", "topic", "-m", "merge");
  git(wt, "branch", "a-merged", tip);
  git(wt, "branch", "--set-upstream-to", "origin/develop", "a-merged");
  git(wt, "checkout", "topic");
  git(wt, "commit", "--allow-empty", "-m", "post merge");
  git(wt, "checkout", "-b", "current", initial);
  git(wt, "branch", "z-last", tip);
  git(wt, "config", "branch.z-last.description", "remove only this section");
  git(wt, "config", "branch.current.description", "retain");
  writeFileSync(join(wt, "dirty"), "untouched");
  writeFileSync(join(wt, "staged"), "index contents");
  git(wt, "add", "staged");
  const before = snapshot(cwd, wt);
  const result = await clean(cwd, { responses: yes });
  assert.equal(result.code, 0, result.output);
  for (const branch of ["a-merged", "z-last"]) assert.equal(localBranchExists(wt, branch), false);
  for (const branch of ["topic", "current", "develop"]) assert.equal(localBranchExists(wt, branch), true);
  assert.deepEqual(snapshot(cwd, wt), before);
  assert.equal(readFileSync(join(wt, "dirty"), "utf8"), "untouched");
  assert.equal(gitOut(wt, "config", "branch.current.description"), "retain");
  assert.equal(spawnSync("git", ["-C", wt, "config", "--get-regexp", "^branch\\.(a-merged|z-last)\\."], { env: testEnv }).status, 1);
  assert.ok(result.output.indexOf("a-merged") < result.output.indexOf("z-last"));
  assert.ok(result.output.includes("refs/heads/develop") && result.output.includes(tip), result.output);
  assert.match(result.output, /git.*branch/);
});

test("cleanup protects metadata baselines and all external and managed worktree branches", async () => {
  const { cwd, wt } = fixture();
  for (const branch of ["drift", "external", "managed", "a-first"]) git(wt, "branch", branch);
  git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "drift");
  const external = join(tempFixture("clean-external-"), "tree");
  const managed = join(cwd, ".oms-tree", "api", "task");
  git(wt, "worktree", "add", external, "external");
  git(wt, "worktree", "add", managed, "managed");
  const before = gitOut(wt, "worktree", "list", "--porcelain");
  const result = await clean(cwd, { responses: yes });
  assert.equal(result.code, 0, result.output);
  for (const branch of ["main", "drift", "external", "managed"]) assert.ok(localBranchExists(wt, branch));
  assert.equal(localBranchExists(wt, "a-first"), false);
  assert.equal(gitOut(wt, "worktree", "list", "--porcelain"), before);
  const refusal = await clean(managed);
  assert.equal(refusal.code, 1, refusal.output);
});

test("cleanup uses each repository default and cached explicit remote bases without fetching", async () => {
  for (const base of ["develop", "release"]) {
    const { cwd, wt } = fixture(base);
    git(wt, "branch", "topic");
    const intercepted = wrapper('if [[ "$*" == *fetch* ]]; then echo forbidden-fetch >&2; exit 99; fi');
    const result = await clean(cwd, { base: `refs/remotes/origin/${base}`, responses: yes, env: intercepted.env });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(`refs/remotes/origin/${base}`));
    assert.equal(localBranchExists(wt, "topic"), false);
    assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /\bfetch\b/);
    const empty = await clean(cwd);
    assert.equal(empty.code, 0, empty.output);
  }
});

test("cleanup rejects missing ambiguous symbolic and nonbranch bases without protection bypass", async () => {
  const { cwd, wt, bare } = fixture();
  git(wt, "branch", "topic");
  git(wt, "tag", "tagged");
  git(wt, "branch", "origin/main");
  git(wt, "symbolic-ref", "refs/heads/symbolic", "refs/heads/main");
  for (const base of ["missing", "origin/main", "symbolic", "tagged", "HEAD~0", gitOut(wt, "rev-parse", "HEAD")]) {
    const result = await clean(cwd, { base });
    assert.equal(result.code, 1, `${base}: ${result.output}`);
    assert.ok(localBranchExists(wt, "topic"));
  }
  writeSources(cwd, sourceFor("api", bare).replace("    branch: main\n", ""));
  git(wt, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  const refused = await clean(cwd, { base: "refs/heads/main" });
  assert.equal(refused.code, 1, refused.output);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup unmerged-only no-op preserves dirty files and branches without ordinary exclusions", async () => {
  const { cwd, wt } = fixture();
  git(wt, "checkout", "-b", "unmerged");
  git(wt, "commit", "--allow-empty", "-m", "unmerged topic");
  const tip = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "main");
  writeFileSync(join(wt, "dirty"), "keep");
  const before = snapshot(cwd, wt);
  const result = await clean(cwd, { responses: [] });
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /comparison base|Candidate:|Excluded:|Preparation|transactions|all.*merged|working.*clean/i);
  assert.equal(gitOut(wt, "rev-parse", "unmerged"), tip);
  assert.deepEqual(snapshot(cwd, wt), before);
});

test("cleanup detached safety uses root HEAD gitlink rather than a staged pointer", async () => {
  const { cwd, wt } = fixture();
  const recorded = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "commit", "--allow-empty", "-m", "new pointer");
  const staged = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "add", "oms/api");
  git(wt, "checkout", "--detach", recorded);
  git(wt, "branch", "topic", recorded);
  const accepted = await clean(cwd, { responses: yes });
  assert.equal(accepted.code, 0, accepted.output);
  assert.equal(gitOut(cwd, "rev-parse", ":oms/api"), staged);
  git(wt, "checkout", "--detach", staged);
  git(wt, "branch", "topic");
  const refused = await clean(cwd);
  assert.equal(refused.code, 1, refused.output);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup shallow history deletes proven ancestors and preserves unproven ancestry without fetching", async () => {
  const { cwd, wt } = fixture();
  const old = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "commit", "--allow-empty", "-m", "boundary");
  const boundary = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "branch", "unproven", old);
  git(wt, "branch", "proven", boundary);
  git(wt, "commit", "--allow-empty", "-m", "base");
  writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "shallow"), `${boundary}\n`);
  const intercepted = wrapper('if [[ "$*" == *fetch* ]]; then exit 99; fi');
  const result = await clean(cwd, { responses: yes, env: intercepted.env });
  assert.equal(result.code, 0, result.output);
  assert.equal(localBranchExists(wt, "proven"), false);
  assert.ok(localBranchExists(wt, "unproven"));
  assert.match(result.output, /shallow|limited.history/i);
  const before = snapshot(cwd, wt);
  const empty = await clean(cwd, { responses: [], env: intercepted.env });
  assert.equal(empty.code, 0, empty.output);
  assert.match(empty.output, /shallow|limited.history/i);
  assert.match(empty.output, /deepen|repair/i);
  assert.doesNotMatch(empty.output, /comparison base|Candidate:|Excluded:|transactions|Delete these/i);
  assert.equal(gitOut(wt, "rev-parse", "unproven"), old);
  assert.deepEqual(snapshot(cwd, wt), before);
  assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /\bfetch\b/);
});

test("cleanup preserves squash-equivalent branches and symbolic local refs", async () => {
  const { cwd, wt } = fixture();
  git(wt, "checkout", "-b", "squashed");
  writeFileSync(join(wt, "feature"), "same patch");
  git(wt, "add", "feature");
  git(wt, "commit", "-m", "topic patch");
  git(wt, "checkout", "main");
  git(wt, "merge", "--squash", "squashed");
  git(wt, "commit", "-m", "squash patch");
  git(wt, "symbolic-ref", "refs/heads/alias-ref", "refs/heads/main");
  const result = await clean(cwd);
  assert.equal(result.code, 0, result.output);
  assert.ok(localBranchExists(wt, "squashed"));
  assert.equal(gitOut(wt, "symbolic-ref", "refs/heads/alias-ref"), "refs/heads/main");
});

test("cleanup origin default requires its local branch and explicit bases do not silently substitute", async () => {
  const { cwd, wt, bare } = fixture("release");
  writeSources(cwd, sourceFor("api", bare, "release").replace("    branch: release\n", ""));
  git(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
  git(wt, "branch", "origin/release");
  git(wt, "branch", "topic");
  const valid = await clean(cwd, { responses: [{ type: "confirm", value: false }] });
  assert.equal(valid.code, 1, valid.output);
  assert.ok(valid.output.includes("refs/heads/release"));
  assert.ok(localBranchExists(wt, "release") && localBranchExists(wt, "origin/release") && localBranchExists(wt, "topic"));
  git(wt, "checkout", "--detach");
  git(wt, "branch", "-d", "release");
  const missing = await clean(cwd);
  assert.equal(missing.code, 1, missing.output);
  assert.ok(localBranchExists(wt, "topic"));
  const explicit = await clean(cwd, { base: "refs/remotes/origin/release", responses: yes });
  assert.equal(explicit.code, 0, explicit.output);
  assert.equal(localBranchExists(wt, "topic"), false);
  assert.equal(localBranchExists(wt, "origin/release"), false);
});

test("cleanup refuses unregistered and in-progress targets without topology offers", async () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const root = gitOut(cwd, "rev-parse", "HEAD");
  const unregistered = await clean(cwd);
  assert.equal(unregistered.code, 1, unregistered.output);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), root);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
  const wt = syncedSubmodule(cwd, "api", bare);
  git(wt, "branch", "topic");
  writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${gitOut(wt, "rev-parse", "HEAD")}\n`);
  const operation = await clean(cwd);
  assert.equal(operation.code, 1, operation.output);
  assert.ok(localBranchExists(wt, "topic"));
});

