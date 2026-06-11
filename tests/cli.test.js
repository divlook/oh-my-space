import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const cli = resolve("dist/oms.js");

const testEnv = {
  ...process.env,
  // Allow file-protocol clones, keep test commits unsigned, and provide a commit
  // identity so commits succeed even on hosts (CI) without a global git identity.
  // These are process-scoped (GIT_CONFIG_*), never written to disk.
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "user.email",
  GIT_CONFIG_VALUE_2: "test@example.com",
  GIT_CONFIG_KEY_3: "user.name",
  GIT_CONFIG_VALUE_3: "Test",
};

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: testEnv,
    ...options,
  });
}

function updateEnv(overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "0.9.1" } }),
    ...overrides,
  };
}

function installContext(kind, extra = {}) {
  return JSON.stringify({
    kind,
    label: `${kind} test install`,
    guidance: [`guidance for ${kind}`],
    warnings: [],
    ...extra,
  });
}

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "oms-test-"));
}

function writeSources(cwd, content) {
  writeFileSync(
    join(cwd, "oms.yaml"),
    content
      ?? "repos:\n  - alias: sample\n    remotes:\n      origin: git@example.com:org/repo.git\n    branch: main\n",
  );
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: testEnv });
}

function configIdentity(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
}

/**
 * Create a bare upstream + a seed repo that pushes branches into it.
 * Returns the bare repo path. Optionally creates additional branches.
 */
function initBareUpstream({ branches = ["main"] } = {}) {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore", env: testEnv });
  const seed = mkdtempSync(join(tmpdir(), "oms-seed-"));
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "ignore", env: testEnv });
  configIdentity(seed);
  git(seed, "commit", "--allow-empty", "-m", "init");
  for (const b of branches) {
    if (b === "main") continue;
    git(seed, "checkout", "-b", b);
    git(seed, "commit", "--allow-empty", "-m", `init-${b}`);
  }
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--all", "origin");
  return bare;
}

/** A git workspace (parent repo) with an initial commit — the host for submodules. */
function initGitWorkspace() {
  const cwd = tempWorkspace();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");
  return cwd;
}

function gitOut(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv }).trim();
}

/** An empty bare repo — a valid push target that shares no history with the seeded origin. */
function initEmptyBare() {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore", env: testEnv });
  return bare;
}

function sourceFor(alias, bare, branch = "main", extraRemotes = {}) {
  const remoteLines = [`      origin: file://${bare}`];
  for (const [name, url] of Object.entries(extraRemotes)) {
    remoteLines.push(`      ${name}: file://${url}`);
  }
  return `repos:\n  - alias: ${alias}\n    remotes:\n${remoteLines.join("\n")}\n    branch: ${branch}\n`;
}

// --- help / scaffolding / validation (no git operations) ---

test("help is exposed as oms with the submodule commands", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: oms/);
  assert.match(result.stdout, /\binit\b/);
  assert.match(result.stdout, /\bsync\b/);
  assert.match(result.stdout, /\bstatus\b/);
  assert.match(result.stdout, /\bswitch\b/);
  assert.match(result.stdout, /\bcheckout\b/);
  assert.match(result.stdout, /\bunsync\b/);
  assert.match(result.stdout, /\bupdate\b/);
  assert.doesNotMatch(result.stdout, /\bworktree\b/);
  assert.doesNotMatch(result.stdout, /\bmigrate\b/);
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

  // The gitlink is staged in the parent (visible, ready to commit).
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /\.gitmodules/);
  assert.match(staged, /oms\/probe/);

  // Submodules are tracked, so oms/ must not be gitignored.
  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
});

test("sync accepts aliases with underscore, dash, and at-sign", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const alias = "alfred_af-101@prod";
  writeSources(cwd, sourceFor(alias, bare));

  const result = run(["sync", alias], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  assert.equal(existsSync(join(cwd, "oms", alias, ".git")), true);

  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, new RegExp(`path = oms/${alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
});

test("sync rejects a missing branch via preflight and leaves no debris", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("probe", bare, "nonexistent"));

  const result = run(["sync", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /branch "nonexistent" not found/);
  assert.equal(existsSync(join(cwd, "oms", "probe")), false);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
});

test("switch creates a brand-new local branch without any remote precondition", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // feature/new exists neither locally nor on origin — switch must still succeed locally.
  const sw = run(["switch", "api", "feature/new"], { cwd });
  const output = sw.stdout + sw.stderr;
  assert.equal(sw.status, 0, output);
  assert.match(output, /created new local branch/);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "feature/new");

  // It is a real local branch, not pushed anywhere yet.
  const upstreamCheck = spawnSync(
    "git",
    ["-C", join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "feature/new@{u}"],
    { encoding: "utf8", env: testEnv },
  );
  assert.notEqual(upstreamCheck.status, 0);
});

test("switch onto an existing local branch just switches", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Bring dev down as a local branch via checkout, switch back to main, then switch to dev.
  assert.equal(run(["checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["switch", "api", "main"], { cwd }).status, 0);

  const sw = run(["switch", "api", "dev"], { cwd });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
});

test("checkout switches onto an existing remote branch with tracking", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const co = run(["checkout", "api", "dev"], { cwd });
  assert.equal(co.status, 0, co.stdout + co.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
    "origin/dev",
  );
});

test("checkout refuses a branch absent on origin and points at switch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // feature/new exists neither locally nor on origin — checkout is remote-only, so it must refuse.
  const co = run(["checkout", "api", "feature/new"], { cwd });
  const output = co.stdout + co.stderr;
  assert.equal(co.status, 1, output);
  assert.match(output, /not found on origin/);
  assert.match(output, /oms switch api feature\/new/);
});

test("switch and checkout error without hanging when args are omitted in a non-TTY", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // spawnSync gives a non-TTY stdin, so an omitted alias must fail fast rather than prompt.
  const noAlias = run(["switch"], { cwd });
  assert.equal(noAlias.status, 1, noAlias.stdout + noAlias.stderr);
  assert.match(noAlias.stdout + noAlias.stderr, /not a TTY/);

  // Alias given but branch omitted must also fail fast for both commands.
  const noBranchSwitch = run(["switch", "api"], { cwd });
  assert.equal(noBranchSwitch.status, 1, noBranchSwitch.stdout + noBranchSwitch.stderr);
  assert.match(noBranchSwitch.stdout + noBranchSwitch.stderr, /not a TTY/);

  const noBranchCheckout = run(["checkout", "api"], { cwd });
  assert.equal(noBranchCheckout.status, 1, noBranchCheckout.stdout + noBranchCheckout.stderr);
  assert.match(noBranchCheckout.stdout + noBranchCheckout.stderr, /not a TTY/);
});

test("push lazily creates the remote branch and stages the moved pointer", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  // Commit the initial pointer so we can observe the later move cleanly.
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  // New local branch + a commit, then push (the remote branch does not exist yet).
  assert.equal(run(["switch", "api", "feature/x"], { cwd }).status, 0);
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "new.txt"), "hi");
  git(wt, "add", "new.txt");
  git(wt, "commit", "-m", "work");
  const localSha = gitOut(wt, "rev-parse", "HEAD");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pushed/);

  // The remote branch was created on first push.
  const upstreamSha = gitOut(bare, "rev-parse", "refs/heads/feature/x");
  assert.equal(upstreamSha, localSha);

  // The parent has the moved pointer staged.
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/api/);
});

test("push --commit records the pointer in the parent repo", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-m", "work");

  const result = run(["push", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // A new parent commit exists and the working tree is clean of the pointer change.
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /bump api/);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("push fails clearly when the submodule is on a detached HEAD", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(join(cwd, "oms", "api"), "checkout", "--detach");

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /detached HEAD/);
});

test("fetch updates origin refs inside the submodule", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["fetch", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /fetched/);
});

test("pull --ff-only succeeds on the submodule's branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pulled/);
});

test("status reports branch, pin state, and dirtiness", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  let result = run(["status"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALIAS\s+BRANCH\s+PIN/);
  assert.match(result.stdout, /api\s+main\s+ok/);

  // A dirty working tree shows up in the DIRTY column.
  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  result = run(["status", "api"], { cwd });
  assert.match(result.stdout, /api\s+main\s+\S+\s+yes/);
});

test("unsync removes the submodule, keeps oms.yaml, and re-sync works", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  const unsynced = run(["unsync", "api"], { cwd });
  assert.equal(unsynced.status, 0, unsynced.stdout + unsynced.stderr);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  // .gitmodules no longer registers oms/api (and is dropped when empty).
  if (existsSync(join(cwd, ".gitmodules"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api/);
  }
  assert.match(readFileSync(join(cwd, "oms.yaml"), "utf8"), /alias: api/);

  const resynced = run(["sync", "api"], { cwd });
  assert.equal(resynced.status, 0, resynced.stdout + resynced.stderr);
  assert.ok(existsSync(join(cwd, "oms", "api", ".git")));
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "main");
});

/** A multi-repo oms.yaml mapping each alias to its own bare origin. */
function sourcesFor(entries) {
  const body = entries
    .map(({ alias, bare }) => `  - alias: ${alias}\n    remotes:\n      origin: file://${bare}\n    branch: main`)
    .join("\n");
  return `repos:\n${body}\n`;
}

/** Count submodule.*.path entries remaining in .gitmodules (0 when the file is gone). */
function gitmodulesSectionCount(cwd) {
  const path = join(cwd, ".gitmodules");
  if (!existsSync(path)) return 0;
  const r = spawnSync("git", ["config", "--file", path, "--get-regexp", "^submodule\\..*\\.path$"], {
    encoding: "utf8",
    env: testEnv,
  });
  if (r.status !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

test("unsync of all aliases leaves no orphan .gitmodules section", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  const result = run(["unsync", "api", "web", "docs"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitmodulesSectionCount(cwd), 0, "no submodule section should remain");
  assert.equal(existsSync(join(cwd, ".gitmodules")), false, ".gitmodules should be removed");
  assert.equal(existsSync(join(cwd, ".git", "modules", "oms")), false, ".git/modules/oms should be gone");
});

test("a dirty submodule among several is surfaced and only it remains", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  // An untracked file (e.g. .DS_Store) makes web dirty, so it must be protected, not deleted.
  writeFileSync(join(cwd, "oms", "web", ".DS_Store"), "x");

  const result = run(["unsync", "api", "web", "docs"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  // The failed alias is named explicitly so it isn't lost among the successes.
  assert.match(output, /Not unsynced:.*web/);
  // web is preserved; api and docs are fully cleaned up.
  assert.equal(existsSync(join(cwd, "oms", "web")), true);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  assert.equal(existsSync(join(cwd, "oms", "docs")), false);
  assert.equal(gitmodulesSectionCount(cwd), 1, "only web's section should remain");
  assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/web/);
  assert.doesNotMatch(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api|oms\/docs/);
});

test("a committed pointer reproduces on a fresh clone via sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");
  const pin = gitOut(cwd, "rev-parse", `:oms/api`);

  // Clone the parent elsewhere; the submodule is registered but not yet initialized.
  const clone = mkdtempSync(join(tmpdir(), "oms-clone-"));
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  assert.equal(existsSync(join(clone, "oms", "api", ".git")), false);

  const result = run(["sync", "api"], { cwd: clone });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(clone, "oms", "api"), "rev-parse", "HEAD"), pin);
  assert.equal(gitOut(join(clone, "oms", "api"), "branch", "--show-current"), "main");
});

// --- legacy guards ---

test("legacy bare clone (oms/<alias>/.bare) blocks sync with the 0.6.0 migration hint", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  mkdirSync(join(cwd, "oms", "api", ".bare"), { recursive: true });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /legacy bare clone/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.5\.x-to-0\.6\.0\.md/,
  );
});

test("legacy sources.yaml without oms.yaml is blocked with migration hint", () => {
  const cwd = initGitWorkspace();
  writeFileSync(
    join(cwd, "sources.yaml"),
    "repos:\n  - alias: sample\n    url: git@example.com:org/repo.git\n    branch: main\n",
  );

  const result = run(["sync", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detected legacy 'sources\.yaml'/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.3\.x-to-0\.4\.0\.md/,
  );
});

test("legacy sources/ directory inside an oms.yaml workspace is blocked", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  mkdirSync(join(cwd, "sources"));

  const result = run(["sync", "--list"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detected legacy 'sources\/'/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.3\.x-to-0\.4\.0\.md/,
  );
});

test("unrelated sources/ directory above the workspace does not block oms", () => {
  const parent = tempWorkspace();
  mkdirSync(join(parent, "sources"));
  const child = join(parent, "child");
  mkdirSync(child);
  execFileSync("git", ["init", "-b", "main", child], { stdio: "ignore", env: testEnv });
  writeSources(child);

  const result = run(["sync", "--list"], { cwd: child });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /sample/);
});

// --- doctor ---

test("doctor reports workspace, manifest count, git, and warns when not a git repo", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /Workspace root:/);
  assert.match(output, /oms\.yaml: 1 repo\(s\) configured/);
  assert.match(output, /git:/);
  assert.match(output, /not a git repository/);
});

test("doctor reports a healthy submodule after sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api: submodule OK \(branch=main\)/);
});

test("doctor warns when .gitignore still excludes oms/", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, ".gitignore"), "oms/\n");

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /\.gitignore excludes oms\//);
});

test("doctor warns when git is older than the recommended 2.40", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "git version 2.30.0"; exit 0; fi\nexec ${realGit} "$@"\n`,
  );
  execFileSync("chmod", ["+x", stubGit]);

  const result = run(["doctor"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /git 2\.30 is older than the recommended 2\.40/);
});

// --- multiple remotes ---

test("sync configures every declared remote on the submodule", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));

  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const remotes = gitOut(join(cwd, "oms", "api"), "remote").split("\n");
  assert.ok(remotes.includes("origin"), `origin missing: ${remotes}`);
  assert.ok(remotes.includes("upstream"), `upstream missing: ${remotes}`);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "remote", "get-url", "upstream"),
    `file://${upstream}`,
  );
});

test("re-syncing adds a remote declared after the initial sync", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();

  writeSources(cwd, sourceFor("api", origin));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.ok(!gitOut(join(cwd, "oms", "api"), "remote").split("\n").includes("upstream"));

  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.ok(gitOut(join(cwd, "oms", "api"), "remote").split("\n").includes("upstream"));
});

test("push --remote targets the chosen remote and keeps origin as upstream", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // Advance the submodule so the push has something to deliver.
  writeFileSync(join(cwd, "oms", "api", "feature.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "feature");
  const head = gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD");

  const result = run(["push", "api", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  // upstream received main; origin did not, and main still tracks origin/main.
  assert.equal(gitOut(upstream, "rev-parse", "main"), head);
  assert.equal(
    gitOut(join(cwd, "oms", "api"), "rev-parse", "--abbrev-ref", "main@{u}"),
    "origin/main",
  );
});

test("fetch --remote accepts multiple remotes", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["fetch", "api", "--remote", "origin", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /fetched \(origin, upstream\)/);
});

test("push --remote with an unknown remote fails for that repo", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["push", "api", "--remote", "nope"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /unknown remote\(s\): nope/);
});

test("pull rejects more than one --remote", () => {
  const origin = initBareUpstream();
  const upstream = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { upstream }));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["pull", "api", "--remote", "origin", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /pull targets a single remote/);
});

test("an unknown remote fails only its repo and others still push", () => {
  const originA = initBareUpstream();
  const originB = initBareUpstream();
  const upstreamB = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `${sourceFor("a", originA).trimEnd()}\n  - alias: b\n    remotes:\n      origin: file://${originB}\n      upstream: file://${upstreamB}\n    branch: main\n`,
  );
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);

  // Give b a commit so its upstream push delivers something.
  writeFileSync(join(cwd, "oms", "b", "f.txt"), "x");
  git(join(cwd, "oms", "b"), "add", "-A");
  git(join(cwd, "oms", "b"), "commit", "-m", "b feature");
  const headB = gitOut(join(cwd, "oms", "b"), "rev-parse", "HEAD");

  // a lacks "upstream" → a fails; b has it → b pushes.
  const result = run(["push", "a", "b", "--remote", "upstream"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /a: unknown remote\(s\): upstream/);
  assert.equal(gitOut(upstreamB, "rev-parse", "main"), headB);
});

test("oms.yaml without an origin remote is rejected", () => {
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: api\n    remotes:\n      upstream: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /must include an "origin" entry/);
});

test("legacy url key points to the 0.7.0 migration doc", () => {
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    "repos:\n  - alias: api\n    url: git@example.com:org/repo.git\n",
  );

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /url is no longer supported/);
  assert.match(
    output,
    /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.6\.x-to-0\.7\.0\.md/,
  );
});

// --- self update ---

test("update --check reports up to date without detecting install context", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "0.9.0" } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /up to date/i);
  assert.doesNotMatch(output, /Detected context/);
});

test("update --check reports update availability and global command", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global npm install",
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Current version: 0\.9\.0/);
  assert.match(output, /Latest version: 0\.9\.1/);
  assert.match(output, /Update available/);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /Selected command: npm install -g oh-my-space@latest/);
});

test("update fails cleanly when registry latest is unavailable", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": {} }) }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /missing dist-tags\.latest/);
  assert.doesNotMatch(output, /Selected command/);
});

test("update treats invalid registry semver as a failure", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "not-semver" } }) }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not valid semver/);
});

test("update treats current newer than registry latest as non-mutating success", () => {
  const result = run(["update"], {
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "0.8.0" } }) }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /newer than the npm registry latest/);
  assert.doesNotMatch(output, /Detected context/);
});

test("update detects global npm context from runtime evidence", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "lib", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(prefix, "bin", "oms");
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: pathBin,
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update detects global npm context when PATH shim realpath points into package", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "lib", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(prefix, "bin", "oms");
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: runningBin,
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update detects Windows npm global context from runtime evidence", () => {
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space",
        realPackageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space",
        runningBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space\\dist\\oms.js",
        realRunningBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\oh-my-space\\dist\\oms.js",
        pathBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\oms.cmd",
        realPathBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\oms.cmd",
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update resolves Windows npm global shim extensions from PATH", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "node_modules", "oh-my-space");
  const modulePath = join(packageRoot, "dist", "oms.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "oh-my-space" }));
  writeFileSync(modulePath, "");
  writeFileSync(join(prefix, "oms.cmd"), "");

  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_PLATFORM: "win32",
      OMS_TEST_MODULE_PATH: modulePath,
      OMS_TEST_ARGV1: modulePath,
      PATH: `${prefix}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`,
      PATHEXT: ".CMD;.PS1;.EXE",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /npm install -g oh-my-space@latest/);
});

test("update does not treat project lib node_modules as global npm", () => {
  const project = tempWorkspace();
  const packageRoot = join(project, "lib", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(project, "node_modules", ".bin", "oms");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { "oh-my-space": "0.9.0" } }));

  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: pathBin,
        packageName: "oh-my-space",
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: project-local install/);
  assert.match(output, /Automatic update is only supported/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update does not treat project paths containing pnpm global tokens as global", () => {
  const project = join(tempWorkspace(), "pnpm", "global", "app");
  const packageRoot = join(project, "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(project, "node_modules", ".bin", "oms");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ devDependencies: { "oh-my-space": "0.9.0" } }));

  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: runningBin,
        packageName: "oh-my-space",
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: project-local install/);
  assert.match(output, /Automatic update is only supported/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update detects pnpm global context only with matching global shim", () => {
  const prefix = tempWorkspace();
  const packageRoot = join(prefix, "global", "5", "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const pathBin = join(prefix, "oms");
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin,
        realPathBin: runningBin,
        packageName: "oh-my-space",
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: global pnpm install/);
  assert.match(output, /pnpm add -g oh-my-space@latest/);
});

test("update reports non-mutating contexts with guidance", () => {
  for (const kind of ["project", "ephemeral", "development", "unknown"]) {
    const result = run(["update", "--yes"], {
      env: updateEnv({ OMS_TEST_INSTALL_CONTEXT: installContext(kind) }),
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, new RegExp(`${kind} test install`));
    assert.match(output, /Automatic update is only supported/);
    assert.match(output, new RegExp(`guidance for ${kind}`));
  }
});

test("update --yes runs a confident global command and warns on verification mismatch", () => {
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global pnpm install",
        updateCommand: { executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
      OMS_TEST_VERIFY_VERSION: "0.9.0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Selected command: pnpm add -g oh-my-space@latest/);
  assert.match(output, /Post-update verification saw 0\.9\.0, expected 0\.9\.1/);
  assert.match(output, /Update command completed/);
});

test("update without --yes in non-interactive mode does not mutate", () => {
  const result = run(["update"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "bun", args: ["add", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Re-run with --yes/);
  assert.doesNotMatch(output, /Update command completed/);
});

test("update without --yes in non-interactive mode does not require manager availability", () => {
  const result = run(["update"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "0",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Re-run with --yes/);
  assert.doesNotMatch(output, /not executable from PATH/);
});

test("update normalizes package-manager failure to exit 1", () => {
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "yarn", args: ["global", "add", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "7",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /Package manager update failed \(exit 7\)/);
});

test("update fails before mutation when detected manager is unavailable", () => {
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "0",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not executable from PATH/);
  assert.doesNotMatch(output, /Update command completed/);
});
