import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";

// Shared fixtures and helpers used across the split cli test files.
export const cli = resolve("dist/oms.js");
export const publishBetaScript = resolve("scripts/publish-beta.mjs");

export const testEnv = {
  ...process.env,
  // Allow file-protocol clones, keep test commits unsigned, and provide a commit
  // identity so commits succeed even on hosts (CI) without a global git identity.
  // These are process-scoped (GIT_CONFIG_*), never written to disk.
  // init.defaultBranch is pinned so that a bare `git init` HEAD never depends on the
  // host's global git config; "master" reproduces the CI default, which differs from
  // the baseline branch and would surface any regression that relies on that coincidence.
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "user.email",
  GIT_CONFIG_VALUE_2: "test@example.com",
  GIT_CONFIG_KEY_3: "user.name",
  GIT_CONFIG_VALUE_3: "Test",
  GIT_CONFIG_KEY_4: "init.defaultBranch",
  GIT_CONFIG_VALUE_4: "master",
};

export function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: testEnv,
    ...options,
  });
}

// Read the version under test so release bumps do not invalidate these fixtures.
export const currentVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
// A registry latest strictly newer than the installed version.
export const newerVersion = semver.inc(currentVersion, "patch");

// Escapes dots so embedded version strings match literally.
export function versionPattern(text) {
  return new RegExp(text.replaceAll(".", "\\."));
}

export function updateEnv(overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: newerVersion } }),
    ...overrides,
  };
}

export function installContext(kind, extra = {}) {
  return JSON.stringify({
    kind,
    label: `${kind} test install`,
    guidance: [`guidance for ${kind}`],
    warnings: [],
    ...extra,
  });
}

export function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "oms-test-"));
}

export function writeSources(cwd, content) {
  writeFileSync(
    join(cwd, "oms.yaml"),
    content
      ?? "repos:\n  - alias: sample\n    remotes:\n      origin: git@example.com:org/repo.git\n    branch: main\n",
  );
}

export function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: testEnv });
}

export function configIdentity(cwd) {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
}

/**
 * Create a bare upstream + a seed repo that pushes branches into it.
 * Returns the bare repo path. Optionally creates additional branches.
 */
export function initBareUpstream({ branches = ["main"] } = {}) {
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
export function initGitWorkspace() {
  const cwd = tempWorkspace();
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "ignore", env: testEnv });
  configIdentity(cwd);
  git(cwd, "commit", "--allow-empty", "-m", "init");
  return cwd;
}

export function gitOut(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: testEnv }).trim();
}

export function clearProvenStaleWorkspaceLock(cwd) {
  rmSync(join(cwd, ".oms-mutation.lock"), { force: true });
}

export function snapshotDirectory(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = path.slice(root.length + 1);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push([relativePath, "directory", stat.mode & 0o7777]);
        visit(path);
      } else if (stat.isSymbolicLink()) {
        entries.push([relativePath, "symlink", realpathSync(path)]);
      } else {
        entries.push([relativePath, "file", stat.mode & 0o7777, createHash("sha256").update(readFileSync(path)).digest("hex")]);
      }
    }
  };
  visit(root);
  return entries;
}

/** An empty bare repo — a valid push target that shares no history with the seeded origin. */
export function initEmptyBare() {
  const bare = mkdtempSync(join(tmpdir(), "oms-source-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore", env: testEnv });
  return bare;
}

export function sourceFor(alias, bare, branch = "main", extraRemotes = {}) {
  const remoteLines = [`      origin: file://${bare}`];
  for (const [name, url] of Object.entries(extraRemotes)) {
    remoteLines.push(`      ${name}: file://${url}`);
  }
  return `repos:\n  - alias: ${alias}\n    remotes:\n${remoteLines.join("\n")}\n    branch: ${branch}\n`;
}

export function gitTopLevelStubEnv(mode) {
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

export const sharedPreflightCommands = [
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

/** A workspace with `api` synced and its initial gitlink recorded in the root HEAD. */
export function workspaceWithApi() {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add api submodule");
  return { cwd, bare, wt: join(cwd, "oms", "api") };
}

/** Parse the JSON object a `status --json` run wrote to stdout, asserting a clean exit. */
export function statusJson(cwd, args = [], expectStatus = 0) {
  const result = run(["status", "--json", ...args], { cwd });
  assert.equal(result.status, expectStatus, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

export function workspaceWithMovedApi() {
  const { cwd, bare } = workspaceWithApi();
  const wt = join(cwd, "oms", "api");
  writeFileSync(join(wt, "f.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
  return { cwd, bare, wt };
}

export const skipUnreadable =
  typeof process.getuid === "function" && process.getuid() === 0
    ? { skip: "chmod 0o000 is not enforced when running as root" }
    : {};

export function agentWorkspace() {
  const cwd = tempWorkspace();
  writeSources(cwd);
  return cwd;
}

export function sourcesFor(entries) {
  const body = entries
    .map(({ alias, bare }) => `  - alias: ${alias}\n    remotes:\n      origin: file://${bare}\n    branch: main`)
    .join("\n");
  return `repos:\n${body}\n`;
}

/** Count submodule.*.path entries remaining in .gitmodules (0 when the file is gone). */
export function gitmodulesSectionCount(cwd) {
  const path = join(cwd, ".gitmodules");
  if (!existsSync(path)) return 0;
  const r = spawnSync("git", ["config", "--file", path, "--get-regexp", "^submodule\\..*\\.path$"], {
    encoding: "utf8",
    env: testEnv,
  });
  if (r.status !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

/** A stand-in for npx that records the args and cwd it was invoked with, then exits with `exit`. */
export function makeFakeNpx(dir, { exit = 0 } = {}) {
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

export function skillsEnv(npxBin, overrides = {}) {
  return { ...testEnv, OMS_TEST_MODE: "1", OMS_NPX_BIN: npxBin, ...overrides };
}

// The canonical scope-guardrail kernel, identical to OMS_SCOPE_GUARDRAIL in scripts/oms.ts.
// Pinned to the source constant below via the marker-block assertion, so it cannot silently drift.
export const SKILL_KERNEL = [
  "- Run `oms status --json` before Git work involving `.oms/` or `oms/`; require schemaVersion 2 and use `oms status --help` if another version appears.",
  "- Read `mode`, `currentTarget`, the root relation, and each repository discriminator before choosing a Git scope.",
  "- Treat root operations, alias-scoped repository operations, and worktree-mode `alias/name` checkout operations as different scopes; never guess.",
  "- In submodule mode, record an existing pointer only when the user explicitly runs `oms record <alias>`; worktree mode has no root pointer record.",
  "- Check `oms <command> --help` for exact mode-specific targets, flags, and recovery behavior.",
].join("\n");

export const SKILL_NAMES = ["oms-workspace", "oms-pointer", "oms-branch"];

export function readSkill(name) {
  return readFileSync(resolve("skills", name, "SKILL.md"), "utf8");
}

export function splitSkillFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "SKILL.md must open with a --- frontmatter --- block");
  return { frontmatter: m[1], body: m[2] };
}

/** Env with the guarded test-response queue active. */
export function queueEnv(responses, overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_PROMPT_RESPONSES: JSON.stringify(responses),
    ...overrides,
  };
}

/** Whether a local branch ref exists in the given working-tree directory. */
export function localBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    env: testEnv,
  }).status === 0;
}

/** Whether a remote-tracking ref origin/<branch> exists in the given directory. */
export function remoteBranchExists(dir, branch) {
  return spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
    env: testEnv,
  }).status === 0;
}

/** Sync one alias and return the submodule working-tree path. */
export function syncedSubmodule(cwd, alias, bare, branch = "main") {
  writeSources(cwd, sourceFor(alias, bare, branch));
  assert.equal(run(["sync", alias, "--commit"], { cwd }).status, 0);
  return join(cwd, "oms", alias);
}
