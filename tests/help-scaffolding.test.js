import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { testEnv, run, tempWorkspace, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, sourceFor, gitTopLevelStubEnv, sharedPreflightCommands, queueEnv } from "./helpers.js";
// --- help / scaffolding / validation (no git operations) ---

test("help is exposed as oms with the workspace commands", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: oms/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\bsync\b/);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /\bcommit\b/);
  assert.match(result.stdout, /\brecord\b/);
  assert.match(result.stdout, /\bswitch\b/);
  assert.match(result.stdout, /\bcheckout\b/);
  assert.match(result.stdout, /\bunsync\b/);
  assert.match(result.stdout, /\bagent\b/);
  assert.match(result.stdout, /\bskills\b/);
  assert.match(result.stdout, /\bupdate\b/);
  assert.match(result.stdout, /\bworktree\b/);
  assert.doesNotMatch(result.stdout, /\bmigrate\b/);
});

test("submodule command help explains workspace root requirements", () => {
  for (const args of [
    ["branch", "--help"],
    ["branch", "switch", "--help"],
    ["branch", "checkout", "--help"],
    ["branch", "list", "--help"],
    ["branch", "delete", "--help"],
    ["fetch", "--help"],
    ["pull", "--help"],
    ["push", "--help"],
    ["unsync", "--help"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /root Git top-level/, args.join(" "));
  }
});

test("init scaffolds oms.yaml with the schema comment and does not gitignore oms/", () => {
  const cwd = tempWorkspace();
  const result = run(["init"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  const manifest = readFileSync(join(cwd, "oms.yaml"), "utf8");
  assert.match(
    manifest,
    /# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/divlook\/oh-my-space\/main\/oms\.schema\.json/,
  );
  assert.match(manifest, /alias: example/);

  // Submodules are tracked, so init must NOT add oms/ to .gitignore.
  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
});

test("mode switch manifest editing rejects symlinks and preserves unrelated YAML bytes", () => {
  const cwd = tempWorkspace();
  const source = "# header\r\nmode: 'submodule' # keep\r\nrepos:\r\n  - alias: api\r\n    remotes:\r\n      origin: git@example.com:org/repo.git\r\n";
  writeFileSync(join(cwd, "oms.yaml"), source);
  const switched = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  assert.equal(
    readFileSync(join(cwd, "oms.yaml"), "utf8"),
    source.replace("'submodule'", "'worktree'"),
  );

  const target = join(cwd, "manifest-target.yaml");
  writeFileSync(target, source);
  rmSync(join(cwd, "oms.yaml"));
  symlinkSync(target, join(cwd, "oms.yaml"));
  const refused = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /regular workspace-local file.*symbolic link/);
  assert.equal(readFileSync(target, "utf8"), source);
});

test("mode switch requires an explicit non-interactive scope and transitions clean topology both ways", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);

  const missingScope = run(["mode", "switch", "worktree"], { cwd });
  assert.equal(missingScope.status, 1, missingScope.stdout + missingScope.stderr);
  assert.match(missingScope.stdout + missingScope.stderr, /--sync.*--no-sync/);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, undefined);
  const ownershipBytes = readFileSync(join(cwd, ".oms", "workspace.json"));

  const toWorktree = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(toWorktree.status, 0, toWorktree.stdout + toWorktree.stderr);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const toSubmodule = run(["mode", "switch", "submodule", "--no-sync"], { cwd });
  assert.equal(toSubmodule.status, 0, toSubmodule.stdout + toSubmodule.stderr);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "submodule");
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);
  assert.equal(existsSync(join(cwd, ".oms", "workspace.json")), true);
  assert.deepEqual(readFileSync(join(cwd, ".oms", "workspace.json")), ownershipBytes);
  const exclude = readFileSync(resolve(cwd, gitOut(cwd, "rev-parse", "--git-path", "info/exclude")), "utf8");
  assert.match(exclude, /\.oms\/workspace\.json/);
  assert.match(exclude, /\.oms-mode-switch\.json/);
  assert.doesNotMatch(exclude, /\.oms\/repos\//);
  assert.doesNotMatch(exclude, /\/oms\/api\//);
});

test("interactive mode switch selects transition-only and transition-plus-sync in both directions", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const transitionOnly = run(["mode", "switch", "worktree"], {
    cwd,
    env: queueEnv([{ type: "select", value: "no-sync" }]),
  });
  assert.equal(transitionOnly.status, 0, transitionOnly.stdout + transitionOnly.stderr);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);

  const transitionAndSync = run(["mode", "switch", "submodule"], {
    cwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  assert.equal(transitionAndSync.status, 0, transitionAndSync.stdout + transitionAndSync.stderr);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "submodule");
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  assert.match(gitOut(cwd, "ls-files", "--stage", "oms/api"), /^160000 [0-9a-f]{40} 0\toms\/api$/);
});

test("mode switch recovers only a stale lock matching its journal identities", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  mkdirSync(join(cwd, ".oms"));
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  writeFileSync(join(cwd, ".oms", "workspace.json"), `${JSON.stringify({ version: 1, workspaceId })}\n`);
  const transitionId = "transition-test";
  const operationId = "operation-test";
  const manifestBytes = readFileSync(join(cwd, "oms.yaml"));
  const expectedManifest = Buffer.from(`mode: worktree\n${manifestBytes.toString("utf8")}`);
  const journal = {
    version: 1,
    transitionId,
    lockOperationId: operationId,
    workspaceId,
    sourceMode: "submodule",
    targetMode: "worktree",
    sync: false,
    commit: false,
    force: false,
    originalManifestHash: createHash("sha256").update(manifestBytes).digest("hex"),
    expectedManifestHash: createHash("sha256").update(expectedManifest).digest("hex"),
    modeRange: [0, 0],
    modeToken: null,
    rootIndex: null,
    exclude: null,
    rootHeadBefore: null,
    phase: "prepared",
    completedAliases: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const lock = {
    version: 1,
    operation: "mode switch",
    operationId,
    ownerToken: "old-owner",
    targetHash: createHash("sha256").update(realpathSync(cwd)).digest("hex"),
    workspaceId,
    transitionId,
    pid: process.pid,
    processStart: "not-the-current-process-start",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(cwd, ".oms-mode-switch.json"), `${JSON.stringify(journal)}\n`);
  const lockPath = join(cwd, ".oms-mutation.lock");
  const journalPath = join(cwd, ".oms-mode-switch.json");
  const writeLock = (value) => writeFileSync(lockPath, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);

  const liveLock = {
    ...lock,
    processStart: execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim(),
  };
  writeLock(liveLock);
  const live = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(live.status, 1, live.stdout + live.stderr);
  assert.match(live.stdout + live.stderr, /still owns/);
  assert.equal(existsSync(journalPath), true);

  writeLock({ ...lock, operationId: "identity-mismatch" });
  const mismatched = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(mismatched.status, 1, mismatched.stdout + mismatched.stderr);
  assert.match(mismatched.stdout + mismatched.stderr, /does not match the mode-switch journal/);
  assert.equal(existsSync(journalPath), true);

  writeLock("{ malformed\n");
  const malformed = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stdout + malformed.stderr, /mutation\.lock is malformed/);
  assert.equal(existsSync(journalPath), true);

  writeLock(lock);

  const result = run(["mode", "switch", "worktree", "--no-sync"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
  assert.equal(existsSync(join(cwd, ".oms-mutation.lock")), false);
});

test("mode switch preserves unrelated index entries and resumes a failed scoped commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  writeFileSync(join(cwd, "unrelated.txt"), "staged before transition\n");
  git(cwd, "add", "unrelated.txt");
  const unrelatedEntry = gitOut(cwd, "ls-files", "--stage", "unrelated.txt");

  const rejected = run(["mode", "switch", "worktree", "--no-sync", "--commit"], { cwd });
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout + rejected.stderr, /unrelated staged changes/);
  assert.equal(gitOut(cwd, "ls-files", "--stage", "unrelated.txt"), unrelatedEntry);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, undefined);

  git(cwd, "reset", "HEAD", "unrelated.txt");
  const hook = join(cwd, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const failed = run(["mode", "switch", "worktree", "--no-sync", "--commit"], { cwd });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /root commit failed.*remain staged/i);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), true);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
  assert.ok(gitOut(cwd, "diff", "--cached", "--name-only").split("\n").includes("oms.yaml"));

  const standalone = run(["sync", "api"], { cwd });
  assert.equal(standalone.status, 1, standalone.stdout + standalone.stderr);
  assert.match(standalone.stdout + standalone.stderr, /Standalone sync is blocked by transition/);

  rmSync(hook);
  const resumed = run(["mode", "switch", "worktree", "--no-sync", "--commit"], { cwd });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(gitOut(cwd, "show", "-s", "--format=%s", "HEAD"), "chore(oms): switch workspace mode to worktree");
  const committed = gitOut(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
  assert.ok(committed.includes("oms.yaml"));
  assert.ok(committed.every((path) => ["oms.yaml", ".gitmodules", "oms/api"].includes(path)));
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
  assert.equal(existsSync(join(cwd, ".oms", "workspace.json")), true);
});

test("mode switch signing failure retains staged recovery state", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const signingEnv = {
    ...testEnv,
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_5: "user.signingkey",
    GIT_CONFIG_VALUE_5: "oms-test-missing-signing-key",
  };

  const failed = run(["mode", "switch", "worktree", "--no-sync", "--commit"], { cwd, env: signingEnv });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /root commit failed.*remain staged/i);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), true);
  assert.ok(gitOut(cwd, "diff", "--cached", "--name-only").split("\n").includes("oms.yaml"));

  const resumed = run(["mode", "switch", "worktree", "--no-sync", "--commit"], { cwd });
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
});

test("mode switch preserves complete local refs and raw object closure in staged worktree storage", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const source = join(cwd, "oms", "api");
  git(source, "switch", "-c", "local-only");
  writeFileSync(join(source, "local.txt"), "local closure\n");
  git(source, "add", "local.txt");
  git(source, "commit", "-m", "local-only commit");
  const localOid = gitOut(source, "rev-parse", "HEAD");
  git(source, "branch", "-f", "main", localOid);
  git(source, "tag", "-a", "local-tag", "-m", "local tag");
  const tagOid = gitOut(source, "rev-parse", "refs/tags/local-tag");
  git(source, "update-ref", "refs/archive/local", localOid);
  git(source, "notes", "add", "-m", "local note", localOid);
  const notesOid = gitOut(source, "rev-parse", "refs/notes/commits");
  writeFileSync(join(source, "stash.txt"), "local stash\n");
  git(source, "add", "stash.txt");
  git(source, "stash", "push", "-m", "local stash");
  const stashOid = gitOut(source, "rev-parse", "refs/stash");
  git(source, "commit", "--allow-empty", "-m", "replacement commit");
  const replacementOid = gitOut(source, "rev-parse", "HEAD");
  git(source, "reset", "--hard", localOid);
  git(source, "replace", localOid, replacementOid);

  const switched = run(["mode", "switch", "worktree", "--sync", "--preserve-local"], { cwd });
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  assert.match(switched.stdout + switched.stderr, /mode switch never pushes/i);
  const common = join(cwd, ".oms", "repos", "api.git");
  assert.equal(gitOut(common, "rev-parse", "refs/heads/local-only"), localOid);
  assert.equal(gitOut(common, "rev-parse", "refs/heads/main"), localOid);
  assert.equal(gitOut(common, "rev-parse", "refs/tags/local-tag"), tagOid);
  assert.equal(gitOut(common, "rev-parse", "refs/archive/local"), localOid);
  assert.equal(gitOut(common, "rev-parse", "refs/notes/commits"), notesOid);
  assert.equal(gitOut(common, "rev-parse", "refs/stash"), stashOid);
  assert.equal(gitOut(common, "rev-parse", `refs/replace/${localOid}`), replacementOid);
  assert.equal(gitOut(common, "cat-file", "-t", replacementOid), "commit");
  assert.equal(gitOut(common, "cat-file", "-p", `${localOid}:local.txt`), "local closure");
  const baselineWorktree = join(cwd, "oms", "api", "main");
  assert.equal(gitOut(baselineWorktree, "rev-parse", "HEAD"), localOid);
  assert.equal(gitOut(baselineWorktree, "for-each-ref", "--format=%(upstream:short)", "refs/heads/main"), "origin/main");
  assert.notEqual(spawnSync("git", ["-C", bare, "rev-parse", "--verify", "refs/heads/local-only"], { env: testEnv }).status, 0);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
});

test("interactive mode switch can cancel local preservation before topology mutation", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const source = join(cwd, "oms", "api");
  git(source, "commit", "--allow-empty", "-m", "unpublished");
  const sourceHead = gitOut(source, "rev-parse", "HEAD");

  const nonInteractive = run(["mode", "switch", "worktree", "--sync"], { cwd });
  assert.equal(nonInteractive.status, 1, nonInteractive.stdout + nonInteractive.stderr);
  assert.match(nonInteractive.stdout + nonInteractive.stderr, /--sync --preserve-local.*--force.*publish suitable refs manually/is);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);

  const cancelled = run(["mode", "switch", "worktree", "--sync"], {
    cwd,
    env: queueEnv([{ type: "select", value: "cancel" }]),
  });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.match(cancelled.stdout + cancelled.stderr, /publish suitable state manually.*mode switch never pushes/i);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, undefined);
  assert.equal(gitOut(source, "rev-parse", "HEAD"), sourceHead);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
});

test("mode switch never removes a submodule common repository with an external linked worktree", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const source = join(cwd, "oms", "api");
  const external = tempWorkspace();
  rmSync(external, { recursive: true, force: true });
  git(source, "branch", "external", "main");
  git(source, "worktree", "add", external, "external");

  const refused = run(["mode", "switch", "worktree", "--no-sync", "--force"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /external linked worktree.*blocks mode switch.*--force cannot bypass/s);
  assert.equal(existsSync(external), true);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
});

test("mode switch installs an explicitly selected unpublished worktree OID as the submodule gitlink", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  writeFileSync(join(cwd, "unrelated.txt"), "preserve index flags\n");
  git(cwd, "add", "unrelated.txt");
  git(cwd, "commit", "-m", "track unrelated root file");
  git(cwd, "update-index", "--skip-worktree", "unrelated.txt");
  writeFileSync(join(cwd, "staged-root.txt"), "preserve staged mode\n");
  git(cwd, "add", "staged-root.txt");
  git(cwd, "update-index", "--chmod=+x", "staged-root.txt");
  const unrelatedFlag = gitOut(cwd, "ls-files", "-v", "unrelated.txt");
  const stagedRootEntry = gitOut(cwd, "ls-files", "--stage", "staged-root.txt");
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const dev = join(cwd, "oms", "api", "dev");
  writeFileSync(join(dev, "selected.txt"), "selected unpublished closure\n");
  git(dev, "add", "selected.txt");
  git(dev, "commit", "-m", "selected unpublished commit");
  const selectedOid = gitOut(dev, "rev-parse", "HEAD");

  const ambiguous = run(["mode", "switch", "submodule", "--sync"], { cwd });
  assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stdout + ambiguous.stderr, /multiple viable pointer sources.*--source/s);
  assert.equal(existsSync(dev), true);

  const switched = run(["mode", "switch", "submodule", "--sync", "--source", "api/dev"], { cwd });
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  const submodule = join(cwd, "oms", "api");
  assert.equal(gitOut(submodule, "rev-parse", "HEAD"), selectedOid);
  assert.equal(gitOut(cwd, "ls-files", "--stage", "oms/api").split(/\s+/)[1], selectedOid);
  assert.equal(gitOut(cwd, "ls-files", "-v", "unrelated.txt"), unrelatedFlag);
  assert.equal(gitOut(cwd, "ls-files", "--stage", "staged-root.txt"), stagedRootEntry);
  assert.equal(readFileSync(join(submodule, "selected.txt"), "utf8"), "selected unpublished closure\n");
  assert.notEqual(spawnSync("git", ["-C", bare, "cat-file", "-e", selectedOid], { env: testEnv }).status, 0);
  assert.equal(existsSync(join(cwd, ".oms-mode-switch.json")), false);
});

test("mode switch resumes manifest-rename and commit-success interruptions without duplicate commits", () => {
  const bare = initBareUpstream();
  const manifestInterrupted = initGitWorkspace();
  writeSources(manifestInterrupted, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd: manifestInterrupted }).status, 0);
  const renamed = run(["mode", "switch", "worktree", "--no-sync"], {
    cwd: manifestInterrupted,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "mode-switch-after-manifest-rename" },
  });
  assert.equal(renamed.status, 137, renamed.stdout + renamed.stderr);
  assert.equal(parseYaml(readFileSync(join(manifestInterrupted, "oms.yaml"), "utf8")).mode, "worktree");
  const renameResume = run(["mode", "switch", "worktree", "--no-sync"], { cwd: manifestInterrupted });
  assert.equal(renameResume.status, 0, renameResume.stdout + renameResume.stderr);

  const commitInterrupted = initGitWorkspace();
  writeSources(commitInterrupted, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd: commitInterrupted }).status, 0);
  const committed = run(["mode", "switch", "worktree", "--no-sync", "--commit"], {
    cwd: commitInterrupted,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_CRASH_AT: "mode-switch-after-root-finalize" },
  });
  assert.equal(committed.status, 137, committed.stdout + committed.stderr);
  const transitionHead = gitOut(commitInterrupted, "rev-parse", "HEAD");
  const commitResume = run(["mode", "switch", "worktree", "--no-sync", "--commit"], { cwd: commitInterrupted });
  assert.equal(commitResume.status, 0, commitResume.stdout + commitResume.stderr);
  assert.equal(gitOut(commitInterrupted, "rev-parse", "HEAD"), transitionHead);
  const transitionSubjects = gitOut(commitInterrupted, "log", "--format=%s").split("\n")
    .filter((subject) => subject === "chore(oms): switch workspace mode to worktree");
  assert.equal(transitionSubjects.length, 1);
});

test("standalone submodule sync refuses stale worktree exclude cleanup without changing it", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const excludePath = resolve(cwd, gitOut(cwd, "rev-parse", "--git-path", "info/exclude"));
  const exclude = readFileSync(excludePath, "utf8");
  const stale = exclude.replace(/(# oms workspace [0-9a-f-]+ end)/, "/.oms/repos/\n$1");
  writeFileSync(excludePath, stale);

  const refused = run(["sync", "api"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /worktree-mode local-exclude rule.*remains/);
  assert.equal(readFileSync(excludePath, "utf8"), stale);
});

test("mode switch resolves a fresh baseline when no viable managed worktree exists", () => {
  const bare = initBareUpstream();
  const expected = gitOut(bare, "rev-parse", "refs/heads/main");
  const cwd = initGitWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "remove", "api/main"], { cwd }).status, 0);

  const switched = run(["mode", "switch", "submodule", "--sync"], { cwd });
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD"), expected);
  assert.equal(gitOut(cwd, "ls-files", "--stage", "oms/api").split(/\s+/)[1], expected);
});

test("selected target object-copy and connectivity failures preserve worktree source topology", () => {
  for (const failure of ["mode-switch-object-copy", "mode-switch-connectivity"]) {
    const bare = initBareUpstream();
    const cwd = initGitWorkspace();
    writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
    assert.equal(run(["sync", "api"], { cwd }).status, 0);
    const source = join(cwd, "oms", "api", "main");
    writeFileSync(join(source, "selected-local.txt"), `${failure}\n`);
    git(source, "add", "selected-local.txt");
    git(source, "commit", "-m", failure);
    const selectedOid = gitOut(source, "rev-parse", "HEAD");

    const refused = run(["mode", "switch", "submodule", "--sync", "--force"], {
      cwd,
      env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: failure },
    });
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stdout + refused.stderr, new RegExp(failure.replaceAll("-", "[- ]"), "i"));
    assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
    assert.equal(gitOut(source, "rev-parse", "HEAD"), selectedOid);
    assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);
  }
});

test("init removes a stale managed oms/ entry left in .gitignore", () => {
  const cwd = tempWorkspace();
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n# managed by oms\noms/\n");
  const result = run(["init"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
  assert.doesNotMatch(gi, /^oms\/$/m);
  assert.doesNotMatch(gi, /# managed by oms/);
  assert.match(gi, /node_modules\//);
});

test("init refuses to overwrite an existing oms.yaml without --force", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["init"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /already exists/);
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: sample/);
});

test("init --force overwrites", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["init", "--force"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: example/);
});

test("init --mode worktree writes an explicit mode and needs no root Git repository", () => {
  const cwd = tempWorkspace();
  const result = run(["init", "--mode", "worktree"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
  assert.doesNotMatch(output, /run "git init" here/);
  assert.match(output, /local worktrees/);
});

test("init --mode worktree permits a workspace nested below an enclosing Git root", () => {
  const root = initGitWorkspace();
  const cwd = join(root, "nested");
  mkdirSync(cwd);
  const result = run(["init", "--mode", "worktree"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(parseYaml(readFileSync(join(cwd, "oms.yaml"), "utf8")).mode, "worktree");
});

test("init rejects an invalid mode before writing", () => {
  const cwd = tempWorkspace();
  const result = run(["init", "--mode", "mixed"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /expected "submodule" or "worktree"/);
  assert.equal(existsSync(join(cwd, "oms.yaml")), false);
});

test("manifest accepts both workspace modes and defaults omission to submodule", () => {
  for (const modeLine of ["", "mode: submodule\n", "mode: worktree\n"]) {
    const cwd = tempWorkspace();
    writeSources(cwd, `${modeLine}repos:\n  - alias: api\n    remotes:\n      origin: git@example.com:org/api.git\n`);
    const result = run(["sync", "--list"], { cwd });
    assert.equal(result.status, 0, `${modeLine || "omitted"}\n${result.stdout}${result.stderr}`);
  }
});

test("manifest rejects repository-level mode", () => {
  const cwd = tempWorkspace();
  writeSources(cwd, "mode: worktree\nrepos:\n  - alias: api\n    mode: submodule\n    remotes:\n      origin: git@example.com:org/api.git\n");
  const result = run(["sync", "--list"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /repos\[0\] has unknown key "mode"/);
});

test("worktree mode rejects credential-bearing and executable remote endpoints", () => {
  for (const url of [
    "https://user@example.com/org/api.git",
    "https://user:secret@example.com/org/api.git",
    "https://example.com/org/api.git?token=secret",
    "https://example.com/org/api.git#secret",
    "ext::sh -c secret",
    "custom-helper://example.com/org/api.git",
  ]) {
    const cwd = tempWorkspace();
    writeSources(cwd, `mode: worktree\nrepos:\n  - alias: api\n    remotes:\n      origin: ${url}\n`);
    const result = run(["sync", "--list"], { cwd });
    assert.equal(result.status, 1, `${url}\n${result.stdout}${result.stderr}`);
  }
});

test("worktree mode permits credential-free SSH endpoints", () => {
  for (const url of ["ssh://git@example.com/org/api.git", "git@example.com:org/api.git", "example.com:org/api.git"]) {
    const cwd = tempWorkspace();
    writeSources(cwd, `mode: worktree\nrepos:\n  - alias: api\n    remotes:\n      origin: ${url}\n`);
    const result = run(["sync", "--list"], { cwd });
    assert.equal(result.status, 0, `${url}\n${result.stdout}${result.stderr}`);
  }
});

test("init succeeds at a Git top-level", () => {
  const cwd = initGitWorkspace();
  const result = run(["init"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms.yaml")), true);
  assert.doesNotMatch(result.stdout + result.stderr, /run "git init" here/);
});

test("init preserves trailing spaces in the Git top-level path", () => {
  const parent = tempWorkspace();
  const cwd = join(parent, "workspace ");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");

  const result = run(["init"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms.yaml")), true);
});

test("init preserves a trailing carriage return in a POSIX Git top-level path", {
  skip: process.platform === "win32",
}, () => {
  const parent = tempWorkspace();
  const cwd = join(parent, "workspace\r");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");

  const result = run(["init"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms.yaml")), true);
});

test("init recognizes a localized no-work-tree diagnostic", () => {
  const cwd = tempWorkspace();
  const result = run(["init"], { cwd, env: gitTopLevelStubEnv("localized-no-work-tree") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms.yaml")), true);
});

test("init rejects a nested Git target before writes even with --force", () => {
  const root = initGitWorkspace();
  const cwd = join(root, "nested");
  mkdirSync(cwd);
  const originalManifest = "original manifest\n";
  const originalGitignore = "node_modules/\n# managed by oms\noms/\n";
  writeFileSync(join(cwd, "oms.yaml"), originalManifest);
  writeFileSync(join(cwd, ".gitignore"), originalGitignore);

  for (const args of [["init"], ["init", "--force"]]) {
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /below the root Git top-level/);
    assert.match(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(readFileSync(join(cwd, "oms.yaml"), "utf8"), originalManifest);
    assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), originalGitignore);
    assert.equal(existsSync(join(cwd, "oms")), false);
  }
});

test("init fails before writes when target identity is indeterminate", () => {
  for (const env of [gitTopLevelStubEnv("failure"), gitTopLevelStubEnv("missing-path")]) {
    const cwd = tempWorkspace();
    writeFileSync(join(cwd, ".gitignore"), "oms/\n");
    const result = run(["init", "--force"], { cwd, env });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Could not verify/);
    assert.equal(existsSync(join(cwd, "oms.yaml")), false);
    assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "oms/\n");
  }
});

test("init points to both AI-setup commands without installing anything", () => {
  const cwd = tempWorkspace();
  const result = run(["init"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  // Signposts both AI-setup commands so they are discoverable right after scaffolding.
  assert.match(output, /oms agent install/);
  assert.match(output, /oms skills/);
  // Points to the command without expanding into the installer it would print.
  assert.doesNotMatch(output, /npx skills add/);
  // init writes only oms.yaml: no agent instruction files, no skills install.
  assert.equal(existsSync(join(cwd, "oms", "AGENTS.md")), false);
  assert.equal(existsSync(join(cwd, "oms", "CLAUDE.md")), false);
});

test("init --force re-init prints the same AI-setup guidance", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["init", "--force"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /created oms\.yaml/);
  assert.match(output, /oms agent install/);
  assert.match(output, /oms skills/);
  assert.doesNotMatch(output, /npx skills add/);
});

test("doctor accepts the init-generated oms.yaml", () => {
  const cwd = tempWorkspace();
  run(["init"], { cwd });
  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.ok(result.status === 0 || result.status === 2, output);
  assert.doesNotMatch(output, /must have at least one item/);
  assert.match(output, /1 repo\(s\) configured/);
});

test("sync --list loads oms.yaml from a parent workspace (no git repo needed)", () => {
  const cwd = tempWorkspace();
  mkdirSync(join(cwd, "nested"));
  writeSources(cwd);

  const result = run(["sync", "--list"], { cwd: join(cwd, "nested") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sample/);
  assert.match(result.stdout, /git@example.com:org\/repo.git/);
  assert.match(result.stdout, /main/);
});

test("workspace discovery selects the nearest valid oms.yaml", () => {
  const outer = tempWorkspace();
  const inner = join(outer, "nested");
  mkdirSync(inner);
  writeSources(outer, sourceFor("outer", "/tmp/outer"));
  writeSources(inner, sourceFor("inner", "/tmp/inner"));

  const result = run(["sync", "--list"], { cwd: inner });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /inner/);
  assert.doesNotMatch(result.stdout, /outer/);
});

test("workspace discovery accepts an oms.yaml symlink to a regular file", () => {
  const cwd = tempWorkspace();
  const manifest = join(cwd, "manifest-target.yaml");
  writeFileSync(manifest, sourceFor("linked", "/tmp/linked"));
  symlinkSync(manifest, join(cwd, "oms.yaml"));

  const result = run(["sync", "--list"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /linked/);
});

for (const [name, createCandidate] of [
  ["directory", (path) => mkdirSync(path)],
  ["broken symbolic link", (path) => symlinkSync(join(dirname(path), "missing.yaml"), path)],
  ["symbolic link to a directory", (path) => {
    const target = join(dirname(path), "manifest-dir");
    mkdirSync(target);
    symlinkSync(target, path);
  }],
]) {
  test(`workspace discovery rejects a nearest ${name} candidate without ancestor fallback`, () => {
    const outer = tempWorkspace();
    const inner = join(outer, "nested");
    mkdirSync(inner);
    writeSources(outer, sourceFor("outer", "/tmp/outer"));
    createCandidate(join(inner, "oms.yaml"));

    const result = run(["sync", "--list"], { cwd: inner });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /regular file|broken symbolic link/);
    assert.match(output, /will not fall back/);
    assert.doesNotMatch(result.stdout, /outer/);
  });
}

test("workspace loading rejects an invalid nearest manifest without ancestor fallback", () => {
  const outer = tempWorkspace();
  const inner = join(outer, "nested");
  mkdirSync(inner);
  writeSources(outer, sourceFor("outer", "/tmp/outer"));
  writeSources(inner, "repos: []\n");

  const result = run(["sync", "--list"], { cwd: inner });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /must have at least one item/);
  assert.doesNotMatch(result.stdout, /outer/);
});

test("missing oms.yaml fails with creation guidance", () => {
  const cwd = tempWorkspace();
  const result = run(["sync", "--list"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /Could not find oms\.yaml/);
});

test("invalid oms.yaml fails before any disk side effects", () => {
  const cwd = tempWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: invalid.alias\n    remotes:\n      origin: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /must match/);
  assert.equal(existsSync(join(cwd, "oms")), false);
});

test("sync outside a git repository fails with git init guidance", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace(); // not a git repo
  writeSources(cwd, sourceFor("probe", bare));
  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not a git repository/);
  assert.equal(existsSync(join(cwd, "oms")), false);
});


test("submodule commands reject a nested manifest before root or workspace side effects", () => {
  const root = initGitWorkspace();
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeSources(nested);
  const rootStatus = gitOut(root, "status", "--porcelain");

  for (const args of [["sync", "sample"], ...sharedPreflightCommands]) {
    const result = run(args, { cwd: nested });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${args.join(" ")}\n${output}`);
    assert.match(output, /does not match the root Git top-level/, args.join(" "));
    assert.match(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(existsSync(join(root, ".gitmodules")), false);
    assert.equal(existsSync(join(nested, "oms")), false);
    assert.equal(gitOut(root, "status", "--porcelain"), rootStatus);
  }
});

test("submodule commands accept canonical-equivalent workspace paths", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const linkParent = tempWorkspace();
  const linked = join(linkParent, "workspace");
  symlinkSync(cwd, linked);

  const result = run(["status"], { cwd: linked });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /does not match the root Git top-level/);
});

test("submodule commands fail closed when Git top-level inspection is indeterminate", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const rootStatus = gitOut(cwd, "status", "--porcelain");

  for (const env of [gitTopLevelStubEnv("failure"), gitTopLevelStubEnv("missing-path")]) {
    const result = run(["sync", "sample"], { cwd, env });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Could not verify/);
    assert.equal(existsSync(join(cwd, ".gitmodules")), false);
    assert.equal(existsSync(join(cwd, "oms")), false);
    assert.equal(gitOut(cwd, "status", "--porcelain"), rootStatus);
  }
});

test("shared submodule commands fail without side effects outside a Git work tree", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);

  for (const args of sharedPreflightCommands) {
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${args.join(" ")}\n${output}`);
    assert.match(output, /not a git repository/);
    assert.equal(existsSync(join(cwd, ".gitmodules")), false);
    assert.equal(existsSync(join(cwd, "oms")), false);
  }
});

test("unsync rejects an unknown alias", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const result = run(["unsync", "missing"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /Unknown alias/);
});

test("unsync on a never-synced alias reports nothing to remove with exit 0", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const result = run(["unsync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /nothing to remove/i);
});
