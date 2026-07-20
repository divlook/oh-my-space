import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, tempWorkspace, writeSources, git, configIdentity, initBareUpstream, initGitWorkspace, gitOut, initEmptyBare, sourceFor } from "./helpers.js";
test("worktree push sets origin upstream and attempts every explicit declared remote independently", () => {
  const origin = initBareUpstream();
  const backup = initEmptyBare();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { backup })}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "scratch", "--from", "refs/remotes/origin/main"], { cwd }).status, 0);
  const scratch = join(cwd, "oms", "api", "scratch");
  git(scratch, "commit", "--allow-empty", "-m", "scratch commit");

  const first = run(["push", "api/scratch"], { cwd });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(gitOut(scratch, "for-each-ref", "--format=%(upstream:short)", "refs/heads/scratch"), "origin/scratch");
  assert.equal(gitOut(origin, "rev-parse", "refs/heads/scratch"), gitOut(scratch, "rev-parse", "HEAD"));

  git(scratch, "commit", "--allow-empty", "-m", "second scratch commit");
  const unavailable = `${backup}.unavailable`;
  renameSync(backup, unavailable);
  const partial = run(["push", "api/scratch", "--remote", "backup", "--remote", "origin"], { cwd });
  assert.equal(partial.status, 2, partial.stdout + partial.stderr);
  assert.match(partial.stdout + partial.stderr, /push to backup failed/);
  assert.match(partial.stdout + partial.stderr, /pushed to origin\/scratch/);
  assert.equal(gitOut(origin, "rev-parse", "refs/heads/scratch"), gitOut(scratch, "rev-parse", "HEAD"));
});

test("worktree branch switch and checkout are target-scoped and protect branches checked out elsewhere", () => {
  const origin = initBareUpstream({ branches: ["main", "dev", "cached"] });
  const upstream = initBareUpstream({ branches: ["main", "release"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", origin, "main", { upstream })}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const main = join(cwd, "oms", "api", "main");
  const dev = join(cwd, "oms", "api", "dev");

  const switched = run(["branch", "switch", "api/main", "feature/local", "--from", "main"], { cwd });
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  assert.equal(gitOut(main, "branch", "--show-current"), "feature/local");
  assert.equal(gitOut(dev, "branch", "--show-current"), "dev");
  const occupied = run(["branch", "switch", "api/dev", "feature/local"], { cwd });
  assert.equal(occupied.status, 1, occupied.stdout + occupied.stderr);
  assert.match(occupied.stdout + occupied.stderr, /already checked out at/);

  const checkedOut = run(["branch", "checkout", "api/main", "release", "--remote", "upstream"], { cwd });
  assert.equal(checkedOut.status, 0, checkedOut.stdout + checkedOut.stderr);
  assert.equal(gitOut(main, "branch", "--show-current"), "release");
  assert.equal(gitOut(main, "for-each-ref", "--format=%(upstream:short)", "refs/heads/release"), "upstream/release");

  rmSync(origin, { recursive: true, force: true });
  const cached = run(["branch", "checkout", "api/main", "cached"], { cwd });
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
  assert.match(cached.stdout + cached.stderr, /using refs from the last verified fetch as stale data/);
  assert.equal(gitOut(main, "branch", "--show-current"), "cached");
});

test("worktree mode rejects record because no parent gitlink exists", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no parent gitlink pointer to record/);
});

test("worktree branch delete protects managed, external, and resolved baseline branches", () => {
  const bare = initBareUpstream({ branches: ["main", "dev", "external"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\nrepos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "branch", "external", "refs/remotes/origin/external");
  const external = tempWorkspace();
  git(common, "worktree", "add", external, "external");
  git(common, "branch", "delete-me", "refs/heads/main");

  const managed = run(["branch", "delete", "api", "dev", "--force"], { cwd });
  assert.equal(managed.status, 1, managed.stdout + managed.stderr);
  assert.match(managed.stdout + managed.stderr, /checked out at/);
  const outside = run(["branch", "delete", "api", "external", "--force"], { cwd });
  assert.equal(outside.status, 1, outside.stdout + outside.stderr);
  assert.match(outside.stdout + outside.stderr, new RegExp(realpathSync(external).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const deleted = run(["branch", "delete", "api", "delete-me"], { cwd });
  assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
  assert.equal(spawnSync("git", ["-C", common, "rev-parse", "--verify", "refs/heads/delete-me"], { env: testEnv }).status, 128);

  assert.equal(run(["worktree", "remove", "api/main"], { cwd }).status, 0);
  const baseline = run(["branch", "delete", "api", "main", "--force"], { cwd });
  assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
  assert.match(baseline.stdout + baseline.stderr, /protected baseline branch/);
});

test("worktree inventory classifies external, locked, stale, and safely prunable registrations", () => {
  const bare = initBareUpstream({ branches: ["main", "external"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const managed = join(cwd, "oms", "api", "main");
  const external = tempWorkspace();
  git(common, "branch", "external", "refs/remotes/origin/external");
  git(common, "worktree", "add", external, "external");
  git(common, "worktree", "lock", external);

  const mixed = run(["worktree", "list", "api"], { cwd });
  assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);
  assert.match(mixed.stdout, /api\/main\s+main/);
  assert.match(mixed.stdout, /api\/\(external\).*external,locked/);

  rmSync(managed, { recursive: true, force: true });
  const stale = run(["worktree", "list", "api"], { cwd });
  assert.equal(stale.status, 0, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /api\/main\s+main.*stale,prunable/);
});

test("worktree inventory refuses safe prune when a nested manual-move candidate exists", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const original = join(cwd, "oms", "api", "main");
  const movedParent = join(cwd, "oms", "moved");
  const moved = join(movedParent, "deeper");
  mkdirSync(movedParent);
  renameSync(original, moved);

  const result = run(["worktree", "list", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /api\/main\s+main.*stale/);
  assert.doesNotMatch(result.stdout, /api\/main\s+main.*prunable/);
});

test("worktree doctor diagnoses a manual move with bounded read-only repair guidance", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const original = join(cwd, "oms", "api", "main");
  const moved = join(cwd, "oms", "manual-move", "main");
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(original, moved);
  const registrationBefore = gitOut(join(cwd, ".oms", "repos", "api.git"), "worktree", "list", "--porcelain");

  const result = run(["doctor"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /may have been moved manually/);
  assert.match(result.stdout + result.stderr, /git -C .* worktree repair <actual-path>/);
  assert.equal(gitOut(join(cwd, ".oms", "repos", "api.git"), "worktree", "list", "--porcelain"), registrationBefore);
  assert.equal(existsSync(moved), true);
});

test("worktree inventory does not manage a checkout through a symlinked path component", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const aliasPath = join(cwd, "oms", "api");
  const actualPath = join(cwd, "oms", "api-actual");
  renameSync(aliasPath, actualPath);
  symlinkSync(actualPath, aliasPath, "dir");

  const result = run(["worktree", "remove", "api/main", "--force"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /not a registered managed worktree/);
  assert.equal(existsSync(join(actualPath, "main")), true);
});

test("worktree inventory rejects foreign common repository ownership", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "config", "oms.workspaceId", "00000000-0000-0000-0000-000000000000");

  const result = run(["worktree", "list", "api"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /ownership or shape does not match/);
});

test("worktree sync reconciles nested enclosing-Git excludes without hiding agent files", () => {
  const bare = initBareUpstream();
  const gitRoot = initGitWorkspace();
  const cwd = join(gitRoot, "nested");
  mkdirSync(cwd);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const instructions = join(cwd, "oms");
  mkdirSync(instructions);
  writeFileSync(join(instructions, "AGENTS.md"), "agents\n");
  writeFileSync(join(instructions, "CLAUDE.md"), "claude\n");
  const excludePath = join(gitRoot, ".git", "info", "exclude");
  writeFileSync(excludePath, "# user rule\r\n*.local\r\n");
  chmodSync(excludePath, 0o640);

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const exclude = readFileSync(excludePath, "utf8");
  assert.match(exclude, /^# user rule\r\n\*\.local\r\n/);
  assert.match(exclude, /\/nested\/\.oms\/workspace\.json\r\n/);
  assert.match(exclude, /\/nested\/\.oms\/repos\/\r\n/);
  assert.match(exclude, /\/nested\/oms\/api\/main\/\r\n/);
  assert.equal(statSync(excludePath).mode & 0o777, 0o640);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "nested/.oms/workspace.json"], { cwd: gitRoot }).status, 0);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "nested/oms/AGENTS.md"], { cwd: gitRoot }).status, 1);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "nested/oms/CLAUDE.md"], { cwd: gitRoot }).status, 1);
});

test("workspace exclude lock and malformed markers fail before worktree mutation", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const excludePath = join(cwd, ".git", "info", "exclude");
  const excludeLock = `${excludePath}.oms.lock`;
  writeFileSync(excludeLock, "occupied\n");

  const locked = run(["worktree", "add", "api", "dev"], { cwd });
  assert.equal(locked.status, 1, locked.stdout + locked.stderr);
  assert.match(locked.stdout + locked.stderr, /local exclude file is locked/);
  assert.equal(existsSync(join(cwd, "oms", "api", "dev")), false);
  assert.equal(readFileSync(excludeLock, "utf8"), "occupied\n");

  rmSync(excludeLock);
  const ownership = JSON.parse(readFileSync(join(cwd, ".oms", "workspace.json"), "utf8"));
  writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}literal # oms workspace ${ownership.workspaceId} begin text\n`);
  const inline = run(["sync", "api"], { cwd });
  assert.equal(inline.status, 0, inline.stdout + inline.stderr);
  assert.match(readFileSync(excludePath, "utf8"), /literal # oms workspace .* begin text/);
  writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}# oms workspace invalid marker\n`);
  const invalid = run(["worktree", "add", "api", "dev"], { cwd });
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout + invalid.stderr, /marker block is malformed/);
  writeFileSync(excludePath, readFileSync(excludePath, "utf8").replace("# oms workspace invalid marker\n", ""));
  writeFileSync(excludePath, `${readFileSync(excludePath, "utf8")}# oms workspace ${ownership.workspaceId} begin\n`);
  const malformed = run(["worktree", "add", "api", "dev"], { cwd });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stdout + malformed.stderr, /marker block is malformed/);
  assert.equal(existsSync(join(cwd, "oms", "api", "dev")), false);
  assert.equal(existsSync(excludeLock), false);
});

test("workspace exclude discovery ignores inherited Git repository routing", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const gitRoot = initGitWorkspace();
  const cwd = join(gitRoot, "nested");
  mkdirSync(cwd);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const actualExclude = join(gitRoot, ".git", "info", "exclude");
  writeFileSync(actualExclude, "# reset actual\n");
  const foreign = initGitWorkspace();
  const foreignExclude = join(foreign, ".git", "info", "exclude");
  writeFileSync(foreignExclude, "# foreign sentinel\n");

  run(["worktree", "add", "api", "dev"], {
    cwd,
    env: { ...testEnv, GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign },
  });
  assert.match(readFileSync(actualExclude, "utf8"), /# oms workspace/);
  assert.equal(readFileSync(foreignExclude, "utf8"), "# foreign sentinel\n");
});

test("workspace excludes only ownership-verified generated paths", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const aliasPath = join(cwd, "oms", "api");
  mkdirSync(aliasPath, { recursive: true });
  writeFileSync(join(aliasPath, "notes.txt"), "user data\n");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "oms/api/main"], { cwd }).status, 0);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "oms/api/notes.txt"], { cwd }).status, 1);

  const foreignRoot = initGitWorkspace();
  writeSources(foreignRoot, `mode: worktree\n${sourceFor("api", bare)}`);
  const foreignCommon = join(foreignRoot, ".oms", "repos", "api.git");
  mkdirSync(join(foreignRoot, ".oms", "repos"), { recursive: true });
  execFileSync("git", ["init", "--bare", foreignCommon], { stdio: "ignore", env: testEnv });
  const refused = run(["sync", "api"], { cwd: foreignRoot });
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.equal(spawnSync("git", ["check-ignore", "-q", ".oms/repos/api.git/HEAD"], { cwd: foreignRoot }).status, 1);
});

test("submodule-mode reconciliation removes only worktree-specific exclude rules", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const excludePath = join(cwd, ".git", "info", "exclude");
  assert.match(readFileSync(excludePath, "utf8"), /\/\.oms\/repos\//);
  writeSources(cwd, `mode: submodule\n${sourceFor("api", bare)}`);

  run(["fetch", "api"], { cwd });
  const exclude = readFileSync(excludePath, "utf8");
  assert.match(exclude, /\/\.oms\/workspace\.json/);
  assert.match(exclude, /\/\.oms-mutation\.lock/);
  assert.match(exclude, /\/\.oms-mode-switch\.json/);
  assert.doesNotMatch(exclude, /\/\.oms\/repos\//);
  assert.doesNotMatch(exclude, /\/oms\/api\//);
});

test("worktree removal inspects ignored and nested repository data", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  writeFileSync(join(checkout, ".gitignore"), "ignored.txt\n");
  git(checkout, "add", ".gitignore");
  git(checkout, "commit", "-m", "ignore fixture");
  writeFileSync(join(checkout, "ignored.txt"), "ignored\n");
  const nested = join(checkout, "nested");
  mkdirSync(nested);
  git(nested, "init");
  const nestedBare = join(checkout, "nested-bare.git");
  execFileSync("git", ["init", "--bare", nestedBare], { stdio: "ignore", env: testEnv });
  git(checkout, "config", "status.showUntrackedFiles", "no");

  const refused = run(["worktree", "remove", "api/main"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /1 ignored/);
  assert.match(refused.stdout + refused.stderr, /[1-9]\d* untracked/);
  assert.match(refused.stdout + refused.stderr, /2 nested repositories/);
  assert.equal(existsSync(checkout), true);

  const forced = run(["worktree", "remove", "api/main", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout + forced.stderr, /forcing removal/);
  assert.equal(existsSync(checkout), false);
});

test("worktree removal inspects in-progress operations", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  const mergeHead = gitOut(checkout, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(resolve(checkout, mergeHead), `${gitOut(checkout, "rev-parse", "HEAD")}\n`);

  const refused = run(["worktree", "remove", "api/main"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /merge in progress/);
  assert.equal(existsSync(checkout), true);
});

test("worktree removal protects an unrecoverable detached HEAD", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  git(checkout, "commit", "--allow-empty", "-m", "detached local commit");
  const detached = gitOut(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "--detach");
  git(checkout, "update-ref", "refs/worktree/keep", detached);
  git(join(cwd, ".oms", "repos", "api.git"), "branch", "-D", "main");

  const refused = run(["worktree", "remove", "api/main"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, new RegExp(`detached unpublished HEAD ${detached}`));
  assert.equal(existsSync(checkout), true);
});

test("worktree add uses cached refs only after a matching successful fetch", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/login"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  rmSync(bare, { recursive: true, force: true });

  const result = run(["worktree", "add", "api", "feature/login"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /using refs from the last verified fetch as stale data/);
  assert.equal(gitOut(join(cwd, "oms", "api", "feature-login"), "branch", "--show-current"), "feature/login");
});

test("worktree remote URL drift invalidates cached refs before a failed fetch", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/login"] });
  const unavailable = tempWorkspace();
  rmSync(unavailable, { recursive: true, force: true });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provenance = join(cwd, ".oms", "fetch-provenance", "api", "origin.json");
  assert.equal(existsSync(provenance), true);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", unavailable)}`);

  const result = run(["worktree", "add", "api", "feature/login"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /fetch origin failed; no worktree was created/);
  assert.equal(existsSync(provenance), false);
  assert.equal(existsSync(join(cwd, "oms", "api", "feature-login")), false);
});

test("malformed fetch provenance remains untrusted across processes and is replaced after a successful fetch", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/login"] });
  const unavailable = `${bare}.unavailable`;
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const provenance = join(cwd, ".oms", "fetch-provenance", "api", "origin.json");
  writeFileSync(provenance, "{ interrupted\n");
  renameSync(bare, unavailable);

  const refused = run(["worktree", "add", "api", "feature/login"], { cwd });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /fetch origin failed; no worktree was created/);
  assert.equal(existsSync(join(cwd, "oms", "api", "feature-login")), false);

  renameSync(unavailable, bare);
  const recovered = run(["sync", "api"], { cwd });
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.match(JSON.parse(readFileSync(provenance, "utf8")).fingerprint, /^[0-9a-f]{64}$/);
});

test("worktree fetch ignores injected and global Git URL rewrites", () => {
  const bare = initBareUpstream();
  const redirected = initBareUpstream();
  const redirectedSeed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", redirected, redirectedSeed], { stdio: "ignore", env: testEnv });
  configIdentity(redirectedSeed);
  git(redirectedSeed, "commit", "--allow-empty", "-m", "redirected only");
  git(redirectedSeed, "push", "origin", "main");
  const cwd = tempWorkspace();
  const home = tempWorkspace();
  writeFileSync(join(home, ".gitconfig"), `[url "file://${redirected}"]\n\tinsteadOf = file://${bare}\n`);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const env = {
    ...testEnv,
    HOME: home,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: `url.file://${redirected}.insteadOf`,
    GIT_CONFIG_VALUE_1: `file://${bare}`,
  };

  const result = run(["sync", "api"], { cwd, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api", "main"), "rev-parse", "HEAD"), gitOut(bare, "rev-parse", "refs/heads/main"));
  assert.notEqual(gitOut(bare, "rev-parse", "refs/heads/main"), gitOut(redirected, "rev-parse", "refs/heads/main"));
});

test("worktree fetch rejects local Git URL rewrites before network access", () => {
  const bare = initBareUpstream();
  const redirected = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const refBefore = gitOut(common, "rev-parse", "refs/remotes/origin/main");
  git(common, "config", `url.file://${redirected}.insteadOf`, `file://${bare}`);

  const result = run(["sync", "api"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /local Git URL rewrite configuration is not allowed/);
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/origin/main"), refBefore);
});

test("worktree fetch rejects a local pushInsteadOf rewrite before network access", () => {
  const bare = initBareUpstream();
  const redirected = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const refBefore = gitOut(common, "rev-parse", "refs/remotes/origin/main");
  git(common, "config", `url.file://${redirected}.pushInsteadOf`, `file://${bare}`);

  const result = run(["sync", "api"], { cwd });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /local Git URL rewrite configuration is not allowed/);
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/origin/main"), refBefore);
});

test("worktree unsync removes clean published managed state and retains the manifest", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const manifest = readFileSync(join(cwd, "oms.yaml"), "utf8");

  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);
  assert.equal(existsSync(join(cwd, ".oms", "provisioning", "api.json")), false);
  assert.equal(readFileSync(join(cwd, "oms.yaml"), "utf8"), manifest);
});

test("worktree unsync requires force for dirty state and discloses discarded categories", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  writeFileSync(join(checkout, "local.txt"), "local\n");

  const refused = run(["unsync", "api"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(existsSync(checkout), true);

  const forced = run(["unsync", "api", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout + forced.stderr, /force will discard untracked=1/);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);
});

test("worktree unsync protects metadata refs and dangling objects with full-OID force disclosure", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const head = gitOut(common, "rev-parse", "refs/heads/main");
  git(common, "tag", "local-only", head);
  const dangling = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: common,
    encoding: "utf8",
    input: "recoverable local blob\n",
    env: testEnv,
  }).trim();

  const refused = run(["unsync", "api"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, new RegExp(`tag refs/tags/local-only commit ${head}`));
  assert.match(refused.stdout + refused.stderr, new RegExp(`dangling blob ${dangling}`));

  const forced = run(["unsync", "api", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout + forced.stderr, new RegExp(`force will discard tag refs/tags/local-only commit ${head}`));
  assert.match(forced.stdout + forced.stderr, new RegExp(`force will discard dangling blob ${dangling}`));
});

test("worktree unsync inventories stash, notes, replace, and custom ref namespaces", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const checkout = join(cwd, "oms", "api", "main");
  const head = gitOut(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "stash.txt"), "stash\n");
  git(checkout, "add", "stash.txt");
  git(checkout, "stash", "push", "-m", "local stash");
  git(common, "notes", "add", "-m", "local note", head);
  git(common, "update-ref", "refs/custom/keep", head);
  const original = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: common,
    encoding: "utf8",
    input: "original\n",
    env: testEnv,
  }).trim();
  const replacement = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: common,
    encoding: "utf8",
    input: "replacement\n",
    env: testEnv,
  }).trim();
  git(common, "update-ref", `refs/replace/${original}`, replacement);

  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /stash refs\/stash commit [0-9a-f]{40}/);
  assert.match(output, /notes refs\/notes\/commits commit [0-9a-f]{40}/);
  assert.match(output, new RegExp(`replace refs/replace/${original} blob ${replacement}`));
  assert.match(output, new RegExp(`custom-ref refs/custom/keep commit ${head}`));
  assert.equal(existsSync(common), true);
});

test("worktree unsync reports ignored, nested-repository, and in-progress state", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  writeFileSync(join(checkout, ".gitignore"), "ignored.log\n");
  git(checkout, "add", ".gitignore");
  git(checkout, "commit", "-m", "chore: ignore local logs");
  git(checkout, "push", "origin", "main");
  writeFileSync(join(checkout, "ignored.log"), "ignored\n");
  const nested = join(checkout, "nested");
  mkdirSync(nested);
  git(nested, "init");
  const mergeHead = gitOut(checkout, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(isAbsolute(mergeHead) ? mergeHead : join(checkout, mergeHead), `${gitOut(checkout, "rev-parse", "HEAD")}\n`);

  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /ignored=1/);
  assert.match(output, /nested-repositories=1/);
  assert.match(output, /operation=merge/);
  assert.equal(existsSync(checkout), true);
});

test("worktree unsync protects and force-discloses an unpublished detached HEAD", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");
  git(checkout, "commit", "--allow-empty", "-m", "local detached commit");
  const oid = gitOut(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "--detach");
  git(join(cwd, ".oms", "repos", "api.git"), "branch", "-D", "main");

  const refused = run(["unsync", "api"], { cwd });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, new RegExp(`worktree-head api/main commit ${oid}`));

  const forced = run(["unsync", "api", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout + forced.stderr, new RegExp(`force will discard worktree-head api/main commit ${oid}`));
});

test("worktree unsync refuses ownership drift before deletion", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "config", "oms.workspaceId", "00000000-0000-4000-8000-000000000000");

  const result = run(["unsync", "api", "--force"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /ownership or shape does not match/);
  assert.equal(existsSync(common), true);
});

test("worktree unsync refuses a symlinked common-repository boundary even with force", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const relocated = `${common}.relocated`;
  renameSync(common, relocated);
  symlinkSync(relocated, common);

  const result = run(["unsync", "api", "--force"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /common repository path contains a symbolic link/);
  assert.equal(existsSync(relocated), true);
});

test("worktree unsync revalidation detects a concurrent direct Git commit", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const checkout = join(cwd, "oms", "api", "main");

  const result = run(["unsync", "api"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_MUTATE_AT: "unsync-before-worktree:api/main" },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Git or working-tree state changed after preflight/);
  assert.equal(existsSync(checkout), true);
});

test("multi-alias worktree unsync completes global preflight before deleting any alias", () => {
  const api = initBareUpstream();
  const web = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", api)}${sourceFor("web", web).replace(/^repos:\n/, "").replace(/^  /gm, "  ")}`);
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  writeFileSync(join(cwd, "oms", "web", "main", "dirty.txt"), "dirty\n");

  const result = run(["unsync", "--all"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no alias storage was deleted/);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), true);
});

test("external and locked worktrees block worktree unsync even with force", () => {
  const bare = initBareUpstream({ branches: ["main", "external"] });
  const externalCwd = tempWorkspace();
  writeSources(externalCwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd: externalCwd }).status, 0);
  const externalCommon = join(externalCwd, ".oms", "repos", "api.git");
  const external = tempWorkspace();
  git(externalCommon, "branch", "external", "refs/remotes/origin/external");
  git(externalCommon, "worktree", "add", external, "external");
  const externalResult = run(["unsync", "api", "--force"], { cwd: externalCwd });
  assert.equal(externalResult.status, 1, externalResult.stdout + externalResult.stderr);
  assert.match(externalResult.stdout + externalResult.stderr, /external or ownership-ambiguous worktree/);
  assert.equal(existsSync(externalCommon), true);

  const lockedCwd = tempWorkspace();
  writeSources(lockedCwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd: lockedCwd }).status, 0);
  const lockedCommon = join(lockedCwd, ".oms", "repos", "api.git");
  const lockedCheckout = join(lockedCwd, "oms", "api", "main");
  git(lockedCommon, "worktree", "lock", lockedCheckout);
  const lockedResult = run(["unsync", "api", "--force"], { cwd: lockedCwd });
  assert.equal(lockedResult.status, 1, lockedResult.stdout + lockedResult.stderr);
  assert.match(lockedResult.stdout + lockedResult.stderr, /is locked/);
  assert.equal(existsSync(lockedCommon), true);
});

test("worktree unsync requires fresh remote knowledge unless force accepts stale verification", () => {
  const bare = initBareUpstream();
  const unavailable = `${bare}.unavailable`;
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  renameSync(bare, unavailable);

  const refused = run(["unsync", "api"], { cwd });
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /fresh publication verification failed/);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);

  const forced = run(["unsync", "api", "--force"], { cwd });
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout + forced.stderr, /continuing with stale remote knowledge/);
});

test("explicit orphan unsync is safe while --all does not infer alias renames", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  writeSources(cwd, `mode: worktree\n${sourceFor("web", bare)}`);

  const all = run(["unsync", "--all"], { cwd });
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);

  const explicit = run(["unsync", "api"], { cwd });
  assert.equal(explicit.status, 0, explicit.stdout + explicit.stderr);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);
});

test("worktree unsync resumes after worktrees were removed but common deletion failed", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const failed = run(["unsync", "api"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: "unsync-common:api" },
  });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /worktrees removed \[api\/main\], but common repository was preserved/);
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);

  const retried = run(["unsync", "api"], { cwd });
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);
});

test("multi-alias worktree unsync reports completed and incomplete deletion phases", () => {
  const api = initBareUpstream();
  const web = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", api)}${sourceFor("web", web).replace(/^repos:\n/, "")}`);
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  const result = run(["unsync", "--all"], {
    cwd,
    env: { ...testEnv, OMS_TEST_MODE: "1", OMS_TEST_FAIL_AT: "unsync-common:api" },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Unsync completed: web; incomplete: api/);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), true);
  assert.equal(existsSync(join(cwd, "oms", "api", "main")), false);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "web.git")), false);

  const retried = run(["unsync", "api"], { cwd });
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(existsSync(join(cwd, ".oms", "repos", "api.git")), false);
});

test("worktree branch list is lock-free and does not refresh common refs", () => {
  const bare = initBareUpstream({ branches: ["main", "feature/login"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const external = tempWorkspace();
  git(common, "branch", "external", "refs/remotes/origin/feature/login");
  git(common, "worktree", "add", external, "external");
  const remoteBefore = gitOut(common, "rev-parse", "refs/remotes/origin/main");

  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["clone", bare, seed], { stdio: "ignore", env: testEnv });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "remote advance");
  git(seed, "push", "origin", "main");
  writeFileSync(join(cwd, ".oms-mutation.lock"), "occupied\n");

  const result = run(["branch", "list", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /main\s+[0-9a-f]+\s+api\/main/);
  const canonicalExternal = realpathSync(external);
  assert.match(result.stdout, new RegExp(`external\\s+[0-9a-f]+\\s+${canonicalExternal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.stdout, /origin\s+feature\/login/);
  assert.equal(gitOut(common, "rev-parse", "refs/remotes/origin/main"), remoteBefore);
  assert.equal(readFileSync(join(cwd, ".oms-mutation.lock"), "utf8"), "occupied\n");
});

test("worktree names reject non-portable and colliding slugs before mutation", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  for (const name of ["UPPER", "con", "bad/name", "a".repeat(65)]) {
    const result = run(["worktree", "add", "api", "dev", "--name", name], { cwd });
    assert.equal(result.status, 1, `${name}\n${result.stdout}${result.stderr}`);
  }
  const collision = run(["worktree", "add", "api", "dev", "--name", "main"], { cwd });
  assert.equal(collision.status, 1, collision.stdout + collision.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api", "dev")), false);
});
