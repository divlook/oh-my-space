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
