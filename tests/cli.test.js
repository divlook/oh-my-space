import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import semver from "semver";
import { parse as parseYaml } from "yaml";

const cli = resolve("dist/oms.js");
const publishBetaScript = resolve("scripts/publish-beta.mjs");

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

// Read the version under test so release bumps do not invalidate these fixtures.
const currentVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
// A registry latest strictly newer than the installed version.
const newerVersion = semver.inc(currentVersion, "patch");

// Escapes dots so embedded version strings match literally.
function versionPattern(text) {
  return new RegExp(text.replaceAll(".", "\\."));
}

function updateEnv(overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: newerVersion } }),
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

function gitTopLevelStubEnv(mode) {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  const response = mode === "failure"
    ? 'echo "simulated top-level inspection failure" >&2; exit 2'
    : mode === "localized-no-work-tree"
      ? 'if [ "$LC_ALL" = "C" ]; then echo "fatal: not a git repository" >&2; else echo "localized diagnostic" >&2; fi; exit 128'
      : 'echo "/path/that/does/not/exist"; exit 0';
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then ${response}; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);
  return { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` };
}

// --- help / scaffolding / validation (no git operations) ---

test("help is exposed as oms with the submodule commands", () => {
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
  assert.doesNotMatch(result.stdout, /\bworktree\b/);
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

const sharedPreflightCommands = [
  ["status"],
  ["commit", "sample", "-m", "test"],
  ["record", "sample"],
  ["branch", "switch", "sample", "main"],
  ["branch", "checkout", "sample", "main"],
  ["branch", "list", "sample"],
  ["branch", "delete", "sample", "feature"],
  ["fetch", "sample"],
  ["pull", "sample"],
  ["push", "sample"],
  ["unsync", "sample"],
];

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
  const sw = run(["branch", "switch", "api", "feature/new"], { cwd });
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
  assert.equal(run(["branch", "checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["branch", "switch", "api", "main"], { cwd }).status, 0);

  const sw = run(["branch", "switch", "api", "dev"], { cwd });
  assert.equal(sw.status, 0, sw.stdout + sw.stderr);
  assert.equal(gitOut(join(cwd, "oms", "api"), "branch", "--show-current"), "dev");
});

test("checkout switches onto an existing remote branch with tracking", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const co = run(["branch", "checkout", "api", "dev"], { cwd });
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
  const co = run(["branch", "checkout", "api", "feature/new"], { cwd });
  const output = co.stdout + co.stderr;
  assert.equal(co.status, 1, output);
  assert.match(output, /not found on origin/);
  assert.match(output, /oms branch switch api feature\/new/);
});

test("switch and checkout error without hanging when args are omitted in a non-TTY", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  // spawnSync gives a non-TTY stdin, so an omitted alias must fail fast rather than prompt.
  const noAlias = run(["branch", "switch"], { cwd });
  assert.equal(noAlias.status, 1, noAlias.stdout + noAlias.stderr);
  assert.match(noAlias.stdout + noAlias.stderr, /not a TTY/);

  // Alias given but branch omitted must also fail fast for both commands.
  const noBranchSwitch = run(["branch", "switch", "api"], { cwd });
  assert.equal(noBranchSwitch.status, 1, noBranchSwitch.stdout + noBranchSwitch.stderr);
  assert.match(noBranchSwitch.stdout + noBranchSwitch.stderr, /not a TTY/);

  const noBranchCheckout = run(["branch", "checkout", "api"], { cwd });
  assert.equal(noBranchCheckout.status, 1, noBranchCheckout.stdout + noBranchCheckout.stderr);
  assert.match(noBranchCheckout.stdout + noBranchCheckout.stderr, /not a TTY/);
});

test("push lazily creates the remote branch without staging the root pointer", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  // Commit the initial pointer so we can observe the later move cleanly.
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api");

  // New local branch + a commit, then push (the remote branch does not exist yet).
  assert.equal(run(["branch", "switch", "api", "feature/x"], { cwd }).status, 0);
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

  // Push never stages the root gitlink; it prints a record hint for the moved pointer instead.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(output, /oms record api/);
});

test("push --commit is unsupported and fails before pushing", () => {
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
  const localSha = gitOut(wt, "rev-parse", "HEAD");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["push", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  // Usage/config error, migration guidance, no push, no root pointer commit.
  assert.equal(result.status, 1, output);
  assert.match(output, /not supported/);
  assert.match(output, /oms record api/);
  assert.notEqual(gitOut(bare, "rev-parse", "main"), localSha); // nothing pushed
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore); // no root commit
});

test("push --record is unsupported and fails before pushing", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const result = run(["push", "api", "--record"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not supported/);
  assert.match(output, /oms record api/);
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
  // Record the gitlink so the root HEAD has a pointer; otherwise the pin is `missing` (pending add).
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");

  let result = run(["status"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALIAS\s+BRANCH\s+PIN/);
  assert.match(result.stdout, /api\s+main\s+ok/);

  // A dirty working tree shows up in the DIRTY column.
  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  result = run(["status", "api"], { cwd });
  assert.match(result.stdout, /api\s+main\s+\S+\s+yes/);
});

// --- status --json (machine-readable workspace state) ---

/** A workspace with `api` synced and its initial gitlink recorded in the root HEAD. */
function workspaceWithApi() {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");
  return { cwd, bare, wt: join(cwd, "oms", "api") };
}

/** Parse the JSON object a `status --json` run wrote to stdout, asserting a clean exit. */
function statusJson(cwd, args = [], expectStatus = 0) {
  const result = run(["status", "--json", ...args], { cwd });
  assert.equal(result.status, expectStatus, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

test("status --json emits one pretty JSON object on stdout with the stable top-level shape", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "--json"], { cwd });
  assert.equal(result.status, 0, result.stderr);

  // Pure JSON: starts with `{`, two-space indented, single trailing newline, no diagnostics.
  assert.ok(result.stdout.startsWith("{"));
  assert.match(result.stdout, /\n  "schemaVersion": 1,/);
  assert.ok(result.stdout.endsWith("}\n"));

  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(typeof data.toolVersion, "string");
  assert.equal(data.workspaceRoot, realpathSync(cwd));
  assert.ok(isAbsolute(data.workspaceRoot));
  assert.equal(data.currentAlias, null);
  assert.ok(Array.isArray(data.errors));
  assert.deepEqual(data.errors, []);
  assert.ok(data.root && typeof data.root === "object");

  const repo = data.repos[0];
  assert.equal(repo.alias, "api");
  assert.equal(repo.path, "oms/api"); // POSIX, workspace-relative
  assert.equal(repo.absolutePath, join(realpathSync(cwd), "oms", "api"));
  assert.equal(repo.configured, true);
  assert.equal(repo.initialized, true);
  assert.equal(repo.pin, "ok");
  assert.equal(repo.error, null);
});

test("status --json reports currentAlias when run inside a configured submodule subtree", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(statusJson(cwd).currentAlias, null);
  assert.equal(statusJson(join(cwd, "oms", "api")).currentAlias, "api");
});

test("status --json current alias inference respects path segment boundaries", () => {
  const { cwd } = workspaceWithApi();
  // oms/api-extra shares a string prefix with alias `api` but is a different segment.
  mkdirSync(join(cwd, "oms", "api-extra"), { recursive: true });
  assert.equal(statusJson(join(cwd, "oms", "api-extra")).currentAlias, null);
});

test("status --json keeps its schema and path representation through a symlinked cwd", () => {
  const { cwd } = workspaceWithApi();
  const linkParent = tempWorkspace();
  const linked = join(linkParent, "workspace");
  symlinkSync(cwd, linked);

  const data = statusJson(linked);
  assert.deepEqual(Object.keys(data).sort(), [
    "currentAlias",
    "errors",
    "repos",
    "root",
    "schemaVersion",
    "toolVersion",
    "workspaceRoot",
  ]);
  assert.equal(data.workspaceRoot, realpathSync(cwd));
});

test("status --json represents a detached submodule HEAD explicitly", () => {
  const { cwd } = workspaceWithApi();
  git(join(cwd, "oms", "api"), "checkout", "--detach");
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.branch, null);
  assert.equal(repo.detached, true);
  assert.match(repo.head, /^[0-9a-f]+$/);
});

test("status --json reports a missing tracking branch as null divergence", () => {
  const { cwd } = workspaceWithApi();
  // A brand-new local branch has no upstream.
  assert.equal(run(["branch", "switch", "api", "feature/x"], { cwd }).status, 0);
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.trackingBranch, null);
  assert.equal(repo.ahead, null);
  assert.equal(repo.behind, null);
});

test("status --json reports numeric ahead/behind against a tracking branch", () => {
  const { cwd } = workspaceWithApi();
  // main tracks origin/main; one local commit puts it exactly one ahead, zero behind.
  writeFileSync(join(cwd, "oms", "api", "ahead.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "local work");
  const repo = statusJson(cwd).repos[0];
  assert.strictEqual(repo.ahead, 1);
  assert.strictEqual(repo.behind, 0);
});

test("status --json marks a never-synced configured alias as missing, not uninit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const repo = statusJson(cwd).repos[0];
  assert.equal(repo.initialized, false);
  assert.equal(repo.pin, "missing");
  assert.equal(repo.head, null);
  assert.equal(repo.error, null);
});

test("status --json keeps a recorded-but-uninitialized repo in inventory as uninit", () => {
  const { cwd } = workspaceWithApi();
  const clone = mkdtempSync(join(tmpdir(), "oms-clone-"));
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  // The submodule is registered in HEAD but not initialized in the fresh clone.
  const repo = statusJson(clone).repos[0];
  assert.equal(repo.initialized, false);
  assert.equal(repo.pin, "uninit");
  assert.equal(repo.branch, null);
  assert.equal(repo.ahead, null);
});

test("status --json separates root changes from submodule source changes and pointer moves", () => {
  const { cwd } = workspaceWithApi();
  // An unrelated untracked root file is a root change.
  writeFileSync(join(cwd, "NOTES.md"), "hi");
  // A submodule source commit moves the pointer; an extra dirty file lives inside the submodule.
  writeFileSync(join(cwd, "oms", "api", "feature.txt"), "x");
  git(join(cwd, "oms", "api"), "add", "-A");
  git(join(cwd, "oms", "api"), "commit", "-m", "feature");
  writeFileSync(join(cwd, "oms", "api", "scratch.txt"), "y");

  const data = statusJson(cwd);
  // Root counts only the unrelated file, never the moved oms/api gitlink.
  assert.equal(data.root.changes.untracked, 1);
  assert.equal(data.root.changes.staged, 0);
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  // Submodule source changes are authoritative in the repo entry.
  assert.equal(data.repos[0].changes.untracked, 1);
  assert.equal(data.repos[0].dirty, true);
});

test("status --json narrows repos and pointer arrays to the selected aliases", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  // Move both pointers.
  for (const alias of ["api", "web"]) {
    writeFileSync(join(cwd, "oms", alias, "f.txt"), "x");
    git(join(cwd, "oms", alias), "add", "-A");
    git(join(cwd, "oms", alias), "commit", "-m", "work");
  }

  const data = statusJson(cwd, ["api"]);
  assert.equal(data.repos.length, 1);
  assert.equal(data.repos[0].alias, "api");
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  // Root status and currentAlias remain present even when filtered.
  assert.ok(data.root.branch);
  assert.equal(data.currentAlias, null);
});

test("status --json exposes staged and split root pointer states", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  // c1: commit in the submodule and stage the gitlink (index ahead of HEAD).
  writeFileSync(join(wt, "c1.txt"), "1");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c1");
  git(cwd, "add", "oms/api");
  let data = statusJson(cwd);
  assert.deepEqual(data.root.submodulePointers.staged, ["api"]);
  assert.deepEqual(data.root.submodulePointers.moved, ["api"]);
  assert.deepEqual(data.root.submodulePointers.split, []);

  // c2: advance the submodule again so worktree != index != HEAD → split.
  writeFileSync(join(wt, "c2.txt"), "2");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c2");
  data = statusJson(cwd);
  assert.deepEqual(data.root.submodulePointers.split, ["api"]);
  assert.deepEqual(data.root.submodulePointers.staged, ["api"]);
});

test("status represents a conflicted root gitlink as conflict and still exits 0 for --json", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  const base = gitOut(wt, "rev-parse", "HEAD");

  // Root branch `x` records pointer B.
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");

  // Back on main, reset the submodule to base and record a divergent pointer C.
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");

  // Merging the divergent pointer leaves a conflicted gitlink in the root index.
  const m = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(m.status, 0, "merge should conflict on the gitlink");

  const data = statusJson(cwd); // exits 0 despite the conflict
  assert.equal(data.repos[0].pin, "conflict");
  assert.deepEqual(data.root.submodulePointers.conflict, ["api"]);

  // The human-readable table also shows the conflict pin.
  const table = run(["status"], { cwd });
  assert.match(table.stdout, /api\s+\S*\s*conflict/);
});

test("status --json fails before emitting JSON for an unknown alias", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["status", "missing-alias", "--json"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown alias/);
});

test("status --json keeps valid JSON and exits non-zero when a repo read fails", () => {
  const { cwd } = workspaceWithApi();
  // Remove the submodule's real gitdir so its HEAD cannot be read, while the .git pointer file remains.
  rmSync(join(cwd, ".git", "modules", "oms", "api"), { recursive: true, force: true });

  const result = run(["status", "--json"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const data = JSON.parse(result.stdout); // stdout stays valid JSON
  const repo = data.repos[0];
  assert.equal(typeof repo.error, "string");
  assert.equal(repo.head, null);
  // Structured fields keep their normal shape with safe defaults.
  assert.deepEqual(repo.changes, { staged: 0, unstaged: 0, untracked: 0 });
  assert.equal(data.errors.length, 1);
});

// --- oms commit (submodule source commits only) ---

test("commit stages all submodule changes when nothing is staged and leaves the root untouched", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "new.txt"), "hi");

  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
  const result = run(["commit", "api", "-m", "feat: add login flow"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  // A submodule commit was created.
  assert.equal(gitOut(wt, "log", "-1", "--pretty=%s"), "feat: add login flow");
  assert.match(output, /committed [0-9a-f]+/);
  // The root received no commit and nothing is staged; only the working-tree gitlink moved.
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "status", "--porcelain"), /oms\/api/);
  // The follow-up hint points at record.
  assert.match(output, /oms record api/);
});

test("commit respects an existing submodule index and warns about leftovers", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "staged.txt"), "a");
  writeFileSync(join(wt, "left.txt"), "b");
  git(wt, "add", "staged.txt"); // only one file staged

  const result = run(["commit", "api", "-m", "feat: only staged"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  // Only the staged file landed in the commit.
  const files = gitOut(wt, "show", "--name-only", "--pretty=format:", "HEAD").trim();
  assert.match(files, /staged\.txt/);
  assert.doesNotMatch(files, /left\.txt/);
  // The leftover remains and the user is warned.
  assert.match(gitOut(wt, "status", "--porcelain"), /left\.txt/);
  assert.match(output, /unstaged or untracked changes remain/);
});

test("commit passes multiple -m paragraphs through to the submodule commit", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");

  const result = run(["commit", "api", "-m", "feat: add login", "-m", "Add callback handling."], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = gitOut(wt, "log", "-1", "--pretty=%B");
  assert.match(body, /feat: add login/);
  assert.match(body, /Add callback handling\./);
});

test("commit without -m fails for a dirty submodule and is a no-op for a clean one", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");

  // Clean submodule: no -m needed, reports nothing to commit, exits 0.
  let result = run(["commit", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Nothing to commit for api/);

  // Dirty submodule without -m fails without opening an editor.
  writeFileSync(join(wt, "f.txt"), "x");
  result = run(["commit", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /-m is required/);
});

test("commit no-op prints a record hint when the pointer already moved", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  // Move the pointer with a raw git commit so oms commit sees no new changes.
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "raw work");

  const result = run(["commit", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Nothing to commit for api/);
  assert.match(output, /oms record api/);
});

test("commit prints a topology hint instead of record when the root gitlink is unrecorded", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  // Deliberately do NOT record the gitlink in the root HEAD (pending add topology).
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");

  const result = run(["commit", "api", "-m", "feat: work"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /oms sync api --commit/);
  assert.doesNotMatch(output, /oms record api/);
});

test("commit rejects a detached submodule HEAD without touching the root", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  git(wt, "checkout", "--detach");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["commit", "api", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit rejects an in-progress merge inside the submodule", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "conflict.txt"), "base\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "base");
  git(wt, "checkout", "-b", "other");
  writeFileSync(join(wt, "conflict.txt"), "other\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "other");
  git(wt, "checkout", "main");
  writeFileSync(join(wt, "conflict.txt"), "main\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd: wt, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
  const result = run(["commit", "api", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /merge is in progress/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit infers the alias from the current submodule directory", () => {
  const { cwd } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");

  // No alias argument: inferred from cwd being inside oms/api.
  const result = run(["commit", "-m", "feat: inferred"], { cwd: wt });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "log", "-1", "--pretty=%s"), "feat: inferred");
});

test("commit gives an explicit alias precedence over the current submodule context", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(
    cwd,
    `repos:\n  - alias: api\n    remotes:\n      origin: file://${bare}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${bare}\n    branch: main\n`,
  );
  assert.equal(run(["sync", "api", "web"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  writeFileSync(join(cwd, "oms", "web", "web.txt"), "web");

  const result = run(["commit", "web", "-m", "feat: explicit web"], {
    cwd: join(cwd, "oms", "api"),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(join(cwd, "oms", "web"), "log", "-1", "--pretty=%s"), "feat: explicit web");
  assert.notEqual(gitOut(join(cwd, "oms", "api"), "log", "-1", "--pretty=%s"), "feat: explicit web");
});

test("commit infers the alias before preconditions and fails when uninitialized", () => {
  const { cwd } = workspaceWithApi();
  const clone = mkdtempSync(join(tmpdir(), "oms-clone-"));
  execFileSync("git", ["clone", cwd, clone], { stdio: "ignore", env: testEnv });
  configIdentity(clone);
  // oms/api exists as an uninitialized submodule directory in the fresh clone.
  const result = run(["commit", "-m", "x"], { cwd: join(clone, "oms", "api") });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not initialized/);
  assert.match(output, /oms sync api/);
});

test("commit without an alias outside any submodule fails in a non-TTY shell", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["commit", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /alias/i);
  assert.match(output, /not a TTY/);
});

// --- oms record (root gitlink pointer commits only) ---

/** A workspace with `api` recorded, then advanced by one submodule commit (pointer moved, unrecorded). */
function workspaceWithMovedApi() {
  const { cwd, bare } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  return { cwd, bare, wt };
}

test("record commits only the moved gitlink with a conventional message", () => {
  const { cwd, wt } = workspaceWithMovedApi();
  const sha = gitOut(wt, "rev-parse", "--short", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), `chore(oms): update api submodule to ${sha}`);
  assert.match(output, new RegExp(`chore\\(oms\\): update api submodule to ${sha}`));
  // Only oms/api was committed and the working tree is clean of the pointer move.
  assert.equal(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD").trim(), "oms/api");
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("record is a no-op without pointer movement and does not warn for dirty source", () => {
  const { cwd } = workspaceWithApi();
  // Uncommitted source change but no pointer movement.
  writeFileSync(join(cwd, "oms", "api", "dirty.txt"), "x");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Nothing to record for api/);
  assert.doesNotMatch(output, /uncommitted source/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("record warns about a dirty submodule but still records the current HEAD", () => {
  const { cwd, wt } = workspaceWithMovedApi();
  writeFileSync(join(wt, "extra.txt"), "uncommitted");
  const sha = gitOut(wt, "rev-parse", "--short", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /only the current HEAD pointer will be recorded/);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), `chore(oms): update api submodule to ${sha}`);
});

test("record rejects unrelated staged root changes", () => {
  const { cwd } = workspaceWithMovedApi();
  writeFileSync(join(cwd, "root.txt"), "x");
  git(cwd, "add", "root.txt");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /unrelated staged changes/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("record allows unrelated unstaged root changes and stays path-limited", () => {
  const { cwd } = workspaceWithMovedApi();
  writeFileSync(join(cwd, "root.txt"), "x"); // unrelated, unstaged

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Only oms/api was committed; the unrelated file is still uncommitted.
  assert.equal(gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD").trim(), "oms/api");
  assert.match(gitOut(cwd, "status", "--porcelain"), /root\.txt/);
});

test("record allows an already-staged selected gitlink that matches the working tree", () => {
  const { cwd } = workspaceWithMovedApi();
  git(cwd, "add", "oms/api"); // pre-stage the selected gitlink

  const result = run(["record", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(gitOut(cwd, "log", "-1", "--pretty=%s"), /update api submodule/);
});

test("record rejects a staged gitlink for a different alias", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  // Move both pointers, then stage only web's gitlink.
  for (const alias of ["api", "web"]) {
    writeFileSync(join(cwd, "oms", alias, "f.txt"), "x");
    git(join(cwd, "oms", alias), "add", "-A");
    git(join(cwd, "oms", alias), "commit", "-m", "work");
  }
  git(cwd, "add", "oms/web");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /unrelated staged changes.*oms\/web/);
});

test("record rejects a staged/worktree pointer split", () => {
  const { cwd, wt } = workspaceWithApi();
  // Stage the gitlink at c1, then advance the submodule to c2 so index != worktree.
  writeFileSync(join(wt, "c1.txt"), "1");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c1");
  git(cwd, "add", "oms/api");
  writeFileSync(join(wt, "c2.txt"), "2");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "c2");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /differs from the working tree/);
});

test("record rejects a missing recorded gitlink and points at topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0); // pending add: not recorded in HEAD

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /only updates existing root gitlinks/);
  assert.match(output, /oms sync api --commit/);
});

test("record rejects a conflicted root gitlink", () => {
  const { cwd, wt } = workspaceWithApi();
  const base = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");
  const merge = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /conflict/i);
});

test("record rejects a pending removal and points at unsync", () => {
  const { cwd } = workspaceWithApi();
  // Remove the working tree path while the root HEAD still records the gitlink.
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /pending submodule removal/);
  assert.match(output, /oms unsync api --commit/);
});

test("record rejects a detached root HEAD", () => {
  const { cwd } = workspaceWithMovedApi();
  git(cwd, "checkout", "--detach");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
});

test("record rejects an in-progress root merge", () => {
  const { cwd } = workspaceWithApi();
  // A root-level merge conflict on a regular file.
  writeFileSync(join(cwd, "conflict.txt"), "base\n");
  git(cwd, "add", "conflict.txt");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "other");
  writeFileSync(join(cwd, "conflict.txt"), "other\n");
  git(cwd, "commit", "-am", "other");
  git(cwd, "checkout", "main");
  writeFileSync(join(cwd, "conflict.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /in progress/);
});

test("record leaves the gitlink staged when the root commit fails", () => {
  const { cwd } = workspaceWithMovedApi();
  // A failing pre-commit hook aborts the root commit after staging.
  const hook = join(cwd, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/usr/bin/env bash\nexit 1\n");
  execFileSync("chmod", ["+x", hook]);

  const result = run(["record", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /left in place/);
  // The selected gitlink remains staged for retry.
  assert.match(gitOut(cwd, "diff", "--cached", "--name-only"), /oms\/api/);
});

// --- root-safe sync/unsync topology and pull/push ---

test("sync leaves topology unstaged while preserving unrelated staged root changes", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt"); // unrelated, pre-staged

  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /keep\.txt/); // preserved
  assert.doesNotMatch(staged, /\.gitmodules/); // topology unstaged
  assert.doesNotMatch(staged, /oms\/api/);
});

test("sync --commit creates a single-alias add topology commit", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
});

test("sync --commit records pending add topology left by an earlier no-commit sync", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), ""); // left unstaged

  const result = run(["sync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
});

test("sync --commit isolates unrelated staged root paths through the temporary index", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, "keep.txt"), "x");
  git(cwd, "add", "keep.txt");

  // New behavior: the temp-index commit excludes unrelated staged paths and keeps them staged.
  const result = run(["sync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  // keep.txt was not committed and remains staged; the topology paths were consumed by the commit.
  const staged = gitOut(cwd, "diff", "--cached", "--name-only");
  assert.match(staged, /keep\.txt/);
  assert.doesNotMatch(staged, /\.gitmodules/);
  assert.doesNotMatch(staged, /oms\/api/);
  // keep.txt is not in the commit.
  assert.doesNotMatch(gitOut(cwd, "show", "--stat", "--pretty=format:", "HEAD"), /keep\.txt/);
});

test("multi-alias sync --commit creates one plural topology commit", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add submodules");
});

test("multi-alias sync --commit finalizes the successful alias and excludes the failed one", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  // web pins a nonexistent branch so its sync fails preflight; api succeeds.
  writeSources(
    cwd,
    `${sourceFor("api", a).trimEnd()}\n  - alias: web\n    remotes:\n      origin: file://${b}\n    branch: nope\n`,
  );

  const result = run(["sync", "api", "web", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output); // web failed → overall non-zero
  // The successful alias is committed (singular message); the failed alias is not in the commit.
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): add api submodule");
  const committed = gitOut(cwd, "show", "--name-only", "--pretty=format:", "HEAD");
  assert.match(committed, /oms\/api/);
  assert.doesNotMatch(committed, /oms\/web/);
});

test("unsync --commit creates a removal topology commit", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("unsync --commit records pending removal left by an earlier no-commit unsync", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0); // removal left unstaged
  assert.equal(existsSync(join(cwd, "oms", "api")), false);

  const result = run(["unsync", "api", "--commit"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
});

test("unsync --commit rejects partial removal topology it cannot complete", () => {
  const { cwd, wt } = workspaceWithApi();
  // Remove only the .gitmodules entry (partial) and dirty the submodule so unsync cannot finish.
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["unsync", "api", "--commit"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /partial removal topology/i);
});

test("sync restores an uncommitted unsync instead of adding over the recorded gitlink", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /restored pending removal/);
  assert.doesNotMatch(output, /already exists in the index/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("sync restore is scoped to the selected alias and preserves unrelated .gitmodules edits", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  writeFileSync(join(cwd, ".gitmodules"), `${readFileSync(join(cwd, ".gitmodules"), "utf8")}# keep web edit\n`);

  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);

  const modules = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.match(modules, /oms\/api/);
  assert.match(modules, /oms\/web/);
  assert.match(modules, /# keep web edit/);
  assert.equal(existsSync(join(cwd, "oms", "web", ".git")), true);
});

test("sync restore preserves .gitmodules section order for a clean multi-alias restore", () => {
  const a = initBareUpstream();
  const b = initBareUpstream();
  const c = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor([{ alias: "api", bare: a }, { alias: "web", bare: b }, { alias: "docs", bare: c }]));
  assert.equal(run(["sync", "--all"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");

  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  assert.equal(run(["unsync", "web"], { cwd }).status, 0);
  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(run(["sync", "web"], { cwd }).status, 0);

  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("sync restore removes a metadata-only alias directory before initialization", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", ".DS_Store"), "metadata");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(existsSync(join(cwd, "oms", "api", ".DS_Store")), false);
  assert.equal(gitOut(join(cwd, "oms", "api"), "status", "--porcelain"), "");
});

test("sync restores representative partial removal states", () => {
  {
    const { cwd } = workspaceWithApi();
    git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
    const result = run(["sync", "api"], { cwd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), /oms\/api/);
  }

  {
    const { cwd } = workspaceWithApi();
    rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });
    const result = run(["sync", "api"], { cwd });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
  }
});

test("sync restore fails before add when a non-submodule path occupies the alias", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", "file.txt"), "not a submodule");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /cannot restore pending removal safely/);
  assert.doesNotMatch(output, /git submodule add failed/);
});

test("sync restore fails safely when a regular file occupies the alias", () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api"), "not a submodule");

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /cannot restore pending removal safely/);
  assert.doesNotMatch(output, /git submodule add failed/);
  assert.equal(readFileSync(join(cwd, "oms", "api"), "utf8"), "not a submodule");
});

test("sync restore fails before add when the selected root gitlink is conflicted", () => {
  const { cwd, wt } = workspaceWithApi();
  const base = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");
  const merge = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict on the gitlink");
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /root gitlink is conflicted/);
  assert.doesNotMatch(output, /git submodule add failed/);
});

test("sync restore fails before add during an in-progress root operation", () => {
  const { cwd } = workspaceWithApi();
  writeFileSync(join(cwd, "conflict.txt"), "base\n");
  git(cwd, "add", "conflict.txt");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "other");
  writeFileSync(join(cwd, "conflict.txt"), "other\n");
  git(cwd, "commit", "-am", "other");
  git(cwd, "checkout", "main");
  writeFileSync(join(cwd, "conflict.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");
  git(cwd, "config", "--file", ".gitmodules", "--remove-section", "submodule.oms/api");
  rmSync(join(cwd, "oms", "api"), { recursive: true, force: true });

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /in progress/);
  assert.doesNotMatch(output, /git submodule add failed/);
});

test("sync restore reconciles manifest metadata as unstaged .gitmodules edits", () => {
  const { cwd, bare } = workspaceWithApi();
  writeSources(cwd, sourceFor("api", `${bare}/`));
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);

  const result = run(["sync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /reconciled \.gitmodules/);
  assert.match(readFileSync(join(cwd, ".gitmodules"), "utf8"), new RegExp(`url = file://${bare.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}/`));
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "diff", "--name-only"), /^\.gitmodules$/m);
});

test("unsync refuses and preserves a non-submodule path occupying the alias", () => {
  const { cwd } = workspaceWithApi();
  // Leave a pending removal (api unregistered), then drop a non-submodule file at oms/api.
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  writeFileSync(join(cwd, "oms", "api", "file.txt"), "not a submodule");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /occupied by a non-submodule/);
  // The occupying file is untouched, api is not reported as unsynced, and no dirty-tree cause leaks.
  assert.equal(readFileSync(join(cwd, "oms", "api", "file.txt"), "utf8"), "not a submodule");
  assert.doesNotMatch(output, /api: unsynced/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
});

// chmod 0o000 is not enforced for root, so the unreadable-path cases cannot be provoked there.
const skipUnreadable =
  typeof process.getuid === "function" && process.getuid() === 0
    ? { skip: "chmod 0o000 is not enforced when running as root" }
    : {};

test("unsync refuses when oms/<alias> is unreadable", skipUnreadable, () => {
  const { cwd } = workspaceWithApi();
  // Leave a pending removal (api unregistered), then make oms/api unreadable.
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["unsync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    // The misleading "occupied by a non-submodule path" wording is not used for an access error.
    assert.doesNotMatch(output, /occupied by a non-submodule/);
    assert.doesNotMatch(output, /api: unsynced/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("sync restore fails safely when oms/<alias> is unreadable", skipUnreadable, () => {
  const { cwd } = workspaceWithApi();
  assert.equal(run(["unsync", "api"], { cwd }).status, 0);
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["sync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /cannot restore pending removal safely/);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    assert.doesNotMatch(output, /git submodule add failed/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("sync fresh add fails when oms/<alias> is unreadable", skipUnreadable, () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  // api was never synced (no root gitlink), so this hits the fresh-add occupied check.
  mkdirSync(join(cwd, "oms", "api"), { recursive: true });
  chmodSync(join(cwd, "oms", "api"), 0o000);
  try {
    const result = run(["sync", "api"], { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.match(output, /could not be read \(permission or I\/O error\)/);
    assert.doesNotMatch(output, /already exists but is not a registered/);
  } finally {
    chmodSync(join(cwd, "oms", "api"), 0o755);
  }
});

test("unsync refuses before deinit/rm during an in-progress root operation", () => {
  const { cwd } = workspaceWithApi();
  // A root-level merge conflict on a regular file leaves a merge in progress; the gitlink is clean.
  writeFileSync(join(cwd, "conflict.txt"), "base\n");
  git(cwd, "add", "conflict.txt");
  git(cwd, "commit", "-m", "base");
  git(cwd, "checkout", "-b", "other");
  writeFileSync(join(cwd, "conflict.txt"), "other\n");
  git(cwd, "commit", "-am", "other");
  git(cwd, "checkout", "main");
  writeFileSync(join(cwd, "conflict.txt"), "main\n");
  git(cwd, "commit", "-am", "main");
  const merge = spawnSync("git", ["merge", "other"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /in progress/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
  // The submodule is preserved: deinit/rm never ran.
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
});

test("unsync refuses before deinit/rm when the root gitlink is conflicted", () => {
  const { cwd, wt } = workspaceWithApi();
  const base = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "checkout", "-b", "x");
  writeFileSync(join(wt, "b.txt"), "b");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "B");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr B");
  git(cwd, "checkout", "main");
  git(wt, "reset", "--hard", base);
  writeFileSync(join(wt, "c.txt"), "c");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "C");
  git(cwd, "add", "oms/api");
  git(cwd, "commit", "-m", "ptr C");
  const merge = spawnSync("git", ["merge", "x"], { cwd, encoding: "utf8", env: testEnv });
  assert.notEqual(merge.status, 0, "merge should conflict on the gitlink");

  const result = run(["unsync", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /conflicted/);
  assert.doesNotMatch(output, /uncommitted or untracked changes/);
  assert.equal(existsSync(join(cwd, "oms", "api", ".git")), true);
});

test("unsync still removes a normal registered submodule and leaves removal topology", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["unsync", "api"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /api: unsynced/);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
  // The removal is left unstaged by default (existing topology finalization policy); --commit records it.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.equal(run(["unsync", "api", "--commit"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "log", "-1", "--pretty=%s"), "chore(oms): remove api submodule");
});

test("pull rejects a dirty submodule before running", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "dirty.txt"), "x");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /uncommitted changes/);
});

test("pull rejects a detached submodule HEAD", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "checkout", "--detach");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
});

test("pull advances the submodule branch without staging and hints record", () => {
  const { cwd, bare } = workspaceWithApi();
  // Advance origin/main from a scratch clone so there is something to pull.
  const scratch = mkdtempSync(join(tmpdir(), "oms-scratch-"));
  execFileSync("git", ["clone", bare, scratch], { stdio: "ignore", env: testEnv });
  configIdentity(scratch);
  writeFileSync(join(scratch, "up.txt"), "x");
  git(scratch, "add", "-A");
  git(scratch, "commit", "-m", "upstream");
  git(scratch, "push", "origin", "main");

  const result = run(["pull", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /pulled/);
  // No root staging; a record hint is printed because the pointer moved.
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(output, /oms record api/);
});

test("push warns about a dirty submodule but still pushes the current HEAD", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(wt, "committed.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  writeFileSync(join(wt, "dirty.txt"), "y"); // uncommitted

  const result = run(["push", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /only the current HEAD will be pushed/);
  assert.match(output, /pushed/);
});

// --- oms agent (managed instruction files) ---

/** A bare workspace (oms.yaml only, no git) — enough for agent file management. */
function agentWorkspace() {
  const cwd = tempWorkspace();
  writeSources(cwd);
  return cwd;
}

test("agent install --target both creates one managed block per file with the durable rules", () => {
  const cwd = agentWorkspace();
  const result = run(["agent", "install", "--target", "both"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = join(cwd, "oms", name);
    assert.ok(existsSync(file), `${name} should be created`);
    const content = readFileSync(file, "utf8");
    assert.equal(content.match(/<!-- OMS START -->/g).length, 1);
    assert.equal(content.match(/<!-- OMS END -->/g).length, 1);
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"));
    // Durable rules per the spec scenario.
    assert.match(content, /oms status --json/);
    assert.match(content, /separate Git repositor/);
    assert.match(content, /do not guess/i);
    assert.match(content, /oms record <alias>/);
    assert.match(content, /oms --help/);
    assert.match(content, /oms <command> --help/);
  }
});

test("agent install requires --target in a non-interactive shell", () => {
  const cwd = agentWorkspace();
  const result = run(["agent", "install"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /--target/);
  assert.equal(existsSync(join(cwd, "oms", "AGENTS.md")), false);
});

test("agent install appends after two blank lines and preserves existing content", () => {
  const cwd = agentWorkspace();
  mkdirSync(join(cwd, "oms"), { recursive: true });
  writeFileSync(join(cwd, "oms", "AGENTS.md"), "# House rules\nBe nice.\n");

  assert.equal(run(["agent", "install", "--target", "agents"], { cwd }).status, 0);
  const content = readFileSync(join(cwd, "oms", "AGENTS.md"), "utf8");
  assert.match(content, /# House rules\nBe nice\.\n\n\n<!-- OMS START -->/);
  assert.ok(content.endsWith("<!-- OMS END -->\n"));
});

test("agent install replaces exactly one existing block and keeps outside content", () => {
  const cwd = agentWorkspace();
  assert.equal(run(["agent", "install", "--target", "agents"], { cwd }).status, 0);
  // Add content around the block, then re-install.
  const file = join(cwd, "oms", "AGENTS.md");
  writeFileSync(file, `Top matter.\n\n${readFileSync(file, "utf8")}\nBottom matter.\n`);
  assert.equal(run(["agent", "install", "--target", "agents"], { cwd }).status, 0);

  const content = readFileSync(file, "utf8");
  assert.equal(content.match(/<!-- OMS START -->/g).length, 1);
  assert.match(content, /Top matter\./);
  assert.match(content, /Bottom matter\./);
});

test("agent install does not stage the files in Git", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  assert.equal(run(["agent", "install", "--target", "both"], { cwd }).status, 0);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), "");
  assert.match(gitOut(cwd, "status", "--porcelain"), /oms\//);
});

test("agent uninstall removes the block, deletes emptied files, and no-ops when absent", () => {
  const cwd = agentWorkspace();
  // AGENTS.md keeps surrounding content; CLAUDE.md becomes empty and is deleted.
  assert.equal(run(["agent", "install", "--target", "both"], { cwd }).status, 0);
  const agents = join(cwd, "oms", "AGENTS.md");
  writeFileSync(agents, `Keep me.\n\n${readFileSync(agents, "utf8")}`);

  assert.equal(run(["agent", "uninstall", "--target", "both"], { cwd }).status, 0);
  assert.equal(existsSync(join(cwd, "oms", "CLAUDE.md")), false); // emptied → deleted
  const content = readFileSync(agents, "utf8");
  assert.doesNotMatch(content, /<!-- OMS START -->/);
  assert.match(content, /Keep me\./);

  // Re-running uninstall is a clean no-op.
  const again = run(["agent", "uninstall", "--target", "both"], { cwd });
  const output = again.stdout + again.stderr;
  assert.equal(again.status, 0, output);
  assert.match(output, /no OMS block found/);
});

test("agent install rejects malformed markers atomically across targets", () => {
  const cwd = agentWorkspace();
  mkdirSync(join(cwd, "oms"), { recursive: true });
  // AGENTS.md is clean (no block); CLAUDE.md is malformed (start-only).
  writeFileSync(join(cwd, "oms", "AGENTS.md"), "# Clean file\n");
  writeFileSync(join(cwd, "oms", "CLAUDE.md"), "<!-- OMS START -->\norphan\n");

  const result = run(["agent", "install", "--target", "both"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /OMS marker|markers/);
  // No file was modified: AGENTS.md still has no block.
  assert.doesNotMatch(readFileSync(join(cwd, "oms", "AGENTS.md"), "utf8"), /<!-- OMS START -->/);
});

test("agent uninstall rejects a duplicate managed block atomically", () => {
  const cwd = agentWorkspace();
  mkdirSync(join(cwd, "oms"), { recursive: true });
  const dup = "<!-- OMS START -->\na\n<!-- OMS END -->\n<!-- OMS START -->\nb\n<!-- OMS END -->\n";
  writeFileSync(join(cwd, "oms", "CLAUDE.md"), dup);

  const result = run(["agent", "uninstall", "--target", "claude"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  // The malformed file is left untouched.
  assert.equal(readFileSync(join(cwd, "oms", "CLAUDE.md"), "utf8"), dup);
});

// --- command help boundaries ---

test("commit help explains the submodule scope with an example", () => {
  const result = run(["commit", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /submodule only/);
  assert.match(result.stdout, /never the root gitlink/);
  assert.match(result.stdout, /oms commit api/);
});

test("record help explains the root-repository scope with an example", () => {
  const result = run(["record", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ROOT repository only/);
  assert.match(result.stdout, /oms record api/);
});

test("push help explains the push/record separation and unsupported --commit", () => {
  const result = run(["push", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /never stages or commits the root gitlink/);
  assert.match(result.stdout, /not the same as recording a pointer commit/);
  assert.match(result.stdout, /unsupported/);
  assert.match(result.stdout, /oms record <alias>/);
});

test("pull help documents that it does not stage the root gitlink", () => {
  const result = run(["pull", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /never stages or commits the root gitlink/);
  assert.match(result.stdout, /oms record <alias>/);
});

test("status help documents the machine-readable --json mode", () => {
  const result = run(["status", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /JSON object/);
});

test("status help documents the schemaVersion 1 field contract", () => {
  const result = run(["status", "--help"]);
  assert.equal(result.status, 0);
  // Names every schemaVersion 1 top-level key.
  for (const key of [
    "schemaVersion",
    "toolVersion",
    "workspaceRoot",
    "currentAlias",
    "root",
    "repos",
    "errors",
  ]) {
    assert.ok(result.stdout.includes(key), `status --help should name top-level key ${key}`);
  }
  // Pointer arrays live under root.submodulePointers, never a top-level "pointers" key.
  assert.match(result.stdout, /root\.submodulePointers/);
  for (const arr of ["moved", "staged", "split", "conflict"]) {
    assert.ok(result.stdout.includes(arr), `status --help should name pointer array ${arr}`);
  }
  assert.doesNotMatch(result.stdout, /repos,\s*pointers/i);
});

test("sync and unsync help document the default-unstage and --commit topology behavior", () => {
  const sync = run(["sync", "--help"]);
  assert.match(sync.stdout, /left unstaged by default/);
  assert.match(sync.stdout, /--commit/);
  assert.match(sync.stdout, /oms sync api --commit/);

  const unsync = run(["unsync", "--help"]);
  assert.match(unsync.stdout, /left unstaged by default/);
  assert.match(unsync.stdout, /oms unsync api --commit/);
});

test("agent install help documents the managed instruction files", () => {
  const result = run(["agent", "install", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /AGENTS\.md/);
  assert.match(result.stdout, /CLAUDE\.md/);
  assert.match(result.stdout, /OMS START/);
  assert.match(result.stdout, /oms agent install --target both/);
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

  // unsync now leaves the removal unstaged by default; commit it so re-sync starts from a clean index.
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "remove api");

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
  assert.match(output, /Workspace manifest directory:/);
  assert.doesNotMatch(output, /Workspace root:/);
  assert.match(output, /oms\.yaml: 1 repo\(s\) configured/);
  assert.match(output, /git:/);
  assert.match(output, /not a git repository/);
});

test("doctor diagnoses a nested manifest without reporting a valid workspace root", () => {
  const root = initGitWorkspace();
  const cwd = join(root, "nested");
  mkdirSync(cwd);
  writeSources(cwd);

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /does not match the root Git top-level/);
  assert.match(output, /Workspace manifest directory:/);
  assert.doesNotMatch(output, /Workspace root:/);
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
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: currentVersion } }),
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
  assert.match(output, versionPattern(`Current version: ${currentVersion}`));
  assert.match(output, versionPattern(`Latest version: ${newerVersion}`));
  assert.match(output, /Update available/);
  assert.match(output, /Detected context: global npm install/);
  assert.match(output, /Selected command: npm install -g oh-my-space@latest/);
});

test("update --check reports prerelease channel guidance", () => {
  const betaVersion = "0.12.0-beta.0";
  const stableVersion = "0.12.0";
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_PACKAGE_VERSION: betaVersion,
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: stableVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global npm install",
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Installed prerelease version: 0\.12\.0-beta\.0/);
  assert.match(output, /Stable latest version: 0\.12\.0/);
  assert.match(output, /Selected update channel: stable latest \(oh-my-space@latest\)/);
  assert.match(output, /Stay on beta manually: npm install -g oh-my-space@beta/);
  assert.match(output, /Return to stable: npm install -g oh-my-space@latest/);
});

test("update --check reports prerelease guidance for detected package manager", () => {
  const betaVersion = "0.12.0-beta.0";
  const stableVersion = "0.12.0";
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_PACKAGE_VERSION: betaVersion,
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: stableVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global pnpm install",
        updateCommand: { executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] },
      }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Stay on beta manually: pnpm add -g oh-my-space@beta/);
  assert.match(output, /Return to stable: pnpm add -g oh-my-space@latest/);
  assert.doesNotMatch(output, /Stay on beta manually: npm install -g oh-my-space@beta/);
  assert.doesNotMatch(output, /Return to stable: npm install -g oh-my-space@latest/);
});

test("update --check reports prerelease guidance alternatives without detected package manager", () => {
  const betaVersion = "0.12.0-beta.0";
  const stableVersion = "0.12.0";
  const result = run(["update", "--check"], {
    env: updateEnv({
      OMS_TEST_PACKAGE_VERSION: betaVersion,
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: stableVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("unknown", { guidance: [] }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /npm beta: npm install -g oh-my-space@beta/);
  assert.match(output, /pnpm beta: pnpm add -g oh-my-space@beta/);
  assert.match(output, /yarn stable: yarn global add oh-my-space@latest/);
  assert.match(output, /bun stable: bun add -g oh-my-space@latest/);
});

test("release:beta rejects publishing with allow-dirty", () => {
  const cwd = tempWorkspace();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "oh-my-space", version: "0.12.0" }, null, 2)}\n`);
  writeFileSync(
    join(cwd, "package-lock.json"),
    `${JSON.stringify({ name: "oh-my-space", version: "0.12.0", packages: { "": { version: "0.12.0" } } }, null, 2)}\n`,
  );
  git(cwd, "add", "package.json", "package-lock.json");
  git(cwd, "commit", "-m", "init");
  writeFileSync(join(cwd, "dirty.txt"), "uncommitted\n");

  const result = spawnSync(process.execPath, [publishBetaScript, "--publish", "--allow-dirty"], {
    cwd,
    encoding: "utf8",
    env: testEnv,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /--allow-dirty is only supported for dry-run verification/);
  assert.doesNotMatch(output, /Preparing oh-my-space@/);
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
    env: updateEnv({ OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: "0.0.0" } }) }),
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

test("update treats unresolved node_modules installs as unknown", () => {
  const root = tempWorkspace();
  const packageRoot = join(root, "node_modules", "oh-my-space");
  const runningBin = join(packageRoot, "dist", "oms.js");
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_RUNTIME_EVIDENCE: JSON.stringify({
        packageRoot,
        realPackageRoot: packageRoot,
        runningBin,
        realRunningBin: runningBin,
        pathBin: null,
        realPathBin: null,
        packageName: "oh-my-space",
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Detected context: unknown install context/);
  assert.match(output, /Automatic update is only supported/);
  assert.doesNotMatch(output, /project-local install/);
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
      OMS_TEST_VERIFY_VERSION: currentVersion,
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Selected command: pnpm add -g oh-my-space@latest/);
  assert.match(output, versionPattern(`Post-update verification saw ${currentVersion}, expected ${newerVersion}`));
  assert.match(output, /Update command completed/);
});

test("update --yes from prerelease makes the stable target explicit before mutation", () => {
  const betaVersion = "0.12.0-beta.0";
  const stableVersion = "0.12.0";
  const result = run(["update", "--yes"], {
    env: updateEnv({
      OMS_TEST_PACKAGE_VERSION: betaVersion,
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: stableVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        label: "global npm install",
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
      OMS_TEST_VERIFY_VERSION: stableVersion,
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Selected command: npm install -g oh-my-space@latest/);
  assert.match(output, /Selected update channel: stable latest \(oh-my-space@latest\)/);
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

// --- oms skills (install command + published skill sources) ---

/** A stand-in for npx that records the args and cwd it was invoked with, then exits with `exit`. */
function makeFakeNpx(dir, { exit = 0 } = {}) {
  const captureFile = join(dir, "npx-capture.json");
  const bin = join(dir, "fake-npx.mjs");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
      `process.exit(${exit});`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, captureFile };
}

function skillsEnv(npxBin, overrides = {}) {
  return { ...testEnv, OMS_TEST_MODE: "1", OMS_NPX_BIN: npxBin, ...overrides };
}

test("skills prints the project and global install commands", () => {
  const result = run(["skills"]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills\b/); // project scope
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills -g\b/); // global scope
});

test("skills --install delegates to npx skills add from the workspace root, forwarding extra args", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const sub = join(ws, "oms", "api", "sub");
  mkdirSync(sub, { recursive: true });
  const { bin, captureFile } = makeFakeNpx(ws);

  const result = run(["skills", "--install", "--skill", "oms-branch"], { cwd: sub, env: skillsEnv(bin) });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.deepEqual(captured.args, ["skills", "add", "divlook/oh-my-space/skills", "--skill", "oms-branch"]);
  // Resolved to the workspace root, not the oms/<alias>/ subdir the command ran from.
  assert.equal(realpathSync(captured.cwd), realpathSync(ws));
});

test("skills --install returns the delegated process exit code", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const { bin } = makeFakeNpx(ws, { exit: 7 });
  const result = run(["skills", "--install"], { cwd: ws, env: skillsEnv(bin) });
  assert.equal(result.status, 7, result.stdout + result.stderr);
});

test("skills --install delegates the overridden executable the same args npx would receive", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const { bin, captureFile } = makeFakeNpx(ws);
  const result = run(["skills", "--install"], { cwd: ws, env: skillsEnv(bin) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.deepEqual(captured.args, ["skills", "add", "divlook/oh-my-space/skills"]);
});

test("skills --install outside a workspace without -g errors and points to the global install", () => {
  const dir = tempWorkspace(); // no oms.yaml
  const { bin, captureFile } = makeFakeNpx(dir);
  const result = run(["skills", "--install"], { cwd: dir, env: skillsEnv(bin) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills -g/);
  assert.ok(!existsSync(captureFile), "delegation must not run outside a workspace without -g");
});

test("skills --install -g delegates even outside a workspace", () => {
  const dir = tempWorkspace(); // no oms.yaml
  const { bin, captureFile } = makeFakeNpx(dir);
  const result = run(["skills", "--install", "-g"], { cwd: dir, env: skillsEnv(bin) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.deepEqual(captured.args, ["skills", "add", "divlook/oh-my-space/skills", "-g"]);
});

test("skills --install prints the manual command when delegation cannot execute", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const missing = join(ws, "no-such-npx-binary");
  const result = run(["skills", "--install"], { cwd: ws, env: skillsEnv(missing) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills/);
});

test("skills help documents purpose, scope, and an example", () => {
  const result = run(["skills", "--help"]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /install the oms workspace skills/i);
  assert.match(output, /project scope/i);
  assert.match(output, /global/i);
  assert.match(output, /\$ oms skills/);
});

// The canonical scope-guardrail kernel, identical to OMS_SCOPE_GUARDRAIL in scripts/oms.ts.
// Pinned to the source constant below via the marker-block assertion, so it cannot silently drift.
const SKILL_KERNEL = [
  "- Run `oms status --json` before Git work involving `oms/` to read root versus submodule state.",
  "- Treat each `oms/<alias>/` directory as a separate Git repository.",
  "- Use `oms` commands for scoped submodule workflows; do not guess root repository versus submodule Git scope.",
  "- Do not create root commits for existing submodule pointer updates unless the user explicitly runs `oms record <alias>`.",
].join("\n");

const SKILL_NAMES = ["oms-workspace", "oms-pointer", "oms-branch"];

function readSkill(name) {
  return readFileSync(resolve("skills", name, "SKILL.md"), "utf8");
}

function splitSkillFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "SKILL.md must open with a --- frontmatter --- block");
  return { frontmatter: m[1], body: m[2] };
}

test("each oms skill is published with name/description frontmatter", () => {
  for (const name of SKILL_NAMES) {
    const { frontmatter } = splitSkillFrontmatter(readSkill(name));
    const data = parseYaml(frontmatter);
    assert.equal(typeof data.name, "string", `${name}: name must be a string`);
    assert.ok(data.name.length > 0, `${name}: name must be non-empty`);
    assert.equal(data.name, name, `${name}: frontmatter name must match its directory`);
    assert.equal(typeof data.description, "string", `${name}: description must be a string`);
    assert.ok(data.description.length > 0, `${name}: description must be non-empty`);
  }
});

test("the guardrail kernel is single-sourced into the marker block and every SKILL.md", () => {
  // The marker block is built from OMS_SCOPE_GUARDRAIL, so asserting the kernel against the live
  // marker output pins SKILL_KERNEL to the source constant; the skill checks then catch any drift.
  const ws = tempWorkspace();
  writeSources(ws);
  const result = run(["agent", "install", "--target", "agents"], { cwd: ws });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const marker = readFileSync(join(ws, "oms", "AGENTS.md"), "utf8");
  assert.ok(marker.includes(SKILL_KERNEL), "kernel must be a literal substring of the marker block");

  for (const name of SKILL_NAMES) {
    assert.ok(readSkill(name).includes(SKILL_KERNEL), `${name} must carry the kernel verbatim`);
  }
});

test("each SKILL.md is schema-stable and portable", () => {
  // Agent-specific slash command, e.g. " /foo" or "(/foo)" — not a path like oms/<alias>/.
  const SLASH_COMMAND = /(^|[\s(])\/[A-Za-z]/m;
  for (const name of SKILL_NAMES) {
    const { frontmatter, body } = splitSkillFrontmatter(readSkill(name));

    // schemaVersion is declared in the body (which the agent reads), not the frontmatter.
    assert.doesNotMatch(frontmatter, /schemaVersion/, `${name}: schemaVersion must not live in frontmatter`);
    assert.match(body, /schemaVersion/, `${name}: body must declare the schemaVersion it was written against`);

    // Field semantics defer to the version-matched authoritative source.
    assert.ok(body.includes("oms status --help"), `${name}: body must point to oms status --help`);

    // Portable: no agent-specific slash-command syntax.
    assert.doesNotMatch(body, SLASH_COMMAND, `${name}: body must not contain slash-command syntax`);

    // Any normal-path flag a body names must cite the matching --help.
    if (body.includes("--commit")) {
      assert.ok(
        body.includes("oms sync --help") && body.includes("oms unsync --help"),
        `${name}: a body naming --commit must also cite oms sync --help and oms unsync --help`,
      );
    }
    if (/(^|[\s(`])-m\b/.test(body)) {
      assert.ok(body.includes("oms commit --help"), `${name}: a body naming -m must also cite oms commit --help`);
    }
  }
});

// ─── branch delete: guarded prompt queue + local branch deletion (0.12.0) ───

/** Env with the guarded test-response queue active. */
function queueEnv(responses, overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_PROMPT_RESPONSES: JSON.stringify(responses),
    ...overrides,
  };
}

/** Whether a local branch ref exists in the given working-tree directory. */
function localBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    env: testEnv,
  }).status === 0;
}

/** Whether a remote-tracking ref origin/<branch> exists in the given directory. */
function remoteBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
    env: testEnv,
  }).status === 0;
}

/** Sync one alias and return the submodule working-tree path. */
function syncedSubmodule(cwd, alias, bare, branch = "main") {
  writeSources(cwd, sourceFor(alias, bare, branch));
  assert.equal(run(["sync", alias, "--commit"], { cwd }).status, 0);
  return join(cwd, "oms", alias);
}

test("branch is exposed with list, switch, checkout, and delete subcommands", () => {
  const help = run(["branch", "--help"]);
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /\blist\b/);
  assert.match(help.stdout, /\bswitch\b/);
  assert.match(help.stdout, /\bcheckout\b/);
  assert.match(help.stdout, /\bdelete\b/);
  const lhelp = run(["branch", "list", "--help"]);
  assert.equal(lhelp.status, 0);
  assert.match(lhelp.stdout, /stale|cached/);
  const swhelp = run(["branch", "switch", "--help"]);
  assert.equal(swhelp.status, 0);
  assert.match(swhelp.stdout, /--from/);
  const cohelp = run(["branch", "checkout", "--help"]);
  assert.equal(cohelp.status, 0);
  assert.match(cohelp.stdout, /REMOTE|origin/);
  const dhelp = run(["branch", "delete", "--help"]);
  assert.equal(dhelp.status, 0);
  assert.match(dhelp.stdout, /--force/);
});

test("top-level switch and checkout are removed and fail as unknown commands", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);

  const sw = run(["switch", "api", "feature/x"], { cwd });
  assert.equal(sw.status, 1, sw.stdout + sw.stderr);
  assert.match(sw.stdout + sw.stderr, /unknown command/);

  const co = run(["checkout", "api", "dev"], { cwd });
  assert.equal(co.status, 1, co.stdout + co.stderr);
  assert.match(co.stdout + co.stderr, /unknown command/);
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
  // Bring dev down as a local tracking branch, switch back to main, then delete local dev.
  assert.equal(run(["branch", "checkout", "api", "dev"], { cwd }).status, 0);
  assert.equal(run(["branch", "switch", "api", "main"], { cwd }).status, 0);
  const rootBefore = gitOut(cwd, "rev-parse", "HEAD");
  const stagedBefore = gitOut(cwd, "diff", "--cached", "--name-only");

  const del = run(["branch", "delete", "api", "dev"], { cwd });
  assert.equal(del.status, 0, del.stdout + del.stderr);
  assert.equal(localBranchExists(dir, "dev"), false);
  // Remote-tracking ref and the actual origin branch survive.
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
  // Bring develop local, switch to a scratch branch so develop is baseline-but-not-current.
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0);
  git(dir, "checkout", "-b", "scratch");
  const del = run(["branch", "delete", "api", "develop"], { cwd });
  assert.equal(del.status, 1, del.stdout + del.stderr);
  assert.match(del.stdout + del.stderr, /protected/);
});

test("branch delete protects the remote default when oms.yaml omits branch", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  // No branch key in oms.yaml.
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
  // Remove any origin/HEAD so the remote default cannot be resolved.
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
  // dev exists on origin but not locally: local-only guidance.
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
  assert.match(out, new RegExp(oid)); // full OID recovery line
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
  // Selecting switch dispatches into runSwitch; its own alias resolution then reports the
  // switch-specific non-TTY hint, proving the selector entered the switch flow.
  const res = run(["branch"], { cwd, env: queueEnv([{ type: "select", value: "switch" }]) });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /oms branch switch <alias>/);
});

test("bare branch selector dispatches into the checkout flow", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  const res = run(["branch"], { cwd, env: queueEnv([{ type: "select", value: "checkout" }]) });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /oms branch checkout <alias>/);
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

test("guarded queue fails closed on malformed JSON, wrong type, and unconsumed responses", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "branch", "feature/q");

  const malformed = run(["branch", "delete", "api", "feature/q"], {
    cwd,
    env: queueEnv(undefined, { OMS_TEST_PROMPT_RESPONSES: "not json" }),
  });
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  assert.match(malformed.stdout + malformed.stderr, /not valid JSON/);

  // A confirm response cannot satisfy a select prompt.
  const wrongType = run(["branch", "delete"], { cwd, env: queueEnv([{ type: "confirm", value: true }]) });
  assert.equal(wrongType.status, 1, wrongType.stdout + wrongType.stderr);

  // feature/q survived the malformed run; an extra queued response is left unconsumed.
  const unconsumed = run(["branch", "delete", "api", "feature/q"], {
    cwd,
    env: queueEnv([{ type: "confirm", value: true }]),
  });
  assert.equal(unconsumed.status, 1, unconsumed.stdout + unconsumed.stderr);
  assert.match(unconsumed.stdout + unconsumed.stderr, /unconsumed/);
});

test("injected responses are ignored without OMS_TEST_MODE", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", bare);
  // Queue set but OMS_TEST_MODE absent: normal non-TTY behavior (omitted alias fails fast).
  const res = run(["branch", "delete"], {
    cwd,
    env: { ...testEnv, OMS_TEST_PROMPT_RESPONSES: JSON.stringify([{ type: "select", value: "api" }]) },
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout + res.stderr, /not a TTY/);
});

test("branch delete rejects an in-progress submodule operation and an unanchored detached HEAD", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", bare);
  git(dir, "commit", "--allow-empty", "-m", "extra");
  // Unanchored detached HEAD: detach onto a commit that differs from the recorded gitlink.
  git(dir, "checkout", "--detach", "HEAD");
  const detached = run(["branch", "delete", "api", "main"], { cwd });
  assert.equal(detached.status, 1, detached.stdout + detached.stderr);
  assert.match(detached.stdout + detached.stderr, /detached/);

  // In-progress operation: fabricate a MERGE_HEAD marker in the submodule git dir.
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
  // Add a declared-but-unsynced alias.
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
  // Deinit keeps the gitlink and .gitmodules registration but removes the worktree .git.
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
  // Drift .gitmodules to record develop while oms.yaml still says main.
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");
  assert.equal(run(["branch", "checkout", "api", "develop"], { cwd }).status, 0);
  git(dir, "checkout", "-b", "scratch");

  // Deleting develop (a .gitmodules baseline) is blocked; the drift warning is emitted.
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
  // Check feature/w out in a linked worktree so Git refuses to delete it.
  const wt = mkdtempSync(join(tmpdir(), "oms-linked-"));
  git(dir, "worktree", "add", wt, "feature/w");
  const res = run(["branch", "delete", "api", "feature/w", "--force"], { cwd });
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.equal(localBranchExists(dir, "feature/w"), true);
  rmSync(wt, { recursive: true, force: true });
});

// ─── branch list: automated inventory and degraded remote refresh ───

test("branch list shows sorted local and every declared remote branch, excluding symbolic HEAD and unmanaged remotes", () => {
  const origin = initBareUpstream({ branches: ["main", "zeta", "alpha"] });
  const backup = initBareUpstream({ branches: ["main", "beta"] });
  const unmanaged = initBareUpstream({ branches: ["main", "private"] });
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { backup }));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const dir = join(cwd, "oms", "api");
  git(dir, "branch", "z-local");
  git(dir, "branch", "a-local");
  git(dir, "remote", "add", "unmanaged", `file://${unmanaged}`);
  git(dir, "fetch", "unmanaged");
  git(dir, "branch", "external", "unmanaged/private");
  git(dir, "branch", "--set-upstream-to", "unmanaged/private", "external");

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Branch inventory: api/);
  assert.ok(output.indexOf("a-local\t") < output.indexOf("main\t"), output);
  assert.ok(output.indexOf("main\t") < output.indexOf("z-local\t"), output);
  assert.match(output, /origin\tfresh\talpha/);
  assert.match(output, /backup\tfresh\tbeta/);
  assert.match(output, /external\t\tunmanaged\/private\t0\t0/);
  assert.doesNotMatch(output, /origin\/(?:HEAD)|\tunmanaged\t|unmanaged\t(?:fresh|stale|unavailable)/);
});

test("branch list reports current, multiple baselines, exact upstream divergence, no upstream, and gone upstream", () => {
  const origin = initBareUpstream({ branches: ["main", "develop", "tracked"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin, "main");
  git(dir, "checkout", "-b", "tracked", "origin/tracked");
  git(dir, "commit", "--allow-empty", "-m", "ahead");
  git(dir, "branch", "ahead");
  git(dir, "branch", "--set-upstream-to", "origin/tracked", "ahead");
  git(dir, "branch", "scratch");
  git(dir, "config", "branch.tracked.merge", "refs/heads/missing");
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.branch", "develop");

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /BASELINE \[incomplete\]: develop, main|BASELINE \[incomplete\]: main, develop/);
  assert.match(output, /main\tbaseline/);
  assert.match(output, /ahead\t\torigin\/tracked\t1\t0/);
  assert.match(output, /tracked\tcurrent\torigin\/missing\t\?\t\?/);
  assert.match(output, /scratch\t\t\t\t/);
  assert.match(output, /differs from oms.yaml/);
});

test("branch list auto-selects and initializes the sole registered alias using the manifest URL without rewriting metadata", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin);
  git(cwd, "config", "--file", ".gitmodules", "submodule.oms/api.url", "https://wrong.invalid/private.git");
  const metadataBefore = readFileSync(join(cwd, ".gitmodules"), "utf8");
  assert.equal(spawnSync("git", ["-C", cwd, "submodule", "deinit", "-f", "oms/api"], { env: testEnv }).status, 0);

  const result = run(["branch", "list"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(dir, ".git")), true);
  assert.equal(readFileSync(join(cwd, ".gitmodules"), "utf8"), metadataBefore);
  assert.match(result.stdout + result.stderr, /Branch inventory: api/);
});

test("branch list rejects unknown, ambiguous, unregistered, and partial aliases with actionable guidance", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${origin}\n    branch: main\n  - alias: web\n    remotes:\n      origin: file://${origin}\n    branch: main\n`);

  const unknown = run(["branch", "list", "missing"], { cwd });
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /Unknown alias|sync --list/);
  const ambiguous = run(["branch", "list"], { cwd });
  assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stdout + ambiguous.stderr, /oms branch list <alias>/);
  const unregistered = run(["branch", "list", "api"], { cwd });
  assert.equal(unregistered.status, 1, unregistered.stdout + unregistered.stderr);
  assert.match(unregistered.stdout + unregistered.stderr, /oms sync api/);

  writeFileSync(join(cwd, ".gitmodules"), `[submodule "oms/api"]\n\tpath = oms/api\n\turl = file://${origin}\n`);
  const partial = run(["branch", "list"], {
    cwd,
    env: queueEnv([{ type: "select", value: "api" }]),
  });
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.match(partial.stdout + partial.stderr, /inconsistent|pending/);
});

test("bare branch routes list through the guarded action selector without leftover responses", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", origin);
  const result = run(["branch"], {
    cwd,
    env: queueEnv([{ type: "select", value: "list" }]),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Branch inventory: api/);
});

test("branch list marks failed fetch cached refs stale, redacts credentials, and preserves branch and root state", () => {
  const origin = initBareUpstream({ branches: ["main", "cached"] });
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin);
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "diff", "--cached", "--name-only");
  const subHead = gitOut(dir, "rev-parse", "HEAD");
  const branch = gitOut(dir, "branch", "--show-current");
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: https://secret:token@example.invalid/private.git\n    branch: main\n`);

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /origin\tstale\tcached/);
  assert.match(output, /example\.invalid\/private\.git/);
  assert.doesNotMatch(output, /secret:token/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), rootIndex);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), subHead);
  assert.equal(gitOut(dir, "branch", "--show-current"), branch);
});

test("branch list redacts credential-bearing query parameters from Git diagnostics", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", origin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [ "$1" = "fetch" ] && [ "$2" = "origin" ]; then echo 'fatal: https://example.invalid/repo?api_key=one&client_secret=two&refresh_token=three&secret=four&auth_token=five&oauth_token=six' >&2; exit 1; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(stubGit, 0o755);

  const result = run(["branch", "list", "api"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api_key=\[redacted\]/);
  assert.match(output, /client_secret=\[redacted\]/);
  assert.match(output, /refresh_token=\[redacted\]/);
  assert.match(output, /secret=\[redacted\]/);
  assert.match(output, /auth_token=\[redacted\]/);
  assert.match(output, /oauth_token=\[redacted\]/);
  assert.doesNotMatch(output, /(?:api_key=one|client_secret=two|refresh_token=three|secret=four|auth_token=five|oauth_token=six)/);
});

test("branch list reports fresh empty remote groups and detached HEAD", () => {
  const origin = initBareUpstream();
  const empty = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { empty }));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const dir = join(cwd, "oms", "api");
  const oid = gitOut(dir, "rev-parse", "--short", "HEAD");
  git(dir, "checkout", "--detach");

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, new RegExp(`HEAD: detached ${oid}`));
  assert.match(output, /empty\tfresh\t\(empty\)/);
  assert.doesNotMatch(output, /main\tcurrent/);
});

test("branch list degrades malformed baseline metadata instead of failing closed", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", origin);
  writeFileSync(join(cwd, ".gitmodules"), '[submodule "oms/api"\n\tpath = oms/api\n');

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /BASELINE \[incomplete\]: main/);
  assert.match(output, /invalid Git config syntax/);
  assert.match(output, /LOCAL/);
});

test("branch list can sync an unregistered alias interactively, continue listing, or cancel without topology", () => {
  const origin = initBareUpstream();
  const acceptedCwd = initGitWorkspace();
  writeSources(acceptedCwd, sourceFor("api", origin));
  const accepted = run(["branch", "list", "api"], {
    cwd: acceptedCwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout + accepted.stderr, /Branch inventory: api/);
  assert.equal(existsSync(join(acceptedCwd, "oms", "api", ".git")), true);
  const pendingAdd = run(["branch", "list", "api"], { cwd: acceptedCwd });
  assert.equal(pendingAdd.status, 1, pendingAdd.stdout + pendingAdd.stderr);
  assert.match(pendingAdd.stdout + pendingAdd.stderr, /inconsistent|pending/);

  const cancelledCwd = initGitWorkspace();
  writeSources(cancelledCwd, sourceFor("api", origin));
  const cancelled = run(["branch", "list", "api"], {
    cwd: cancelledCwd,
    env: queueEnv([{ type: "select", value: "cancel" }]),
  });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.equal(existsSync(join(cancelledCwd, ".gitmodules")), false);
  assert.equal(existsSync(join(cancelledCwd, "oms", "api", ".git")), false);
});

test("branch list preserves stdin for credential prompts during delegated sync redaction", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const marker = join(stubDir, "stdin-read");
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [ "$1" = "submodule" ] && [ "$2" = "add" ]; then IFS= read -r credential; [ "$credential" = "credential-value" ] || exit 88; printf '%s' "$credential" > "${marker}"; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(stubGit, 0o755);

  const result = run(["branch", "list", "api"], {
    cwd,
    input: "credential-value\n",
    env: queueEnv([{ type: "select", value: "sync" }], { PATH: `${stubDir}${delimiter}${process.env.PATH}` }),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(marker, "utf8"), "credential-value");
  assert.match(result.stdout + result.stderr, /Branch inventory: api/);
});

test("branch list retries a transient fetch once and processes declared remotes sequentially", () => {
  const origin = initBareUpstream();
  const backup = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { backup }));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const countFile = join(stubDir, "origin-fetch-count");
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [ "$1" = "fetch" ] && [ "$2" = "origin" ]; then\n  count=0; [ -f "${countFile}" ] && count=$(cat "${countFile}")\n  count=$((count + 1)); printf '%s' "$count" > "${countFile}"\n  [ "$count" -eq 1 ] && { echo 'transient fetch failure' >&2; exit 1; }\nfi\nexec "${realGit}" "$@"\n`);
  chmodSync(stubGit, 0o755);

  const result = run(["branch", "list", "api"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.equal(readFileSync(countFile, "utf8"), "2");
  assert.match(output, /origin\tfresh\tmain/);
  assert.ok(output.indexOf("fetching origin") < output.indexOf("fetching backup"), output);
});

test("branch list treats remote configuration and ref inspection failures as unavailable while continuing", () => {
  const origin = initBareUpstream();
  const backup = initBareUpstream({ branches: ["main", "backup-only"] });
  const configfail = initBareUpstream({ branches: ["main", "hidden"] });
  const replacement = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { backup, configfail }));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  writeSources(cwd, sourceFor("api", origin, "main", { backup, configfail: replacement }));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nlast="${"${@: -1}"}"\nif [ "$1" = "remote" ] && [ "$2" = "set-url" ] && [ "$3" = "configfail" ]; then echo 'cannot configure remote' >&2; exit 41; fi\nif [ "$1" = "for-each-ref" ] && [ "$last" = "refs/remotes/backup" ]; then echo 'cannot inspect backup refs' >&2; exit 42; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(stubGit, 0o755);

  const result = run(["branch", "list", "api"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /origin\tfresh\tmain/);
  assert.match(output, /backup\tunavailable\t\(empty\)/);
  assert.match(output, /configfail\tunavailable\t\(empty\)/);
  assert.match(output, /cannot inspect backup refs/);
  assert.match(output, /cannot configure remote/);
  assert.doesNotMatch(output, /backup\t(?:fresh|stale)\tbackup-only/);
  assert.doesNotMatch(output, /configfail\t(?:fresh|stale)\thidden/);
});

test("branch list exits 2 with preserved-state repair guidance when local refs cannot be inspected", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin);
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const branch = gitOut(dir, "branch", "--show-current");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nlast="${"${@: -1}"}"\nif [ "$1" = "for-each-ref" ] && [ "$last" = "refs/heads" ]; then echo 'cannot inspect local refs' >&2; exit 42; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(stubGit, 0o755);

  const result = run(["branch", "list", "api"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` },
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /local branch ref inspection failed/);
  assert.match(output, /preserved|Retry/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(dir, "branch", "--show-current"), branch);
});

test("branch list refreshes an omitted origin default and distrusts cached origin HEAD after fetch failure", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${origin}\n`);
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);

  const fresh = run(["branch", "list", "api"], { cwd });
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout + fresh.stderr, /BASELINE \[known\]: main/);

  writeSources(cwd, "repos:\n  - alias: api\n    remotes:\n      origin: https://example.invalid/missing.git\n");
  const stale = run(["branch", "list", "api"], { cwd });
  const output = stale.stdout + stale.stderr;
  assert.equal(stale.status, 0, output);
  assert.match(output, /origin\tstale\tmain/);
  assert.match(output, /BASELINE \[unknown\]: \(none\)/);
  assert.match(output, /origin\/HEAD is not reliable/);
});

test("branch list allows pointer OID movement but rejects pending topology removal", () => {
  const origin = initBareUpstream();
  const movedCwd = initGitWorkspace();
  const movedDir = syncedSubmodule(movedCwd, "api", origin);
  git(movedDir, "commit", "--allow-empty", "-m", "move pointer");
  git(movedCwd, "add", "oms/api");
  const moved = run(["branch", "list", "api"], { cwd: movedCwd });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);

  const removalCwd = initGitWorkspace();
  syncedSubmodule(removalCwd, "api", origin);
  git(removalCwd, "rm", "--cached", "oms/api");
  const removal = run(["branch", "list", "api"], { cwd: removalCwd });
  assert.equal(removal.status, 1, removal.stdout + removal.stderr);
  assert.match(removal.stdout + removal.stderr, /inconsistent|pending/);
  assert.match(removal.stdout + removal.stderr, /oms sync api/);

  const conflictCwd = initGitWorkspace();
  syncedSubmodule(conflictCwd, "api", origin);
  const oid = gitOut(conflictCwd, "rev-parse", "HEAD:oms/api");
  const conflict = spawnSync("git", ["update-index", "--index-info"], {
    cwd: conflictCwd,
    env: testEnv,
    encoding: "utf8",
    input: `0 ${"0".repeat(40)}\toms/api\n160000 ${oid} 1\toms/api\n160000 ${oid} 2\toms/api\n160000 ${oid} 3\toms/api\n`,
  });
  assert.equal(conflict.status, 0, conflict.stderr);
  const conflicted = run(["branch", "list", "api"], { cwd: conflictCwd });
  assert.equal(conflicted.status, 1, conflicted.stdout + conflicted.stderr);
  assert.match(conflicted.stdout + conflicted.stderr, /inconsistent|conflict/);

  const missingMetadataCwd = initGitWorkspace();
  syncedSubmodule(missingMetadataCwd, "api", origin);
  rmSync(join(missingMetadataCwd, ".gitmodules"));
  const missingMetadata = run(["branch", "list", "api"], { cwd: missingMetadataCwd });
  assert.equal(missingMetadata.status, 1, missingMetadata.stdout + missingMetadata.stderr);
  assert.match(missingMetadata.stdout + missingMetadata.stderr, /inconsistent|pending/);
});

test("branch list initialization failure preserves partial state and redacts manifest credentials", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  const dir = syncedSubmodule(cwd, "api", origin);
  assert.equal(spawnSync("git", ["-C", cwd, "submodule", "deinit", "-f", "oms/api"], { env: testEnv }).status, 0);
  rmSync(join(cwd, ".git", "modules", "oms", "api"), { recursive: true, force: true });
  writeSources(cwd, "repos:\n  - alias: api\n    remotes:\n      origin: https://secret:token@example.invalid/private.git\n    branch: main\n");

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /automatic initialization failed/);
  assert.match(output, /partial state was preserved/);
  assert.match(output, /example\.invalid\/private\.git/);
  assert.doesNotMatch(output, /secret:token/);
  assert.equal(existsSync(join(dir, ".git")), false);
});

test("branch list preserves accepted sync precondition and operational exit codes", () => {
  const origin = initBareUpstream();
  const preconditionCwd = initGitWorkspace();
  writeSources(preconditionCwd, sourceFor("api", origin));
  mkdirSync(join(preconditionCwd, "oms"));
  mkdirSync(join(preconditionCwd, "oms", "api"));
  writeFileSync(join(preconditionCwd, "oms", "api", "occupied.txt"), "keep\n");
  const precondition = run(["branch", "list", "api"], {
    cwd: preconditionCwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  assert.equal(precondition.status, 1, precondition.stdout + precondition.stderr);
  assert.match(precondition.stdout + precondition.stderr, /occupied|preserved/);
  assert.equal(readFileSync(join(preconditionCwd, "oms", "api", "occupied.txt"), "utf8"), "keep\n");

  const operationalCwd = initGitWorkspace();
  writeSources(operationalCwd, "repos:\n  - alias: api\n    remotes:\n      origin: https://secret:token@example.invalid/private.git\n    branch: main\n");
  const operational = run(["branch", "list", "api"], {
    cwd: operationalCwd,
    env: queueEnv([{ type: "select", value: "sync" }]),
  });
  const output = operational.stdout + operational.stderr;
  assert.equal(operational.status, 2, output);
  assert.match(output, /sync and continue failed|submodule add failed/);
  assert.match(output, /example\.invalid\/private\.git/);
  assert.doesNotMatch(output, /secret:token/);
});

test("branch list keeps an exhausted declared remote with no cached refs visible as unavailable", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  syncedSubmodule(cwd, "api", origin);
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${origin}\n      missing: https://example.invalid/missing.git\n    branch: main\n`);

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /missing\tunavailable\t\(empty\)/);
  assert.match(output, /fetch failed twice|Could not resolve host/);
  assert.match(output, /origin\tfresh\tmain/);
});

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

  // The next root-mutating command completes the recovery and clears the state.
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

  // The next run cleans the uncommitted prepared state and finalizes normally.
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
