import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  testEnv,
  run,
  tempFixture,
  tempWorkspace,
  writeSources,
  git,
  configIdentity,
  initBareUpstream,
  initGitWorkspace,
  gitOut,
  sourceFor,
  gitTopLevelStubEnv,
  workspaceWithApi,
} from "./helpers.js";


test("help is exposed as oms with independent checkout commands", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: oms/);
  assert.match(result.stdout, /independent Git clones/);
  for (const command of ["init", "clone", "remove", "migrate", "status", "commit", "branch", "agent", "skills", "update", "tree"]) {
    assert.match(result.stdout, new RegExp(`^  ${command}\\b`, "m"));
  }
  assert.doesNotMatch(result.stdout, /^  (?:sync|unsync|record|worktree)\b/m);

  const branch = run(["branch", "--help"]);
  assert.equal(branch.status, 0, branch.stdout + branch.stderr);
  assert.match(branch.stdout, /^  switch\b/m);
  assert.match(branch.stdout, /^  checkout\b/m);
});

test("production CLI rejects removed commands and topology flags without changing repositories", () => {
  const { cwd, wt } = workspaceWithApi();
  const manifest = readFileSync(join(cwd, "oms.yaml"), "utf8");
  const paths = [cwd, wt];
  const snapshot = () => paths.map((dir) => ({
    head: gitOut(dir, "rev-parse", "HEAD"),
    refs: gitOut(dir, "show-ref"),
    index: gitOut(dir, "ls-files", "--stage"),
    changes: gitOut(dir, "status", "--porcelain"),
  }));
  const before = snapshot();
  for (const command of ["sync", "unsync", "record"]) {
    const result = run([command, "api"], { cwd });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`unknown command '${command}'`));
    assert.match(result.stderr, /oms migrate --dry-run/);
  }
  for (const command of ["clone", "remove"]) {
    for (const flag of ["--commit", "--no-commit"]) {
      const result = run([command, "api", flag], { cwd });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`unknown option '${flag}'`));
    }
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(readFileSync(join(cwd, "oms.yaml"), "utf8"), manifest);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
});

test("normal commands reject legacy registration settings and direct the user to migration", () => {
  const { cwd, wt } = workspaceWithApi();
  const original = readFileSync(join(cwd, "oms.yaml"), "utf8");
  const checkout = gitOut(wt, "rev-parse", "HEAD");
  for (const value of [true, false]) {
    const legacy = `autoCommitRegistration: ${value}\n${original}`;
    writeFileSync(join(cwd, "oms.yaml"), legacy);
    for (const args of [["clone", "--list"], ["clone", "api"], ["status", "--json"], ["remove", "api", "--yes"]]) {
      const result = run(args, { cwd });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 1, output);
      assert.match(output, /autoCommitRegistration is a legacy setting/);
      assert.match(output, /oms migrate --dry-run/);
    }
    assert.equal(readFileSync(join(cwd, "oms.yaml"), "utf8"), legacy);
    assert.equal(gitOut(wt, "rev-parse", "HEAD"), checkout);
  }
});


test("init scaffolds oms.yaml with the schema comment and does not gitignore oms/", () => {
  const cwd = tempWorkspace();
  const result = run(["init"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /run "git init" here/i);
  assert.match(output, /oms clone --all/);

  const manifest = readFileSync(join(cwd, "oms.yaml"), "utf8");
  assert.match(
    manifest,
    /# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/divlook\/oh-my-space\/main\/oms\.schema\.json/,
  );
  assert.match(manifest, /alias: example/);
  assert.doesNotMatch(manifest, /autoCommitRegistration/);

  if (existsSync(join(cwd, ".gitignore"))) {
    assert.doesNotMatch(readFileSync(join(cwd, ".gitignore"), "utf8"), /^oms\/$/m);
  }
  assert.equal(existsSync(join(cwd, "oms", "AGENTS.md")), false);
  assert.equal(existsSync(join(cwd, "oms", "CLAUDE.md")), false);
});

test("init preserves existing ignore rules rather than rewriting them", () => {
  const cwd = tempWorkspace();
  writeFileSync(join(cwd, ".gitignore"), "node_modules/\n# managed by oms\noms/\n");
  const result = run(["init"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gi = readFileSync(join(cwd, ".gitignore"), "utf8");
  assert.equal(gi, "node_modules/\n# managed by oms\noms/\n");
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


test("doctor accepts the init-generated oms.yaml", () => {
  const cwd = tempWorkspace();
  assert.equal(run(["init"], { cwd }).status, 0);
  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.ok(result.status === 0 || result.status === 2, output);
  assert.doesNotMatch(output, /must have at least one item/);
  assert.match(output, /1 repo\(s\) configured/);
});

test("clone --list loads oms.yaml from a parent workspace (no git repo needed)", () => {
  const cwd = tempWorkspace();
  mkdirSync(join(cwd, "nested"));
  writeSources(cwd);

  const result = run(["clone", "--list"], { cwd: join(cwd, "nested") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sample/);
  assert.match(result.stdout, /git@example.com:org\/repo.git/);
  assert.match(result.stdout, /main/);
});


test("workspace discovery rejects a nearest directory candidate without ancestor fallback", () => {
  assertNearestManifestRefusal((path) => mkdirSync(path));
});

test("workspace discovery rejects a nearest broken symbolic link candidate without ancestor fallback", () => {
  assertNearestManifestRefusal((path) => symlinkSync(join(dirname(path), "missing.yaml"), path));
});

test("workspace discovery rejects a nearest symbolic link to a directory candidate without ancestor fallback", () => {
  assertNearestManifestRefusal((path) => {
    const target = join(dirname(path), "manifest-dir");
    mkdirSync(target);
    symlinkSync(target, path);
  });
});

function assertNearestManifestRefusal(createCandidate) {
  const outer = tempWorkspace();
  const inner = join(outer, "nested");
  mkdirSync(inner);
  writeSources(outer, sourceFor("outer", "/tmp/outer"));
  createCandidate(join(inner, "oms.yaml"));

  const result = run(["clone", "--list"], { cwd: inner });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /regular file|broken symbolic link/);
  assert.match(output, /will not fall back/);
  assert.doesNotMatch(result.stdout, /outer/);
}


test("missing oms.yaml fails with creation guidance", () => {
  const cwd = tempWorkspace();
  const result = run(["clone", "--list"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  assert.match(output, /Could not find oms\.yaml/);
  assert.match(output, /Create a oms\.yaml/);
});


test("clone outside a git repository fails with git init guidance", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, sourceFor("probe", bare));
  const result = run(["clone", "probe"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /not a Git workspace/);
  assert.match(output, /git init/);
  assert.equal(existsSync(join(cwd, "oms")), false);
});

const sharedPreflightCommands = [
  ["status"],
  ["commit", "sample", "-m", "test"],
  ["branch", "switch", "sample", "main"],
  ["branch", "checkout", "sample", "main"],
  ["branch", "list", "sample"],
  ["branch", "delete", "sample", "feature"],
  ["fetch", "sample"],
  ["pull", "sample"],
  ["push", "sample"],
  ["remove", "sample"],
];

test("source commands reject a nested manifest before root or workspace side effects", () => {
  const root = initGitWorkspace();
  const nested = join(root, "nested");
  mkdirSync(nested);
  writeSources(nested);
  const rootStatus = gitOut(root, "status", "--porcelain");

  for (const args of [["clone", "sample"], ...sharedPreflightCommands]) {
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

test("source commands accept canonical-equivalent workspace paths", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const linkParent = tempWorkspace();
  const linked = join(linkParent, "workspace");
  symlinkSync(cwd, linked);

  const result = run(["status"], { cwd: linked });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /does not match the root Git top-level/);
});

test("source commands fail closed when Git top-level inspection is indeterminate", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const rootStatus = gitOut(cwd, "status", "--porcelain");

  for (const env of [gitTopLevelStubEnv("failure"), gitTopLevelStubEnv("missing-path")]) {
    const result = run(["clone", "sample"], { cwd, env });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    assert.match(output, /Could not verify/);
    assert.equal(existsSync(join(cwd, ".gitmodules")), false);
    assert.equal(existsSync(join(cwd, "oms")), false);
    assert.equal(gitOut(cwd, "status", "--porcelain"), rootStatus);
  }
});

test("shared source commands fail without side effects outside a Git work tree", () => {
  const cwd = tempWorkspace();
  writeSources(cwd);

  for (const args of sharedPreflightCommands) {
    const result = run(args, { cwd });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, `${args.join(" ")}\n${output}`);
    assert.match(output, /not a Git workspace/);
    assert.equal(existsSync(join(cwd, ".gitmodules")), false);
    assert.equal(existsSync(join(cwd, "oms")), false);
  }
});

test("remove rejects an alias with no current or verified former declaration", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const result = run(["remove", "missing", "--yes"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /missing: no former declaration can be verified/);
  assert.match(output, /No checkout was removed/);
});

test("remove on a never-cloned alias reports nothing to remove with exit 0", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const result = run(["remove", "sample"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /sample: already absent/);
});



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
  assert.match(output, /not a Git workspace/);
  assert.match(output, /git init/);
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

test("doctor reports a healthy independent checkout after clone", () => {
  const { cwd } = workspaceWithApi();

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /api: independent checkout OK \(branch=main\)/);
});

test("doctor warns when .gitignore still excludes oms/", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  writeFileSync(join(cwd, ".gitignore"), "oms/\n");

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /Root ignore rules hide all of oms\/, including agent instruction files/);
  assert.match(output, /alias-specific ignores/);
  assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "oms/\n");
});

test("doctor warns when git is older than the recommended 2.40", () => {
  const { cwd } = workspaceWithApi();
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
