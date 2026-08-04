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
import {
  cli,
  publishBetaScript,
  testEnv,
  currentVersion,
  newerVersion,
  run,
  versionPattern,
  updateEnv,
  installContext,
  tempFixture,
  tempWorkspace,
  writeSources,
  git,
  configIdentity,
  initBareUpstream,
  initGitWorkspace,
  gitOut,
  initEmptyBare,
  sourceFor,
  gitTopLevelStubEnv,
  workspaceWithApi,
  statusJson,
  workspaceWithMovedApi,
  sourcesFor,
  gitmodulesSectionCount,
  syncedSubmodule,
} from "./helpers.js";

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
  for (const [args, detail] of [
    [["branch", "--help"], /\bswitch\b.*\bcheckout\b.*\blist\b.*\bdelete\b/s],
    [["branch", "switch", "--help"], /--from/],
    [["branch", "checkout", "--help"], /REMOTE|origin/],
    [["branch", "list", "--help"], /stale|cached/],
    [["branch", "delete", "--help"], /--force/],
    [["fetch", "--help"], /root Git top-level/],
    [["pull", "--help"], /root Git top-level/],
    [["push", "--help"], /root Git top-level/],
    [["unsync", "--help"], /root Git top-level/],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /root Git top-level/, args.join(" "));
    assert.match(result.stdout, detail, args.join(" "));
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
  const stubDir = tempFixture("oms-git-stub-");
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
