import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, tempFixture, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, sourceFor, workspaceWithApi } from "./helpers.js";

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
  const { cwd, wt: dir } = workspaceWithApi();
  git(dir, "branch", "feature/login");
  const sha = gitOut(dir, "rev-parse", "--short", "feature/login");

  const del = run(["branch", "delete", "api", "feature/login"], { cwd });
  const out = del.stdout + del.stderr;
  assert.equal(del.status, 0, out);
  assert.match(out, /deleted local branch feature\/login/);
  assert.match(out, new RegExp(sha));
  assert.equal(localBranchExists(dir, "feature/login"), false);
});

test("branch delete keeps the deletion local: remote refs and root Git state are unchanged", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  git(cwd, "clone", `file://${bare}`, "oms/api");
  const dir = join(cwd, "oms", "api");
  assert.equal(run(["branch", "checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["branch", "switch", "api", "main"], { cwd }).status, 0);
  const rootBefore = gitOut(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "staged"), "root staging\n");
  git(cwd, "add", "staged");
  const stagedBefore = gitOut(cwd, "ls-files", "--stage");
  const remoteBefore = gitOut(bare, "show-ref");
  const sourceBefore = gitOut(dir, "status", "--porcelain=v1", "--branch");

  const del = run(["branch", "delete", "api", "dev"], { cwd });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.equal(localBranchExists(dir, "dev"), false);
  assert.equal(remoteBranchExists(dir, "dev"), true);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootBefore);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), stagedBefore);
  assert.equal(gitOut(bare, "show-ref"), remoteBefore);
  assert.equal(gitOut(dir, "status", "--porcelain=v1", "--branch"), sourceBefore);
});

test("branch delete protects the current branch under -f and plain modes", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  git(dir, "checkout", "-b", "current");
  for (const args of [["branch", "delete", "api", "current"], ["branch", "delete", "api", "current", "-f"]]) {
    const del = run(args, { cwd });
    const out = del.stdout + del.stderr;
    assert.equal(del.status, 1, out);
    assert.match(out, /protected/);
  }
});

test("branch delete protects the explicit oms.yaml baseline", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare, "develop"));
  git(cwd, "clone", "--branch", "develop", `file://${bare}`, "oms/api");
  const dir = join(cwd, "oms", "api");
  git(dir, "checkout", "-b", "scratch");
  for (const force of [[], ["--force"]]) {
    const del = run(["branch", "delete", "api", "develop", ...force], { cwd });
    assert.equal(del.status, 1, del.stdout + del.stderr);
    assert.match(del.stdout + del.stderr, /protected/);
    assert.ok(localBranchExists(dir, "develop"));
  }
});

test("branch delete protects the remote default when oms.yaml omits branch", () => {
  const { cwd, bare, wt: dir } = workspaceWithApi();
  writeSources(cwd, sourceFor("api", bare).replace("    branch: main\n", ""));
  git(dir, "remote", "set-head", "origin", "main");
  git(dir, "checkout", "-b", "scratch");
  const del = run(["branch", "delete", "api", "main"], { cwd });
  assert.equal(del.status, 1, del.stdout + del.stderr);
  assert.match(del.stdout + del.stderr, /remote default|protected/);
});

test("branch delete fails closed when an omitted baseline cannot be resolved", () => {
  const { cwd, bare, wt: dir } = workspaceWithApi();
  writeSources(cwd, sourceFor("api", bare).replace("    branch: main\n", ""));
  git(dir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  git(dir, "checkout", "-b", "scratch");
  git(dir, "branch", "keep");
  for (const force of [[], ["--force"]]) {
    const del = run(["branch", "delete", "api", "keep", ...force], { cwd });
    assert.equal(del.status, 1, del.stdout + del.stderr);
    assert.match(del.stdout + del.stderr, /origin\/HEAD|declare "branch"/);
    assert.ok(localBranchExists(dir, "keep"));
  }
});

test("branch delete reports missing local branch, with local-only hint for a remote match", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  git(cwd, "clone", `file://${bare}`, "oms/api");
  const missing = run(["branch", "delete", "api", "nope"], { cwd });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /not found/);
  const remoteOnly = run(["branch", "delete", "api", "dev"], { cwd });
  assert.equal(remoteOnly.status, 1, remoteOnly.stdout + remoteOnly.stderr);
  assert.match(remoteOnly.stdout + remoteOnly.stderr, /local branches only/);
});

test("branch delete -f skips safe deletion and removes an unmerged branch", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  git(dir, "checkout", "-b", "wip");
  git(dir, "commit", "--allow-empty", "-m", "unmerged");
  const oid = gitOut(dir, "rev-parse", "refs/heads/wip");
  git(dir, "checkout", "main");

  const del = run(["branch", "delete", "api", "wip", "--force"], { cwd });
  const out = del.stdout + del.stderr;
  assert.equal(del.status, 0, out);
  assert.match(out, /force-deleted/);
  assert.match(out, new RegExp(oid));
  assert.match(out, /git -C 'oms\/api' branch -- 'wip'/);
  assert.equal(localBranchExists(dir, "wip"), false);
});

test("branch delete of an unmerged branch fails closed non-interactively with a shell-safe retry", () => {
  const { cwd, wt: dir } = workspaceWithApi();
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
  const { cwd, wt: dir } = workspaceWithApi();
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
  const { cwd, wt: dir } = workspaceWithApi();
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
  const { bare, cwd, wt: dir } = workspaceWithApi();
  const baseline = "feature/pick\u00a0";
  git(dir, "update-ref", `refs/remotes/origin/${baseline}`, "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${baseline}`);
  git(dir, "branch", baseline);
  writeSources(cwd, sourceFor("api", bare).replace(/^    branch:.*\n/m, ""));

  const protectedOnly = run(["branch", "delete"], { cwd, env: queueEnv([{ type: "select", value: "api" }]) });
  assert.equal(protectedOnly.status, 0, protectedOnly.stdout + protectedOnly.stderr);
  assert.match(protectedOnly.stdout + protectedOnly.stderr, /no deletable local branches/);

  git(dir, "branch", "feature/pick");

  const del = run(["branch", "delete"], {
    cwd,
    env: queueEnv([{ type: "select", value: "api" }, { type: "select", value: "feature/pick" }]),
  });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.equal(localBranchExists(dir, "feature/pick"), false);
  assert.equal(localBranchExists(dir, baseline), true);
});

test("bare branch presents an action selector through the queue and cancels cleanly", () => {
  const { cwd } = workspaceWithApi();
  const cancelled = run(["branch"], { cwd, env: queueEnv([{ type: "cancel" }]) });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
});

test("bare branch selector dispatches into the switch flow", () => {
  const { cwd } = workspaceWithApi();
  const res = run(["branch"], {
    cwd,
    env: queueEnv([
      { type: "select", value: "switch" },
      { type: "select", value: "main" },
    ]),
  });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 0, out);
  assert.doesNotMatch(out, /git fetch origin --prune/);
  assert.match(out, /api: on main/);
});

test("bare branch selector dispatches into the checkout flow", () => {
  const { cwd } = workspaceWithApi();
  const res = run(["branch"], {
    cwd,
    env: queueEnv([
      { type: "select", value: "checkout" },
      { type: "select", value: "main" },
    ]),
  });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 0, out);
  assert.match(out, /git fetch origin --prune/);
  assert.match(out, /api: on main/);
});

test("branch switch creates a branch through queued select and text prompts", () => {
  const { cwd, wt: dir } = workspaceWithApi();
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
  const { cwd, wt: dir } = workspaceWithApi();
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
  const { cwd } = workspaceWithApi();
  const res = run(["branch"], { cwd });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /delete/);
});

test("branch delete exits 0 without a selector when only protected branches remain", () => {
  const { cwd } = workspaceWithApi();
  const res = run(["branch", "delete", "api"], { cwd, env: queueEnv([]) });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /no deletable local branches/);
});

test("injected responses are ignored without OMS_TEST_MODE", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["branch", "delete"], {
    cwd,
    env: { ...testEnv, OMS_TEST_PROMPT_RESPONSES: JSON.stringify([{ type: "select", value: "api" }]) },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /oms branch delete <alias>/);
});

test("branch delete rejects an in-progress source operation and detached HEAD", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  git(dir, "branch", "topic");
  git(dir, "checkout", "--detach", "HEAD");
  const detached = run(["branch", "delete", "api", "topic", "--force"], { cwd });
  assert.equal(detached.status, 1, detached.stdout + detached.stderr);
  assert.match(detached.stdout + detached.stderr, /detached/);
  assert.ok(localBranchExists(dir, "topic"));

  git(dir, "checkout", "main");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = tempFixture("operation-probe-");
  writeFileSync(join(shim, "git"), `#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = --git-path ] && [ "$#" -gt 3 ]; then exit 86; fi
exec ${JSON.stringify(realGit)} "$@"
`, { mode: 0o755 });
  const env = { ...testEnv, PATH: `${shim}${delimiter}${testEnv.PATH}` };
  const marker = join(dir, ".git", "MERGE_HEAD");
  writeFileSync(marker, `${gitOut(dir, "rev-parse", "HEAD")}\n`);
  const inProgress = run(["branch", "delete", "api", "topic", "--force"], { cwd, env });
  assert.equal(inProgress.status, 1, inProgress.stdout + inProgress.stderr);
  assert.match(inProgress.stdout + inProgress.stderr, /in progress/);
  assert.ok(localBranchExists(dir, "topic"));

  rmSync(marker);
  const deleted = run(["branch", "delete", "api", "topic"], { cwd, env });
  assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
  assert.equal(localBranchExists(dir, "topic"), false);
});

test("branch delete rejects a missing declared clone with clone guidance, without provisioning", () => {
  const bare = initBareUpstream({ branches: ["main", "topic"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "ls-files", "--stage");
  const remoteRefs = gitOut(bare, "show-ref");
  const res = run(["branch", "delete", "api", "topic"], { cwd, env: queueEnv([]) });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /oms clone api/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), rootIndex);
  assert.equal(gitOut(bare, "show-ref"), remoteRefs);
});

test("branch delete refuses a clone whose origin differs from the declaration", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  const foreign = initBareUpstream();
  git(dir, "remote", "set-url", "origin", `file://${foreign}`);
  git(dir, "branch", "topic");
  const res = run(["branch", "delete", "api", "topic", "--force"], { cwd });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /origin does not match.*declaration/);
  assert.ok(localBranchExists(dir, "topic"));
});

test("branch delete revalidates the tip, baseline and operation at the process boundary", () => {
  for (const change of ["tip", "baseline", "operation"]) {
    const { cwd, bare, wt: dir } = workspaceWithApi();
    git(dir, "branch", "topic");
    if (change === "baseline") {
      writeSources(cwd, sourceFor("api", bare).replace("    branch: main\n", ""));
      git(dir, "update-ref", "refs/remotes/origin/topic", "topic");
    }
    git(dir, "commit", "--allow-empty", "-m", "advance current branch");
    const newTip = gitOut(dir, "rev-parse", "HEAD");
    const oldTip = gitOut(dir, "rev-parse", "topic");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const stubDir = tempFixture("branch-delete-git-");
    const stub = join(stubDir, "git");
    const marker = join(stubDir, "changed");
    const deletes = join(stubDir, "deletes");
    const mergeHead = join(dir, ".git", "MERGE_HEAD");
    writeFileSync(stub, `#!/usr/bin/env bash
REAL=${JSON.stringify(realGit)}
if [[ "$1" == rev-parse && "$2" == --short && "$3" == ${oldTip} && ! -f ${JSON.stringify(marker)} ]]; then
  touch ${JSON.stringify(marker)}
  ${change === "tip" ? `"$REAL" update-ref refs/heads/topic ${newTip}` : change === "baseline" ? `"$REAL" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/topic` : `printf '%s\\n' ${newTip} > ${JSON.stringify(mergeHead)}`}
fi
if [[ "$1" == branch && ( "$2" == -d || "$2" == -D ) ]]; then printf '%s\\n' "$*" >> ${JSON.stringify(deletes)}; fi
exec "$REAL" "$@"
`);
    chmodSync(stub, 0o755);
    const args = ["branch", "delete", "api", "topic"];
    if (change === "tip") args.push("--force");
    const result = run(args, {
      cwd,
      env: { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` },
    });
    const output = result.stdout + result.stderr;
    assert.ok(existsSync(marker), output);
    assert.equal(result.status, 2, output);
    assert.match(output, /changed concurrently/);
    assert.equal(existsSync(deletes), false);
    assert.equal(gitOut(dir, "rev-parse", "topic"), change === "tip" ? newTip : oldTip);
  }
});

test("branch delete --force exits 2 when Git rejects -D for a linked worktree checkout", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  git(dir, "branch", "feature/w");
  const wt = tempFixture("oms-linked-");
  git(dir, "worktree", "add", wt, "feature/w");
  const res = run(["branch", "delete", "api", "feature/w", "--force"], { cwd });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.equal(localBranchExists(dir, "feature/w"), true);
});

test("branch deletion fails closed when workspace tracking cannot be inspected", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  git(dir, "branch", "feature/keep");

  const result = run(["branch", "delete", "api", "feature/keep"], {
    cwd,
    env: { ...testEnv, GIT_INDEX_FILE: cwd },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /could not inspect.*index/i);
  assert.equal(localBranchExists(dir, "feature/keep"), true);
});
