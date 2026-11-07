import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, tempFixture, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, syncedSubmodule } from "./helpers.js";

function localBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    env: testEnv,
  }).status === 0;
}

function remoteBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
    env: testEnv,
  }).status === 0;
}

test("top-level switch and checkout are removed and fail as unknown commands", () => {
  for (const command of ["switch", "checkout"]) {
    const result = run([command, "api", "feature/x"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /unknown command/);
  }
});

test("branch delete safely removes a merged local branch and reports its short SHA", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/login");
  const sha = gitOut(dir, "rev-parse", "--short", "feature/login");

  const del = run(["branch", "delete", "api", "feature/login"], { cwd });
  const out = del.stdout + del.stderr;
  assert.equal(del.status, 0, out);
  assert.match(out, /deleted local branch feature\/login/);
  assert.match(out, new RegExp(sha));
  assert.equal(localBranchExists(dir, "feature/login"), false);
});

test("branch delete keeps the deletion local: no remote ref removed, root pointer unchanged", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  assert.equal(run(["branch", "checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["branch", "switch", "api", "main"], { cwd }).status, 0);
  const rootBefore = gitOut(cwd, "rev-parse", "HEAD");
  const stagedBefore = gitOut(cwd, "diff", "--cached", "--name-only");

  const del = run(["branch", "delete", "api", "dev"], { cwd });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.equal(localBranchExists(dir, "dev"), false);
  assert.equal(remoteBranchExists(dir, "dev"), true);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootBefore);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), stagedBefore);
});

test("branch delete protects the current branch under -f and plain modes", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  for (const args of [["branch", "delete", "api", "main"], ["branch", "delete", "api", "main", "-f"]]) {
    const del = run(args, { cwd });
    const out = del.stdout + del.stderr;
    assert.equal(del.status, 1, out);
    assert.match(out, /protected/);
  }
});

test("branch delete protects the explicit oms.yaml baseline", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "develop");
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0);
  git(dir, "checkout", "-b", "scratch");
  const del = run(["branch", "delete", "api", "develop"], { cwd });
  assert.equal(del.status, 1, del.stdout + del.stderr);
  assert.match(del.stdout + del.stderr, /protected/);
});

test("branch delete protects the remote default when oms.yaml omits branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const dir = join(cwd, "oms", "api");
  git(dir, "remote", "set-head", "origin", "main");
  git(dir, "checkout", "-b", "scratch");
  const del = run(["branch", "delete", "api", "main"], { cwd });
  assert.equal(del.status, 1, del.stdout + del.stderr);
  assert.match(del.stdout + del.stderr, /remote default|protected/);
});

test("branch delete fails closed when an omitted baseline cannot be resolved", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const dir = join(cwd, "oms", "api");
  spawnSync("git", ["-C", dir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD"], { env: testEnv });
  git(dir, "checkout", "-b", "scratch");
  const del = run(["branch", "delete", "api", "scratch"], { cwd });
  assert.equal(del.status, 1, del.stdout + del.stderr);
  assert.match(del.stdout + del.stderr, /origin\/HEAD|declare "branch"/);
});

test("branch delete reports missing local branch, with local-only hint for a remote match", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const missing = run(["branch", "delete", "api", "nope"], { cwd });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /not found/);
  const remoteOnly = run(["branch", "delete", "api", "dev"], { cwd });
  assert.equal(remoteOnly.status, 1, remoteOnly.stdout + remoteOnly.stderr);
  assert.match(remoteOnly.stdout + remoteOnly.stderr, /local branches only/);
});

test("branch delete -f skips safe deletion and removes an unmerged branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "checkout", "-b", "wip");
  git(dir, "commit", "--allow-empty", "-m", "unmerged");
  const oid = gitOut(dir, "rev-parse", "refs/heads/wip");
  git(dir, "checkout", "main");

  const del = run(["branch", "delete", "api", "wip", "--force"], { cwd });
  const out = del.stdout + del.stderr;
  assert.equal(del.status, 0, out);
  assert.match(out, /force-deleted/);
  assert.match(out, new RegExp(oid));
  assert.match(out, /git -C 'oms\/api' branch 'wip'/);
  assert.equal(localBranchExists(dir, "wip"), false);
});

test("branch delete of an unmerged branch fails closed non-interactively with a shell-safe retry", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "checkout", "-b", "wip");
  git(dir, "commit", "--allow-empty", "-m", "unmerged");
  git(dir, "checkout", "main");

  const del = run(["branch", "delete", "api", "wip"], { cwd });
  const out = del.stdout + del.stderr;
  assert.equal(del.status, 2, out);
  assert.match(out, /oms branch delete 'api' 'wip' --force/);
  assert.equal(localBranchExists(dir, "wip"), true);
});

test("branch delete offers one force retry that force-deletes when accepted", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "checkout", "-b", "wip");
  git(dir, "commit", "--allow-empty", "-m", "unmerged");
  git(dir, "checkout", "main");

  const del = run(["branch", "delete", "api", "wip"], {
    cwd,
    env: queueEnv([{ type: "confirm", value: true }]),
  });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.match(del.stdout + del.stderr, /force-deleted/);
  assert.equal(localBranchExists(dir, "wip"), false);
});

test("branch delete keeps the branch when the force retry is declined (exit 2)", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "checkout", "-b", "wip");
  git(dir, "commit", "--allow-empty", "-m", "unmerged");
  git(dir, "checkout", "main");

  const del = run(["branch", "delete", "api", "wip"], {
    cwd,
    env: queueEnv([{ type: "confirm", value: false }]),
  });
  assert.equal(del.status, 2, del.stdout + del.stderr);
  assert.equal(localBranchExists(dir, "wip"), true);
});

test("branch delete drives alias and branch selection through the guarded queue", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/pick");

  const del = run(["branch", "delete"], {
    cwd,
    env: queueEnv([{ type: "select", value: "api" }, { type: "select", value: "feature/pick" }]),
  });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.equal(localBranchExists(dir, "feature/pick"), false);
});

test("bare branch presents an action selector through the queue and cancels cleanly", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const cancelled = run(["branch"], { cwd, env: queueEnv([{ type: "cancel" }]) });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
});

test("bare branch selector dispatches into the switch flow", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const res = run(["branch"], {
    cwd,
    env: queueEnv([
      { type: "select", value: "switch" },
      { type: "select", value: "main" },
    ]),
  });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 0, out);
  assert.match(out, /Selected "api" \(the only configured source repo\)/);
  assert.doesNotMatch(out, /git fetch origin --prune/);
  assert.match(out, /api: on main/);
});

test("bare branch selector dispatches into the checkout flow", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const res = run(["branch"], {
    cwd,
    env: queueEnv([
      { type: "select", value: "checkout" },
      { type: "select", value: "main" },
    ]),
  });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 0, out);
  assert.match(out, /Selected "api" \(the only configured source repo\)/);
  assert.match(out, /git fetch origin --prune/);
  assert.match(out, /api: on main/);
});

test("branch switch creates a branch through queued select and text prompts", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  const result = run(["branch", "switch", "api"], {
    cwd,
    env: queueEnv([
      { type: "select", value: "\0create-new-branch" },
      { type: "text", value: "feature/queued" },
    ]),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(dir, "branch", "--show-current"), "feature/queued");
});

test("branch switch rejects empty queued names and cancels at either prompt", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  const create = { type: "select", value: "\0create-new-branch" };

  const empty = run(["branch", "switch", "api"], {
    cwd,
    env: queueEnv([create, { type: "text", value: "   " }]),
  });
  assert.equal(empty.status, 1, empty.stdout + empty.stderr);
  assert.match(empty.stdout + empty.stderr, /Branch name is empty/);

  for (const responses of [[{ type: "cancel" }], [create, { type: "cancel" }]]) {
    const cancelled = run(["branch", "switch", "api"], { cwd, env: queueEnv(responses) });
    assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
    assert.match(cancelled.stdout + cancelled.stderr, /Cancelled/);
  }
  assert.equal(gitOut(dir, "branch", "--show-current"), "main");
});

test("bare branch prints help and exits 1 in a non-interactive shell", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const res = run(["branch"], { cwd });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /delete/);
});

test("branch delete exits 0 without a selector when only protected branches remain", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const res = run(["branch", "delete", "api"], { cwd, env: queueEnv([]) });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /no deletable local branches/);
});

test("injected responses are ignored without OMS_TEST_MODE", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const result = run(["branch", "delete"], {
    cwd,
    env: { ...testEnv, OMS_TEST_PROMPT_RESPONSES: JSON.stringify([{ type: "select", value: "api" }]) },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /not a TTY/);
});

test("branch delete rejects an in-progress submodule operation and an unanchored detached HEAD", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "commit", "--allow-empty", "-m", "extra");
  git(dir, "checkout", "--detach", "HEAD");
  const detached = run(["branch", "delete", "api", "main"], { cwd });
  assert.equal(detached.status, 1, detached.stdout + detached.stderr);
  assert.match(detached.stdout + detached.stderr, /detached/);

  git(dir, "checkout", "main");
  const gitdir = gitOut(dir, "rev-parse", "--absolute-git-dir");
  writeFileSync(join(gitdir, "MERGE_HEAD"), `${gitOut(dir, "rev-parse", "HEAD")}\n`);
  const inProgress = run(["branch", "delete", "api", "main"], { cwd });
  assert.equal(inProgress.status, 1, inProgress.stdout + inProgress.stderr);
  assert.match(inProgress.stdout + inProgress.stderr, /in progress/);
});

test("branch delete rejects an unregistered alias with sync guidance", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: main\n  - alias: ghost\n    remotes:\n      origin: file://${bare}\n    branch: main\n`);
  const res = run(["branch", "delete", "ghost", "x"], { cwd });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /oms sync ghost/);
});

test("branch delete auto-initializes a registered-but-uninitialized alias, then revalidates", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/reinit");
  assert.equal(spawnSync("git", ["-C", cwd, "submodule", "deinit", "-f", "oms/api"], { env: testEnv }).status, 0);
  assert.equal(existsSync(join(dir, ".git")), false);

  const del = run(["branch", "delete", "api", "feature/reinit"], { cwd });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.equal(existsSync(join(dir, ".git")), true);
  assert.equal(localBranchExists(dir, "feature/reinit"), false);
});

test("branch delete warns on baseline drift and protects both recorded branches", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0);
  git(dir, "checkout", "-b", "scratch");

  const blocked = run(["branch", "delete", "api", "develop"], { cwd });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /drift|protected/);
});

test("branch delete fails closed on malformed .gitmodules and identifies the source", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/m");
  writeFileSync(join(cwd, ".gitmodules"), "[submodule \"oms/api\"\n  path = oms/api\n");
  const res = run(["branch", "delete", "api", "feature/m"], { cwd });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /working tree \.gitmodules|invalid Git config/);
});

test("branch delete fails closed on a duplicate selected-alias section", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/d");
  const original = readFileSync(join(cwd, ".gitmodules"), "utf8");
  writeFileSync(join(cwd, ".gitmodules"), `${original}\n[submodule "oms/api"]\n\tpath = oms/api\n\turl = file://${bare}\n`);
  const res = run(["branch", "delete", "api", "feature/d"], { cwd });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /duplicate/);
});

test("branch delete --force exits 2 when Git rejects -D for a linked worktree checkout", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/w");
  const wt = tempFixture("oms-linked-");
  git(dir, "worktree", "add", wt, "feature/w");
  const res = run(["branch", "delete", "api", "feature/w", "--force"], { cwd });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.equal(localBranchExists(dir, "feature/w"), true);
  rmSync(wt, { recursive: true, force: true });
});

test("branch deletion fails closed when index baselines cannot be inspected", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/keep");

  const result = run(["branch", "delete", "api", "feature/keep"], {
    cwd,
    env: { ...testEnv, GIT_INDEX_FILE: cwd },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /index \.gitmodules sources could not be listed/);
  assert.equal(localBranchExists(dir, "feature/keep"), true);
});
