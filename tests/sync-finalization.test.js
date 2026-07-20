import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, clearProvenStaleWorkspaceLock, sourceFor, localBranchExists, syncedSubmodule } from "./helpers.js";
// ─── sync metadata reconciliation (0.12.0) ───

test("sync reconciles drifted .gitmodules url and branch from the manifest, redacting URLs", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  // Drift both managed fields away from the manifest.
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://drifted.example/x.git");

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /reconciled \.gitmodules/);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): reconcile api submodule metadata");
  // Managed fields are restored from the manifest (origin = file://<bare>) in the committed .gitmodules.
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.match(committed, /branch = main/);
  assert.match(committed, new RegExp(`url = file://${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // No URL value is printed to the user.
  assert.doesNotMatch(output, /drifted\.example/);
  assert.doesNotMatch(output, new RegExp(bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("sync removes the .gitmodules branch key when the manifest omits branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main"); // starts with branch = main
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);

  // Drop the branch key from the manifest; origin/HEAD resolves the baseline.
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.doesNotMatch(committed, /branch =/);
});

test("sync fails when the explicit manifest branch is absent on origin and does not change .gitmodules", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: nope\n`);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /not found on origin/);
  // .gitmodules baseline is unchanged.
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);
});

test("sync fails when an omitted baseline cannot resolve origin/HEAD", () => {
  // Point the remote default at a nonexistent branch so origin/HEAD is dangling (unresolvable), then
  // omit the manifest baseline: sync must fail closed instead of guessing a baseline.
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "main");
  writeFileSync(join(cwd, "oms.yaml"), `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  spawnSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/ghost"], { env: testEnv });
  spawnSync("git", ["-C", dir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD"], { env: testEnv });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /origin\/HEAD|declare "branch"/);
});

test("sync leaves reconciled metadata unstaged without a commit", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["sync", "api"], { cwd }); // no --commit, non-interactive
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // No new commit; the reconciled .gitmodules is a working-tree change, left unstaged.
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.match(gitOut(cwd, "config", "--file", ".gitmodules", "--get", "submodule.oms/api.branch"), /main/);
  assert.doesNotMatch(gitOut(cwd, "diff", "--cached", "--name-only"), /\.gitmodules/);
});

test("metadata reconciliation preserves the current working branch", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare, "main");
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0); // attach to develop
  assert.equal(gitOut(dir, "branch", "--show-current"), "develop");
  const recordedGitlink = gitOut(cwd, "rev-parse", "HEAD:oms/api");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://drift.example/x.git");

  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  // The submodule is still on develop; reconciliation never switches the working branch.
  assert.equal(gitOut(dir, "branch", "--show-current"), "develop");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD:oms/api"), recordedGitlink);
});

test("sync finalizes new topology and existing metadata reconciliation in one commit", () => {
  const a = initBareUpstream({ branches: ["main", "develop"] });
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  // api is already synced; web is new. api's .gitmodules branch is drifted.
  syncedSubmodule(cwd, "api", a, "main");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  writeFileSync(
    cwd + "/oms.yaml",
    `repos:\n  - alias: api\n    remotes:\n      origin: file://${a}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: main\n`,
  );

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // One commit carries the new web topology and the reconciled api metadata together.
  const committed = gitOut(cwd, "show", "HEAD:.gitmodules");
  assert.match(committed, /submodule "oms\/web"/);
  assert.match(committed, /branch = main/); // api reconciled back to main
  assert.doesNotMatch(committed, /branch = develop/);
  const names = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(names, /oms\/web/);
});

test("sync restore reconciles .gitmodules metadata through the unified finalization", () => {
  const bare = initBareUpstream({ branches: ["main", "develop"] });
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare, "main");
  assert.equal(run(["unsync", "api"], { cwd }).status, 0); // pending removal, not committed
  // Change the manifest baseline to develop, then restore.
  writeFileSync(cwd + "/oms.yaml", `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: develop\n`);

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), true); // restored
  assert.match(gitOut(cwd, "show", "HEAD:.gitmodules"), /branch = develop/);
});

test("an interrupted commit after HEAD advances is recovered by the next command's preflight", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  // Crash immediately after HEAD advances but before the real index is installed.
  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  // HEAD advanced to the commit; a committed recovery marker remains.
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // Doctor-confirmed stale workspace-lock removal allows the root transaction recovery to resume.
  clearProvenStaleWorkspaceLock(cwd);
  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  // The gitlink and .gitmodules are committed and clean.
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("a malformed finalization marker blocks root-mutating commands", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  writeFileSync(join(cwd, ".git", "oms", "finalize.json"), "{ not valid");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /malformed/i);
});

test("an orphaned finalization artifact without a marker blocks and is preserved", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  writeFileSync(join(cwd, ".git", "oms", "index.recovery"), "stale");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /orphan/i);
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), true); // preserved
});

// ─── 7.8: durable finalization / recovery matrix ───

test("an interruption before HEAD advances preserves the real index and is cleaned on the next run", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const headBefore = gitOut(cwd, "rev-parse", "HEAD");
  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-marker-prepared" },
  });
  assert.notEqual(crashed.status, 0);
  // HEAD did not advance; only a prepared marker remains.
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  clearProvenStaleWorkspaceLock(cwd);
  const recovered = run(["sync", "api", "--commit"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
});

test("a committed recovery whose index no longer matches is preserved and blocks", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // Change the real index so its hash no longer matches the recorded original.
  writeFileSync(join(cwd, "unrelated.txt"), "x");
  git(cwd, "add", "unrelated.txt");

  clearProvenStaleWorkspaceLock(cwd);
  const blocked = run(["sync", "api"], { cwd });
  const output = blocked.stdout + blocked.stderr;
  assert.notEqual(blocked.status, 0, output);
  assert.match(output, /no longer matches|inspect/i);
  // The marker is preserved, not silently discarded.
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);
});

test("record completes a pending finalization recovery through the shared preflight", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-head-advance" },
  });
  assert.notEqual(crashed.status, 0);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  // record runs the same recovery preflight before touching the root pointer.
  clearProvenStaleWorkspaceLock(cwd);
  const recovered = run(["record", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("every sync commit discloses and includes the complete working-tree oms.yaml", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /complete working-tree oms\.yaml/i);
  // oms.yaml is part of the commit (it was untracked before).
  assert.match(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD"), /oms\.yaml/);
});

test("plain partial multi-alias sync does not prompt and leaves successful changes unstaged", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `${sourceFor("api", a).trimEnd()}\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: nope\n`,
  );

  // No --commit, non-interactive: web fails, api succeeds, nothing is committed or staged.
  const result = run(["sync", "api", "web"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
});

test("a temporary-commit failure before HEAD advances preserves the real index byte-for-byte", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0); // topology left unstaged

  // Stage an unrelated path, capture the exact index bytes, then force a commit failure via a broken
  // commit identity so commit-tree fails before HEAD advances.
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt");
  const indexPath = join(cwd, ".git", "index");
  const before = readFileSync(indexPath);
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: "commit-tree" },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(readFileSync(indexPath), before);
});

test("an index-install failure after HEAD advances preserves recovery state for the next command", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const failed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: "install-recovery-index" },
  });
  const output = failed.stdout + failed.stderr;
  assert.equal(failed.status, 2, output);
  assert.match(output, /commit .* was created.*recovery will retry/is);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  clearProvenStaleWorkspaceLock(cwd);
  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("an active finalization lock blocks a concurrent sync before shared state is changed", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  const owner = `${process.pid}:test`;
  const blob = spawnSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
    input: owner,
    encoding: "utf8",
    env: testEnv,
  });
  assert.equal(blob.status, 0, blob.stderr);
  git(cwd, "update-ref", "refs/oms/finalize-lock", blob.stdout.trim());

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /finalization lock is held/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.equal(gitOut(cwd, "rev-parse", "refs/oms/finalize-lock"), blob.stdout.trim());

  git(cwd, "update-ref", "-d", "refs/oms/finalize-lock", blob.stdout.trim());
});

test("a crash after index installation is recognized as completed recovery", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-index-install" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);

  clearProvenStaleWorkspaceLock(cwd);
  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.doesNotMatch(gitOut(cwd, "status", "--porcelain"), /\.gitmodules|oms\/api/);
});

test("a crash after the real index rename cleans the retained recovery artifact", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const crashed = run(["sync", "api", "--commit"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "after-index-rename" },
  });
  assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), true);
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), true);

  clearProvenStaleWorkspaceLock(cwd);
  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(join(cwd, ".git", "oms", "finalize.json")), false);
  assert.equal(existsSync(join(cwd, ".git", "oms", "index.recovery")), false);
});

test("a dangling OMS state symlink blocks sync before topology mutation", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  symlinkSync(join(cwd, "missing-state-target"), join(cwd, ".git", "oms"));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /unsafe OMS state directory/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("a structurally incomplete finalization marker is rejected as malformed", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  mkdirSync(join(cwd, ".git", "oms"), { recursive: true });
  writeFileSync(
    join(cwd, ".git", "oms", "finalize.json"),
    JSON.stringify({ state: "prepared", originalHead: gitOut(cwd, "rev-parse", "HEAD") }),
  );

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /marker.*malformed/i);
});

test("unsync refuses an unmerged root .gitmodules before removing the submodule", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  const content = readFileSync(join(cwd, ".gitmodules"), "utf8");
  const blob = spawnSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], {
    input: content,
    encoding: "utf8",
    env: testEnv,
  });
  assert.equal(blob.status, 0, blob.stderr);
  const oid = blob.stdout.trim();
  const conflict = spawnSync("git", ["-C", cwd, "update-index", "--index-info"], {
    input: [1, 2, 3].map((stage) => `100644 ${oid} ${stage}\t.gitmodules`).join("\n") + "\n",
    encoding: "utf8",
    env: testEnv,
  });
  assert.equal(conflict.status, 0, conflict.stderr);

  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /\.gitmodules is unmerged/);
  assert.equal(existsSync(dir), true);
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
