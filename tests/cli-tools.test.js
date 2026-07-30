import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

/**
 * Bump policy for `metadata.version` in skills/<name>/SKILL.md:
 *   major - the guardrail kernel or the scope contract changed (agent behaviour changes)
 *   minor - instructions or the description changed (when the skill fires, or what it tells the agent)
 *   patch - typo or wording only, no change in meaning
 *
 * A change to a skill's name, description, or body must be acknowledged here. The guard makes the
 * bump a deliberate, reviewable act rather than an enforced one: refreshing the hash without moving
 * the version still passes, and is meant to be caught in review. The hash deliberately excludes the
 * metadata block so bumping the version does not perturb its own hash. oms doctor compares an
 * installed copy's version against the version baked into the build, so a content change that skips
 * the bump would leave installed copies unreported.
 */
const SKILL_SNAPSHOTS = {
  "oms-workspace": { version: "1.1.0", contentHash: "656342eea5e0817ce67b3f571dd39c495fb035f25be37ad2041670c8a1463c70" },
  "oms-pointer": { version: "1.1.0", contentHash: "6bcf180ba49f8c4d463dcc63d9a5e7b59747b0308c8c6763881c4b0132f156a1" },
  "oms-branch": { version: "1.0.0", contentHash: "f76e37f5522ca57ac85b51d7b517992dd89096a4d7a6c2006ff3bfb730e735c7" },
};

function readSkill(name) {
  return readFileSync(resolve("skills", name, "SKILL.md"), "utf8");
}

/** Hashes a skill's meaningful content — name, description, and body — excluding the metadata block. */
function skillContentHash(name) {
  const { frontmatter, body } = splitSkillFrontmatter(readSkill(name));
  const data = parseYaml(frontmatter);
  return createHash("sha256").update(`${data.name}\n${data.description}\n${body}`).digest("hex");
}

function splitSkillFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "SKILL.md must open with a --- frontmatter --- block");
  return { frontmatter: m[1], body: m[2] };
}

test("each oms skill is published with name/description/metadata frontmatter", () => {
  // SKILL_NAMES drives every skill assertion in this file, so a newly published skill must land
  // here rather than shipping unchecked — an unchecked version reaches dist/build-info.json.
  const published = readdirSync(resolve("skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(published, [...SKILL_NAMES].sort(), "add any new skills/<name>/ to SKILL_NAMES");

  for (const name of SKILL_NAMES) {
    const { frontmatter, body } = splitSkillFrontmatter(readSkill(name));
    const data = parseYaml(frontmatter);
    assert.equal(typeof data.name, "string", `${name}: name must be a string`);
    assert.ok(data.name.length > 0, `${name}: name must be non-empty`);
    assert.equal(data.name, name, `${name}: frontmatter name must match its directory`);
    assert.equal(typeof data.description, "string", `${name}: description must be a string`);
    assert.ok(data.description.length > 0, `${name}: description must be non-empty`);

    assert.ok(data.metadata && typeof data.metadata === "object", `${name}: metadata must be a block`);
    assert.equal(typeof data.metadata.author, "string", `${name}: metadata.author must be a string`);
    assert.ok(data.metadata.author.length > 0, `${name}: metadata.author must be non-empty`);
    // A YAML number would be dropped by the skills tool's eve install path, which keeps only
    // string-valued metadata entries; quoting the version is what makes the marker survive.
    assert.equal(typeof data.metadata.version, "string", `${name}: metadata.version must be a quoted string`);
    assert.ok(
      semver.valid(data.metadata.version),
      `${name}: metadata.version must be valid semver, got ${data.metadata.version}`,
    );

    // The skill's own version is frontmatter for oms doctor to read. The body declares only the
    // oms status --json schemaVersion, which is an instruction to the agent.
    assert.doesNotMatch(
      body,
      versionPattern(data.metadata.version),
      `${name}: body must not declare the skill's own version`,
    );
  }
});

test("a skill content change must be acknowledged in SKILL_SNAPSHOTS", () => {
  for (const name of SKILL_NAMES) {
    const snapshot = SKILL_SNAPSHOTS[name];
    assert.ok(snapshot, `${name}: add an entry to SKILL_SNAPSHOTS`);
    const version = parseYaml(splitSkillFrontmatter(readSkill(name)).frontmatter).metadata.version;
    assert.equal(
      version,
      snapshot.version,
      `${name}: SKILL_SNAPSHOTS records ${snapshot.version} but metadata.version is ${version}; keep them in step`,
    );
    assert.equal(
      skillContentHash(name),
      snapshot.contentHash,
      `${name}: content changed while metadata.version is still ${version} — bump the version per the ` +
        "policy on SKILL_SNAPSHOTS, then update its recorded version and contentHash",
    );
  }
});

// --- skill version drift reporting ---

// A fixed reference so a future metadata.version bump cannot invalidate these fixtures.
const SKILL_REFERENCE = JSON.stringify({ "oms-workspace": "1.1.0", "oms-pointer": "1.1.0", "oms-branch": "1.1.0" });

/**
 * Builds a fake skills-tool home. `installed` maps a skill name to the version its SKILL.md declares,
 * or null for a copy carrying no metadata block — how every install predating the marker looks.
 * `locked` defaults to the installed names; pass it to record an install whose file is absent, and
 * `source` to forge a lock entry from somewhere other than the oms repository.
 */
function fakeSkillsHome({ installed = {}, agentDir = ".claude", locked, source = "divlook/oh-my-space", lockBody } = {}) {
  const home = tempFixture("oms-skills-");
  for (const [name, version] of Object.entries(installed)) {
    const dir = join(home, agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    const metadata = version === null ? "" : `metadata:\n  author: oh-my-space\n  version: "${version}"\n`;
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n${metadata}---\n\nbody\n`);
  }
  const lockNames = locked ?? Object.keys(installed);
  if (lockBody !== undefined || lockNames.length > 0) {
    mkdirSync(join(home, ".agents"), { recursive: true });
    const body = lockBody ?? JSON.stringify({
      version: 3,
      skills: Object.fromEntries(lockNames.map((name) => [name, { source, sourceType: "github" }])),
    });
    writeFileSync(join(home, ".agents", ".skill-lock.json"), body);
  }
  return home;
}

function driftEnv(home, overrides = {}) {
  return {
    ...testEnv,
    OMS_TEST_MODE: "1",
    OMS_TEST_SKILLS_HOME: home,
    OMS_TEST_SKILL_VERSIONS: SKILL_REFERENCE,
    ...overrides,
  };
}

/** Runs doctor in an existing git workspace with the drift check pointed at a fake skills home. */
function doctorWithSkills(cwd, home, overrides = {}) {
  const result = run(["doctor"], { cwd, env: driftEnv(home, overrides) });
  return { result, output: result.stdout + result.stderr };
}

test("doctor reports an older installed skill and names the skills update command", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const home = fakeSkillsHome({ installed: { "oms-branch": "1.0.0", "oms-pointer": "1.1.0" } });

  const { result, output } = doctorWithSkills(cwd, home);
  assert.equal(result.status, 0, output);
  assert.match(output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(global\)/);
  assert.match(output, /Update: npx skills update oms-branch/);
  // A matching install is not mentioned, and no scope flag is suggested.
  assert.doesNotMatch(output, /oms-pointer/);
  assert.doesNotMatch(output, /npx skills update[^\n]*-[gp]\b/);
});

test("doctor reports a newer installed skill separately and names oms update", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const home = fakeSkillsHome({ installed: { "oms-branch": "2.0.0", "oms-workspace": "1.0.0" } });

  const { result, output } = doctorWithSkills(cwd, home);
  assert.equal(result.status, 0, output);
  assert.match(output, /oms-branch: skill 2\.0\.0 is newer than this oms knows \(1\.1\.0\) \(global\)/);
  assert.match(output, /Your oms may be behind these skills\. Update: oms update/);
  // The older skill keeps its own remediation, and the newer one is not folded into it.
  assert.match(output, /Update: npx skills update oms-workspace/);
  assert.doesNotMatch(output, /npx skills update[^\n]*oms-branch/);
});

test("doctor treats a missing or malformed installed version as older", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);

  const missing = doctorWithSkills(cwd, fakeSkillsHome({ installed: { "oms-branch": null } }));
  assert.equal(missing.result.status, 0, missing.output);
  assert.match(missing.output, /oms-branch: skill version unknown, current is 1\.1\.0 \(global\)/);
  assert.match(missing.output, /Update: npx skills update oms-branch/);

  const malformed = doctorWithSkills(cwd, fakeSkillsHome({ installed: { "oms-branch": "not-semver" } }));
  assert.equal(malformed.result.status, 0, malformed.output);
  assert.match(malformed.output, /oms-branch: skill version unknown, current is 1\.1\.0 \(global\)/);
});

test("doctor reports a locked skill whose file cannot be located", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const home = fakeSkillsHome({ installed: {}, locked: ["oms-branch"] });

  const { result, output } = doctorWithSkills(cwd, home);
  assert.equal(result.status, 0, output);
  assert.match(output, /oms-branch: installed but its version could not be verified \(global\)/);
  assert.match(output, /Update: npx skills update oms-branch/);
});

test("doctor stays silent when skills match, are absent, or the baked reference is missing", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);

  const matching = doctorWithSkills(cwd, fakeSkillsHome({ installed: { "oms-branch": "1.1.0" } }));
  assert.equal(matching.result.status, 0, matching.output);
  assert.doesNotMatch(matching.output, /oms-branch|npx skills update/);

  const absent = doctorWithSkills(cwd, fakeSkillsHome());
  assert.equal(absent.result.status, 0, absent.output);
  assert.doesNotMatch(absent.output, /oms-branch|npx skills update/);

  // No baked reference (a build without skills/) must not report a thing.
  const drifted = fakeSkillsHome({ installed: { "oms-branch": "1.0.0" } });
  const unreferenced = doctorWithSkills(cwd, drifted, { OMS_TEST_SKILL_VERSIONS: "" });
  assert.equal(unreferenced.result.status, 0, unreferenced.output);
  assert.doesNotMatch(unreferenced.output, /oms-branch|npx skills update/);
});

test("doctor reports only the skills that are installed", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const home = fakeSkillsHome({ installed: { "oms-pointer": "1.0.0" } });

  const { result, output } = doctorWithSkills(cwd, home);
  assert.equal(result.status, 0, output);
  assert.match(output, /Update: npx skills update oms-pointer$/m);
  assert.doesNotMatch(output, /oms-branch|oms-workspace/);
});

test("doctor finds installs in the canonical directory and in an agent directory alike", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);

  for (const agentDir of [".agents", ".claude", ".cursor"]) {
    const home = fakeSkillsHome({ installed: { "oms-branch": "1.0.0" }, agentDir });
    const { result, output } = doctorWithSkills(cwd, home);
    assert.equal(result.status, 0, output);
    assert.match(output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(global\)/, `not found under ${agentDir}`);
  }
});

test("doctor ignores a lock entry from another source but still reads the file when the lock is unusable", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);

  // Provenance excludes a same-named skill published by someone else.
  const foreign = fakeSkillsHome({ installed: {}, locked: ["oms-branch"], source: "someone/else" });
  const excluded = doctorWithSkills(cwd, foreign);
  assert.equal(excluded.result.status, 0, excluded.output);
  assert.doesNotMatch(excluded.output, /oms-branch/);

  // An unparseable lock degrades to the filesystem search rather than losing the feature.
  const brokenLock = fakeSkillsHome({ installed: { "oms-branch": "1.0.0" }, lockBody: "{ not json" });
  const tolerated = doctorWithSkills(cwd, brokenLock);
  assert.equal(tolerated.result.status, 0, tolerated.output);
  assert.match(tolerated.output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(global\)/);
});

/** Installs a skill into the workspace itself, the layout a project-scope install produces. */
function installProjectSkill(cwd, name, version) {
  const skillDir = join(cwd, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\nmetadata:\n  author: oh-my-space\n  version: "${version}"\n---\n\nbody\n`,
  );
}

test("doctor reports a project-scope install with the project scope", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  installProjectSkill(cwd, "oms-branch", "1.0.0");

  const { result, output } = doctorWithSkills(cwd, fakeSkillsHome());
  assert.equal(result.status, 0, output);
  assert.match(output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(project\)/);
});

test("doctor merges scopes that drifted alike and splits scopes at different versions", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);

  // Same version in both scopes collapses to one line naming both.
  installProjectSkill(cwd, "oms-branch", "1.0.0");
  const merged = doctorWithSkills(cwd, fakeSkillsHome({ installed: { "oms-branch": "1.0.0" } }));
  assert.equal(merged.result.status, 0, merged.output);
  assert.match(merged.output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(global, project\)/);
  assert.equal(merged.output.match(/oms-branch: skill/g).length, 1, "one line should cover both scopes");
  assert.equal(merged.output.match(/npx skills update/g).length, 1, "one remediation line");

  // Different versions per scope stay distinct, and the skill is named once in the remedy.
  installProjectSkill(cwd, "oms-branch", "0.9.0");
  const split = doctorWithSkills(cwd, fakeSkillsHome({ installed: { "oms-branch": "1.0.0" } }));
  assert.equal(split.result.status, 0, split.output);
  assert.match(split.output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(global\)/);
  assert.match(split.output, /oms-branch: skill 0\.9\.0 is older than 1\.1\.0 \(project\)/);
  assert.match(split.output, /Update: npx skills update oms-branch$/m);
});

test("doctor skips a baked version that is not valid semver instead of failing", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const home = fakeSkillsHome({ installed: { "oms-branch": "1.0.0", "oms-pointer": "1.0.0" } });

  // The reference is a build artifact; a bad entry must not turn an informational report into
  // a non-zero exit, and must not suppress the entries that are usable.
  const { result, output } = doctorWithSkills(cwd, home, {
    OMS_TEST_SKILL_VERSIONS: JSON.stringify({ "oms-branch": "1.1", "oms-pointer": "1.1.0" }),
  });
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /Invalid Version/);
  assert.doesNotMatch(output, /oms-branch/);
  assert.match(output, /oms-pointer: skill 1\.0\.0 is older than 1\.1\.0 \(global\)/);
});

test("update does not point at doctor for a locked skill this build does not publish", () => {
  // omsSkillsInstalled must agree with what doctor would actually report, or the hint is a dead end.
  const home = fakeSkillsHome({ installed: {}, locked: ["oms-retired"] });
  const result = run(["update", "--yes"], {
    cwd: tempWorkspace(),
    env: driftEnv(home, {
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: newerVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
      OMS_TEST_VERIFY_VERSION: newerVersion,
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Update command completed/);
  assert.doesNotMatch(output, /skill/i);
});

test("update reports skill drift on the up-to-date path where its reference is exact", () => {
  const home = fakeSkillsHome({ installed: { "oms-branch": "1.0.0" } });
  const result = run(["update"], {
    cwd: tempWorkspace(),
    env: driftEnv(home, {
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: currentVersion } }),
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /oms-branch: skill 1\.0\.0 is older than 1\.1\.0 \(global\)/);
  assert.match(output, /Update: npx skills update oms-branch/);
  assert.match(output, /up to date/i);
});

test("update points at doctor after upgrading instead of guessing the new reference", () => {
  const home = fakeSkillsHome({ installed: { "oms-branch": "1.0.0" } });
  const result = run(["update", "--yes"], {
    cwd: tempWorkspace(),
    env: driftEnv(home, {
      OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({ "dist-tags": { latest: newerVersion } }),
      OMS_TEST_INSTALL_CONTEXT: installContext("global", {
        updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      }),
      OMS_TEST_MANAGER_AVAILABLE: "1",
      OMS_TEST_UPDATE_EXIT: "0",
      OMS_TEST_VERIFY_VERSION: newerVersion,
    }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /Update command completed/);
  assert.match(output, /oms skills are installed\. Run "oms doctor"/);
  // The old binary cannot know the new versions, so it must not claim a comparison.
  assert.doesNotMatch(output, /is older than|npx skills update/);
});

test("update says nothing about skills when none are installed", () => {
  const home = fakeSkillsHome();
  for (const args of [["update"], ["update", "--yes"]]) {
    const result = run(args, {
      cwd: tempWorkspace(),
      env: driftEnv(home, {
        OMS_TEST_REGISTRY_RESPONSE: JSON.stringify({
          "dist-tags": { latest: args.length > 1 ? newerVersion : currentVersion },
        }),
        OMS_TEST_INSTALL_CONTEXT: installContext("global", {
          updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
        }),
        OMS_TEST_MANAGER_AVAILABLE: "1",
        OMS_TEST_UPDATE_EXIT: "0",
        OMS_TEST_VERIFY_VERSION: newerVersion,
      }),
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /skill/i, `${args.join(" ")} mentioned skills`);
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
