import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, tempWorkspace, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, initEmptyBare, sourceFor, queueEnv } from "./helpers.js";
// --- submodule lifecycle ---

test("sync registers a submodule on its baseline branch and tracks it in the parent", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("probe", bare));

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  // .gitmodules registers oms/probe and the working tree is on the branch (not detached).
  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, /path = oms\/probe/);
  assert.match(modules, /branch = main/);
  assert.equal(gitOut(join(cwd, "oms", "probe"), "branch", "--show-current"), "main");

  // Default sync leaves topology changes in the working tree, unstaged (not auto-staged). Git collapses
  // the untracked submodule directory to `oms/` until the gitlink is recorded.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  const status = gitOut(cwd, "status", "--porcelain");
  assert.match(status, /\.gitmodules/);
  assert.match(status, /oms\//);

  // Submodules are tracked, so oms/ must not be gitignored.
  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
});

test("worktree sync provisions an owned bare common repository and relative first checkout", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const common = join(cwd, ".oms", "repos", "api.git");
  const checkout = join(cwd, "oms", "api", "main");
  assert.equal(gitOut(common, "rev-parse", "--is-bare-repository"), "true");
  assert.equal(gitOut(common, "config", "--get", "worktree.useRelativePaths"), "true");
  assert.equal(gitOut(common, "config", "--get", "oms.alias"), "api");
  assert.equal(gitOut(common, "config", "--get", "remote.origin.fetch"), "+refs/heads/*:refs/remotes/origin/*");
  assert.equal(gitOut(checkout, "branch", "--show-current"), "main");
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), gitOut(bare, "rev-parse", "refs/heads/main"));
  assert.doesNotMatch(readFileSync(join(checkout, ".git"), "utf8"), new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const ownership = JSON.parse(readFileSync(join(cwd, ".oms", "workspace.json"), "utf8"));
  assert.equal(gitOut(common, "config", "--get", "oms.workspaceId"), ownership.workspaceId);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "complete");
  assert.match(JSON.parse(readFileSync(join(cwd, ".oms", "fetch-provenance", "api", "origin.json"), "utf8")).fingerprint, /^[0-9a-f]{64}$/);
});

test("a moved whole worktree workspace keeps relative common-repository links", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const head = gitOut(join(cwd, "oms", "api", "main"), "rev-parse", "HEAD");
  const movedParent = tempWorkspace();
  const moved = join(movedParent, "workspace");
  renameSync(cwd, moved);

  const checkout = join(moved, "oms", "api", "main");
  assert.equal(
    realpathSync(gitOut(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    realpathSync(join(moved, ".oms", "repos", "api.git")),
  );
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), head);
  const status = run(["status", "--json"], { cwd: moved });
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).repos[0].worktrees[0].target, "api/main");
});

test("initial worktree sync preserves common state when origin HEAD is unresolved", () => {
  const bare = initEmptyBare();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\nrepos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /origin baseline could not be resolved/);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "common-ready");
});

test("initial worktree sync retries after origin fetch failure", () => {
  const bare = initBareUpstream();
  const unavailable = `${bare}.unavailable`;
  renameSync(bare, unavailable);
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);

  const failed = run(["sync", "api"], { cwd });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /fetch origin failed/);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "common-ready");
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);

  renameSync(unavailable, bare);
  const retried = run(["sync", "api"], { cwd });
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api", "main"), "branch", "--show-current"), "main");
});

test("subsequent worktree sync refreshes remote refs without moving the checked-out branch", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  const common = join(cwd, ".oms", "repos", "api.git");
  const localBefore = gitOut(checkout, "rev-parse", "HEAD");

  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", bare, seed], { stdio: "ignore", env: testEnv });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "remote advance");
  git(seed, "push", "origin", "main");
  const remoteAfter = gitOut(bare, "rev-parse", "refs/heads/main");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), localBefore);
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/origin/main"), remoteAfter);
});

test("initial worktree sync can explicitly continue after only an additional remote fails", () => {
  const origin = initBareUpstream();
  const missing = join(tempWorkspace(), "missing.git");
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { backup: missing })}`);

  const result = run(["sync", "api"], {
    cwd,
    env: queueEnv([{ type: "select", value: "continue" }]),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /continuing with degraded remote state/);
  assert.match(result.stdout + result.stderr, /failed remote\(s\): backup/);
  assert.equal(gitOut(join(cwd, "oms", "api", "main"), "branch", "--show-current"), "main");
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "complete");
});

test("initial worktree sync cancel and non-interactive refusal preserve fetched state without a checkout", () => {
  for (const response of [[{ type: "select", value: "cancel" }], null]) {
    const origin = initBareUpstream();
    const missing = join(tempWorkspace(), "missing.git");
    const cwd = tempWorkspace();
    writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { backup: missing })}`);

    const result = run(["sync", "api"], response ? { cwd, env: queueEnv(response) } : { cwd });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);
    assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "common-ready");
    assert.match(gitOut(join(cwd, ".oms", "repos", "api.git"), "rev-parse", "refs/remotes/origin/main"), /^[0-9a-f]{40}$/);
  }
});

test("subsequent worktree sync attempts every remote and aggregates partial operational failure", () => {
  const origin = initBareUpstream();
  const broken = initBareUpstream();
  const mirror = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { broken, mirror })}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  const common = join(cwd, ".oms", "repos", "api.git");
  const localBefore = gitOut(checkout, "rev-parse", "HEAD");
  const unavailable = `${broken}.unavailable`;
  renameSync(broken, unavailable);

  const originSeed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", origin, originSeed], { stdio: "ignore", env: testEnv });
  configIdentity(originSeed);
  git(originSeed, "commit", "--allow-empty", "-m", "origin advance");
  git(originSeed, "push", "origin", "main");
  const mirrorSeed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", mirror, mirrorSeed], { stdio: "ignore", env: testEnv });
  configIdentity(mirrorSeed);
  git(mirrorSeed, "commit", "--allow-empty", "-m", "mirror advance");
  git(mirrorSeed, "push", "origin", "main");

  const partial = run(["sync", "api"], { cwd });
  assert.equal(partial.status, 2, partial.stdout + partial.stderr);
  assert.match(partial.stdout + partial.stderr, /fetched origin/);
  assert.match(partial.stdout + partial.stderr, /fetch broken failed/);
  assert.match(partial.stdout + partial.stderr, /fetched mirror/);
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/origin/main"), gitOut(origin, "rev-parse", "refs/heads/main"));
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/mirror/main"), gitOut(mirror, "rev-parse", "refs/heads/main"));
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), localBefore);

  renameSync(unavailable, broken);
  const rerun = run(["sync", "api"], { cwd });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout + rerun.stderr, /fetched origin/);
  assert.match(rerun.stdout + rerun.stderr, /fetched broken/);
  assert.match(rerun.stdout + rerun.stderr, /fetched mirror/);
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), localBefore);
});

test("worktree sync fails closed when provisioning state is missing beside an existing common repository", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const remoteBefore = gitOut(common, "rev-parse", "refs/remotes/origin/main");
  rmSync(join(cwd, ".oms", "provisioning", "api.json"));

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /provisioning state is missing beside an existing common repository/);
  assert.match(result.stdout + result.stderr, /preserved common repository/);
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/origin/main"), remoteBefore);
});

test("worktree sync fails closed on malformed provisioning state", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  writeFileSync(provisioningPath, "{ malformed\n");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /provisioning state is malformed/);
  assert.equal(readFileSync(provisioningPath, "utf8"), "{ malformed\n");
});

test("worktree sync rejects a symlinked provisioning journal before remote mutation", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const external = tempWorkspace();
  mkdirSync(join(cwd, ".oms"));
  symlinkSync(external, join(cwd, ".oms", "provisioning"), "dir");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /symbolic link/);
  assert.equal(existsSync(join(external, "api.json")), false);
  const common = join(cwd, ".oms", "repos", "api.git");
  assert.equal(existsSync(common), true);
  assert.equal(gitOut(common, "for-each-ref", "--format=%(refname)", "refs/remotes"), "");
});

test("worktree sync never reads or deletes provenance through a symlink", () => {
  const bare = initBareUpstream();
  const replacement = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provenanceRoot = join(cwd, ".oms", "fetch-provenance");
  rmSync(provenanceRoot, { recursive: true, force: true });
  const external = tempWorkspace();
  mkdirSync(join(external, "api"));
  const canary = join(external, "api", "origin.json");
  writeFileSync(canary, "external provenance canary\n");
  symlinkSync(external, provenanceRoot, "dir");
  writeSources(cwd, `mode: worktree\n${sourceFor("api", replacement)}`);

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /symbolic link/);
  assert.equal(readFileSync(canary, "utf8"), "external provenance canary\n");
});

test("worktree sync adopts an interruption-created matching first worktree", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  const provisioning = JSON.parse(readFileSync(provisioningPath, "utf8"));
  writeFileSync(provisioningPath, `${JSON.stringify({ ...provisioning, phase: "branch-ready" }, null, 2)}\n`);
  const checkout = join(cwd, "oms", "api", "main");
  const headBefore = gitOut(checkout, "rev-parse", "HEAD");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(provisioningPath, "utf8")).phase, "complete");
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), headBefore);
  assert.equal(gitOut(join(cwd, ".oms", "repos", "api.git"), "worktree", "list", "--porcelain").match(/^worktree /gm).length, 2);
});

test("worktree sync refuses conflicting worktree-created phase identity", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  const provisioning = JSON.parse(readFileSync(provisioningPath, "utf8"));
  writeFileSync(provisioningPath, `${JSON.stringify({ ...provisioning, phase: "worktree-created", name: "other" }, null, 2)}\n`);

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /worktree topology is missing or ambiguous/);
  assert.equal(JSON.parse(readFileSync(provisioningPath, "utf8")).phase, "worktree-created");
  assert.equal(existsSync(join(cwd, "oms", "api", "other")), false);
});

test("worktree sync refuses a conflicting branch-ready branch before fetching", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  const provisioning = JSON.parse(readFileSync(provisioningPath, "utf8"));
  writeFileSync(provisioningPath, `${JSON.stringify({ ...provisioning, phase: "branch-ready" }, null, 2)}\n`);
  git(join(cwd, "oms", "api", "main"), "commit", "--allow-empty", "-m", "conflicting local commit");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /provisioning branch main conflicts with origin\/main/);
  assert.equal(JSON.parse(readFileSync(provisioningPath, "utf8")).phase, "branch-ready");
});

test("worktree sync preserves branch-ready state and removes only its empty directory after add failure", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [[ " $* " == *" worktree add "* ]]; then echo "injected worktree add failure" >&2; exit 2; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["sync", "api"], { cwd, env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` } });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /local branch main and any partial checkout were preserved/);
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "branch-ready");
  assert.match(gitOut(join(cwd, ".oms", "repos", "api.git"), "rev-parse", "refs/heads/main"), /^[0-9a-f]{40}$/);

  const retried = run(["sync", "api"], { cwd });
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "complete");
  assert.equal(gitOut(join(cwd, "oms", "api", "main"), "branch", "--show-current"), "main");
});

test("common-ready recovery preserves its validated local branch when the remote advances", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  const localBefore = gitOut(checkout, "rev-parse", "HEAD");
  assert.equal(run(["worktree", "remove", "api/main"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  const provisioning = JSON.parse(readFileSync(provisioningPath, "utf8"));
  writeFileSync(provisioningPath, `${JSON.stringify({ ...provisioning, phase: "common-ready", branch: null, name: null }, null, 2)}\n`);

  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", bare, seed], { stdio: "ignore", env: testEnv });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "remote advance during recovery");
  git(seed, "push", "origin", "main");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), localBefore);
  assert.notEqual(gitOut(bare, "rev-parse", "refs/heads/main"), localBefore);
  assert.equal(JSON.parse(readFileSync(provisioningPath, "utf8")).phase, "complete");
});

test("common-ready recovery keeps its interruption-created branch when origin HEAD changes", () => {
  const bare = initBareUpstream({ branches: ["main", "trunk"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\nrepos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "remove", "api/main"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  const provisioning = JSON.parse(readFileSync(provisioningPath, "utf8"));
  writeFileSync(provisioningPath, `${JSON.stringify({ ...provisioning, phase: "common-ready", branch: null, name: null }, null, 2)}\n`);
  git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api", "main"), "branch", "--show-current"), "main");
  assert.equal(existsSync(join(cwd, "oms", "api", "trunk")), false);
});

test("completed provisioning remains complete after the final worktree is removed", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "remove", "api/main"], { cwd }).status, 0);
  const provisioningPath = join(cwd, ".oms", "provisioning", "api.json");
  assert.equal(JSON.parse(readFileSync(provisioningPath, "utf8")).phase, "complete");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);
  assert.equal(JSON.parse(readFileSync(provisioningPath, "utf8")).phase, "complete");
});

test("subsequent worktree sync warns when the configured baseline disappears", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  const localBefore = gitOut(checkout, "rev-parse", "HEAD");
  git(bare, "update-ref", "-d", "refs/heads/main");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /configured baseline origin\/main is unavailable/);
  assert.equal(gitOut(checkout, "rev-parse", "HEAD"), localBefore);
  assert.equal(spawnSync("git", ["-C", join(cwd, ".oms", "repos", "api.git"), "rev-parse", "--verify", "refs/remotes/origin/main"], { env: testEnv }).status, 128);
});

test("subsequent worktree sync prunes only a revalidated stale managed registration", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const managed = join(cwd, "oms", "api", "main");
  const registeredManaged = realpathSync(managed);
  rmSync(managed, { recursive: true, force: true });
  assert.match(gitOut(common, "worktree", "list", "--porcelain"), new RegExp(`worktree ${registeredManaged.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pruned stale managed worktree registration/);
  assert.doesNotMatch(gitOut(common, "worktree", "list", "--porcelain"), new RegExp(`worktree ${registeredManaged.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(JSON.parse(readFileSync(join(cwd, ".oms", "provisioning", "api.json"), "utf8")).phase, "complete");
});

test("subsequent worktree sync refuses a possible manual move and preserves external stale registrations", () => {
  const bare = initBareUpstream({ branches: ["main", "external"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const original = join(cwd, "oms", "api", "main");
  const registeredOriginal = realpathSync(original);
  const movedParent = join(cwd, "oms", "moved");
  const moved = join(movedParent, "main");
  mkdirSync(movedParent);
  renameSync(original, moved);
  const external = tempWorkspace();
  git(common, "branch", "external", "refs/remotes/origin/external");
  git(common, "worktree", "add", external, "external");
  const registeredExternal = realpathSync(external);
  rmSync(external, { recursive: true, force: true });

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /may have been moved manually/);
  assert.equal(existsSync(moved), true);
  const registrations = gitOut(common, "worktree", "list", "--porcelain");
  assert.match(registrations, new RegExp(`worktree ${registeredOriginal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(registrations, new RegExp(`worktree ${registeredExternal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("worktree sync reconciles declared remote drift and preserves undeclared remotes", () => {
  const bare = initBareUpstream();
  const drifted = initEmptyBare();
  const extra = initEmptyBare();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "remote", "set-url", "origin", `file://${drifted}`);
  git(common, "config", "--replace-all", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
  git(common, "remote", "add", "extra", `file://${extra}`);

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(common, "remote", "get-url", "origin"), `file://${bare}`);
  assert.equal(gitOut(common, "config", "--get-all", "remote.origin.fetch"), "+refs/heads/*:refs/remotes/origin/*");
  assert.equal(gitOut(common, "remote", "get-url", "extra"), `file://${extra}`);
});

test("worktree sync rejects additional declared-remote URLs before fetching", () => {
  const bare = initBareUpstream();
  const additional = initEmptyBare();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "remote", "set-url", "--add", "origin", `file://${additional}`);

  const result = run(["sync", "api"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /remote origin has additional fetch URLs/);
  assert.equal(gitOut(common, "config", "--get-all", "remote.origin.url").split("\n").length, 2);
});

test("worktree sync rejects declared-remote pushurl drift before fetching", () => {
  const bare = initBareUpstream();
  const pushTarget = initEmptyBare();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "remote", "set-url", "--push", "origin", `file://${pushTarget}`);

  const result = run(["sync", "api"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /remote origin has undeclared pushurl configuration/);
  assert.equal(gitOut(common, "remote", "get-url", "--push", "origin"), `file://${pushTarget}`);
});

test("worktree add, list, move, and remove preserve attached local branches", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/login"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const add = run(["worktree", "add", "api", "feature/login"], { cwd });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const original = join(cwd, "oms", "api", "feature-login");
  assert.equal(gitOut(original, "branch", "--show-current"), "feature/login");

  const list = run(["worktree", "list", "api"], { cwd });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  assert.match(list.stdout, /api\/main\s+main/);
  assert.match(list.stdout, /api\/feature-login\s+feature\/login/);

  const move = run(["worktree", "move", "api/feature-login", "login-v2"], { cwd });
  assert.equal(move.status, 0, move.stdout + move.stderr);
  const moved = join(cwd, "oms", "api", "login-v2");
  assert.equal(gitOut(moved, "branch", "--show-current"), "feature/login");

  const remove = run(["worktree", "remove", "api/login-v2"], { cwd });
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  assert.equal(existsSync(moved), false);
  assert.equal(gitOut(join(cwd, ".oms", "repos", "api.git"), "rev-parse", "refs/heads/feature/login"), gitOut(bare, "rev-parse", "refs/heads/feature/login"));
});

test("worktree add resolves interactive inputs and rejects missing non-interactive inputs", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/login"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const interactive = run(["worktree", "add"], {
    cwd,
    env: queueEnv([
      { type: "select", value: "api" },
      { type: "text", value: "feature/login" },
    ]),
  });
  assert.equal(interactive.status, 0, interactive.stdout + interactive.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api", "feature-login"), "branch", "--show-current"), "feature/login");

  const missingAlias = run(["worktree", "add"], { cwd });
  assert.equal(missingAlias.status, 1, missingAlias.stdout + missingAlias.stderr);
  assert.match(missingAlias.stdout + missingAlias.stderr, /requires a repository alias/);
  const missingBranch = run(["worktree", "add", "api"], { cwd });
  assert.equal(missingBranch.status, 1, missingBranch.stdout + missingBranch.stderr);
  assert.match(missingBranch.stdout + missingBranch.stderr, /requires a branch/);
});

test("worktree add honors selected remote tracking, explicit start points, names, and checked-out protection", () => {
  const origin = initBareUpstream();
  const upstream = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { upstream })}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const tracked = run(["worktree", "add", "api", "dev", "--remote", "upstream", "--name", "upstream-dev"], { cwd });
  assert.equal(tracked.status, 0, tracked.stdout + tracked.stderr);
  const common = join(cwd, ".oms", "repos", "api.git");
  assert.equal(gitOut(common, "for-each-ref", "--format=%(upstream:short)", "refs/heads/dev"), "upstream/dev");

  const created = run(["worktree", "add", "api", "scratch", "--from", "refs/remotes/origin/main", "--name", "scratch-space"], { cwd });
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api", "scratch-space"), "rev-parse", "HEAD"), gitOut(origin, "rev-parse", "refs/heads/main"));

  const checkedOut = run(["worktree", "add", "api", "main", "--name", "second-main"], { cwd });
  assert.equal(checkedOut.status, 1, checkedOut.stdout + checkedOut.stderr);
  assert.match(checkedOut.stdout + checkedOut.stderr, /branch main is already checked out/);
});

test("worktree add failure preserves its branch, removes only its empty directory, and retries", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [[ " $* " == *" worktree add "* ]]; then exit 2; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(stubGit, 0o755);

  const failed = run(["worktree", "add", "api", "dev"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /branch dev was preserved/);
  assert.match(failed.stdout + failed.stderr, /Retry "oms worktree add api dev"/);
  assert.equal(existsSync(join(cwd, "oms", "api", "dev")), false);
  assert.match(gitOut(join(cwd, ".oms", "repos", "api.git"), "rev-parse", "refs/heads/dev"), /^[0-9a-f]{40}$/);

  const retried = run(["worktree", "add", "api", "dev"], { cwd });
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api", "dev"), "branch", "--show-current"), "dev");
});

test("worktree move preserves dirty state and refuses collisions, operations, and locks", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const dev = join(cwd, "oms", "api", "dev");
  writeFileSync(join(dev, "dirty.txt"), "dirty\n");

  const collision = run(["worktree", "move", "api/dev", "main"], { cwd });
  assert.equal(collision.status, 1, collision.stdout + collision.stderr);
  const moved = run(["worktree", "move", "api/dev", "dev-dirty"], { cwd });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  const dirty = join(cwd, "oms", "api", "dev-dirty");
  assert.equal(readFileSync(join(dirty, "dirty.txt"), "utf8"), "dirty\n");

  const mergeHead = gitOut(dirty, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(resolve(dirty, mergeHead), `${gitOut(dirty, "rev-parse", "HEAD")}\n`);
  const operation = run(["worktree", "move", "api/dev-dirty", "blocked"], { cwd });
  assert.equal(operation.status, 1, operation.stdout + operation.stderr);
  assert.match(operation.stdout + operation.stderr, /Git operation merge is in progress/);
  rmSync(resolve(dirty, mergeHead));

  git(join(cwd, ".oms", "repos", "api.git"), "worktree", "lock", dirty);
  const lockedMove = run(["worktree", "move", "api/dev-dirty", "blocked"], { cwd });
  assert.equal(lockedMove.status, 1, lockedMove.stdout + lockedMove.stderr);
  const lockedRemove = run(["worktree", "remove", "api/dev-dirty", "--force"], { cwd });
  assert.equal(lockedRemove.status, 1, lockedRemove.stdout + lockedRemove.stderr);
  assert.match(lockedRemove.stdout + lockedRemove.stderr, /locked/);
});

test("worktree move and remove failures preserve retryable paths, registrations, and branches", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const original = join(cwd, "oms", "api", "dev");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [[ " $* " == *" worktree move "* || " $* " == *" worktree remove "* ]]; then exit 2; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);
  const env = { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` };

  const failedMove = run(["worktree", "move", "api/dev", "dev-moved"], { cwd, env });
  assert.equal(failedMove.status, 2, failedMove.stdout + failedMove.stderr);
  assert.match(failedMove.stdout + failedMove.stderr, /move failed.*oms worktree list api/);
  assert.equal(existsSync(original), true);
  assert.match(gitOut(common, "worktree", "list", "--porcelain"), /branch refs\/heads\/dev/);

  const moved = run(["worktree", "move", "api/dev", "dev-moved"], { cwd });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  const movedPath = join(cwd, "oms", "api", "dev-moved");
  const failedRemove = run(["worktree", "remove", "api/dev-moved"], { cwd, env });
  assert.equal(failedRemove.status, 2, failedRemove.stdout + failedRemove.stderr);
  assert.match(failedRemove.stdout + failedRemove.stderr, /removal failed; the branch was preserved/);
  assert.equal(existsSync(movedPath), true);
  assert.match(gitOut(common, "rev-parse", "refs/heads/dev"), /^[0-9a-f]{40}$/);

  const removed = run(["worktree", "remove", "api/dev-moved"], { cwd });
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(existsSync(movedPath), false);
  assert.match(gitOut(common, "rev-parse", "refs/heads/dev"), /^[0-9a-f]{40}$/);
});

test("worktree commit resolves current and explicit targets and remains checkout-local", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const main = join(cwd, "oms", "api", "main");
  mkdirSync(join(main, "nested"));
  writeFileSync(join(main, "current.txt"), "current\n");
  const current = run(["commit", "-m", "test: current worktree"], { cwd: join(main, "nested") });
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.match(current.stdout + current.stderr, /api\/main: committed/);
  assert.doesNotMatch(current.stdout + current.stderr, /oms record|root pointer/i);

  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const dev = join(cwd, "oms", "api", "dev");
  writeFileSync(join(main, "main-only.txt"), "main\n");
  writeFileSync(join(dev, "dev-only.txt"), "dev\n");
  const ambiguous = run(["commit", "api", "-m", "test: ambiguous"], { cwd });
  assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stdout + ambiguous.stderr, /Multiple managed worktrees.*alias\/name/);

  const mainBefore = gitOut(main, "rev-parse", "HEAD");
  const explicit = run(["commit", "api/dev", "-m", "test: explicit worktree"], { cwd });
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
  assert.notEqual(gitOut(dev, "rev-parse", "HEAD"), gitOut(bare, "rev-parse", "refs/heads/dev"));
  assert.equal(gitOut(main, "rev-parse", "HEAD"), mainBefore);
  assert.equal(existsSync(join(main, "main-only.txt")), true);
});

test("ineligible current worktree never falls through non-interactively and allows explicit interactive reselection", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const main = join(cwd, "oms", "api", "main");
  const dev = join(cwd, "oms", "api", "dev");
  const mergeHead = gitOut(dev, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(resolve(dev, mergeHead), `${gitOut(dev, "rev-parse", "HEAD")}\n`);
  writeFileSync(join(main, "selected.txt"), "selected\n");

  const refused = run(["commit", "-m", "test: should not fall through"], { cwd: dev });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /current target cannot commit because merge in progress/);
  assert.equal(existsSync(join(main, "selected.txt")), true);

  const selected = run(["commit", "-m", "test: selected alternative"], {
    cwd: dev,
    env: queueEnv([{ type: "select", value: "api/main" }]),
  });
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.equal(existsSync(join(main, "selected.txt")), true);
  assert.equal(gitOut(main, "status", "--porcelain"), "");
});

test("detached current commit and in-progress current checkout refuse without target fallback", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const main = join(cwd, "oms", "api", "main");
  const dev = join(cwd, "oms", "api", "dev");
  git(main, "checkout", "--detach");
  writeFileSync(join(main, "detached.txt"), "local\n");

  const detached = run(["commit", "-m", "test: detached"], { cwd: main });
  assert.equal(detached.status, 1, detached.stdout + detached.stderr);
  assert.match(detached.stdout + detached.stderr, /current target cannot commit because detached HEAD/);
  assert.equal(existsSync(join(main, "detached.txt")), true);

  const mergeHead = gitOut(dev, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(resolve(dev, mergeHead), `${gitOut(dev, "rev-parse", "HEAD")}\n`);
  const checkout = run(["branch", "checkout"], { cwd: dev });
  assert.equal(checkout.status, 1, checkout.stdout + checkout.stderr);
  assert.match(checkout.stdout + checkout.stderr, /current target cannot branch-checkout because merge in progress/);
});

test("worktree fetch defaults to every declared remote, aggregates failures, and supports explicit filtering", () => {
  const origin = initBareUpstream();
  const backup = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { backup })}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const unavailable = `${backup}.unavailable`;
  renameSync(backup, unavailable);

  const partial = run(["fetch", "api"], { cwd });
  assert.equal(partial.status, 2, partial.stdout + partial.stderr);
  assert.match(partial.stdout + partial.stderr, /fetched origin/);
  assert.match(partial.stdout + partial.stderr, /fetch backup failed/);

  const selected = run(["fetch", "api", "--remote", "origin"], { cwd });
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.match(selected.stdout + selected.stderr, /fetched origin/);
  assert.doesNotMatch(selected.stdout + selected.stderr, /fetching backup|fetch backup/);

  const unknown = run(["fetch", "api", "--remote", "unknown"], { cwd });
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /not declared in oms.yaml/);

  renameSync(unavailable, backup);
  const rerun = run(["fetch", "api"], { cwd });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout + rerun.stderr, /fetched origin/);
  assert.match(rerun.stdout + rerun.stderr, /fetched backup/);
});

test("worktree pull targets managed checkouts, follows declared upstreams, and aggregates safety refusals", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const main = join(cwd, "oms", "api", "main");
  const dev = join(cwd, "oms", "api", "dev");
  const mainBefore = gitOut(main, "rev-parse", "HEAD");
  const devBefore = gitOut(dev, "rev-parse", "HEAD");

  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", bare, seed], { stdio: "ignore", env: testEnv });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "advance main");
  git(seed, "push", "origin", "main");
  git(seed, "checkout", "dev");
  git(seed, "commit", "--allow-empty", "-m", "advance dev");
  git(seed, "push", "origin", "dev");

  const pulled = run(["pull", "--all"], { cwd });
  assert.equal(pulled.status, 0, pulled.stdout + pulled.stderr);
  assert.notEqual(gitOut(main, "rev-parse", "HEAD"), mainBefore);
  assert.notEqual(gitOut(dev, "rev-parse", "HEAD"), devBefore);

  writeFileSync(join(dev, "dirty.txt"), "dirty\n");
  const partial = run(["pull", "--all"], { cwd });
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.match(partial.stdout + partial.stderr, /api\/dev: cannot pull because dirty working tree/);
  assert.match(partial.stdout + partial.stderr, /api\/main: pulled/);
  rmSync(join(dev, "dirty.txt"));
  const rerun = run(["pull", "--all"], { cwd });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout + rerun.stderr, /api\/main: pulled/);
  assert.match(rerun.stdout + rerun.stderr, /api\/dev: pulled/);
  git(dev, "config", "branch.dev.remote", "rogue");
  git(dev, "config", "branch.dev.merge", "refs/heads/dev");
  const undeclared = run(["pull", "api/dev"], { cwd });
  assert.equal(undeclared.status, 1, undeclared.stdout + undeclared.stderr);
  assert.match(undeclared.stdout + undeclared.stderr, /upstream remote.*not declared|explicit declared --remote/);
});
