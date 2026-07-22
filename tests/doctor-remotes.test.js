import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, tempWorkspace, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, snapshotDirectory, initEmptyBare, sourceFor, queueEnv } from "./helpers.js";
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

test("doctor warns when git is older than the required 2.48", () => {
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
  assert.match(output, /git 2\.30 is older than the required 2\.48/);
});

test("init rejects Git older than 2.48 before writing", () => {
  const cwd = tempWorkspace();
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "git version 2.47.9"; exit 0; fi\nexec ${realGit} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);
  const result = run(["init", "--mode", "worktree"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Git 2\.48 or newer is required/);
  assert.equal(existsSync(join(cwd, "oms.yaml")), false);
});

test("the first post-init mutation creates one workspace identity and excludes control files", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);

  const ownershipPath = join(cwd, ".oms", "workspace.json");
  const first = readFileSync(ownershipPath, "utf8");
  const ownership = JSON.parse(first);
  assert.match(ownership.workspaceId, /^[0-9a-f-]{36}$/);
  assert.equal(existsSync(join(cwd, ".oms-mutation.lock")), false);
  assert.equal(gitOut(cwd, "status", "--porcelain", "--", ".oms", ".oms-mutation.lock"), "");

  assert.equal(run(["fetch", "api"], { cwd }).status, 0);
  assert.equal(readFileSync(ownershipPath, "utf8"), first);
});

test("a workspace mutation lock conflict leaves manifest, identity, and Git state unchanged", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const manifestBefore = readFileSync(join(cwd, "oms.yaml"), "utf8");
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");
  const indexBefore = readFileSync(join(cwd, ".git", "index"));
  writeFileSync(join(cwd, ".oms-mutation.lock"), "occupied\n");

  const result = run(["sync", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Another OMS mutation owns/);
  assert.equal(readFileSync(join(cwd, "oms.yaml"), "utf8"), manifestBefore);
  assert.equal(existsSync(join(cwd, ".oms", "workspace.json")), false);
  assert.equal(readFileSync(join(cwd, ".oms-mutation.lock"), "utf8"), "occupied\n");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), indexBefore);
  assert.equal(existsSync(join(cwd, "oms", "api")), false);
});

test("representative mutation-lock conflicts leave worktree files, refs, and topology unchanged", () => {
  const bare = initBareUpstream({ branches: ["main", "dev"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  assert.equal(run(["worktree", "add", "api", "dev"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const main = join(cwd, "oms", "api", "main");
  const manifestBefore = readFileSync(join(cwd, "oms.yaml"));
  const ownershipBefore = readFileSync(join(cwd, ".oms", "workspace.json"));
  const refsBefore = gitOut(common, "show-ref");
  const headBefore = gitOut(main, "rev-parse", "HEAD");
  const statusBefore = gitOut(main, "status", "--porcelain=v1", "--untracked-files=all");
  writeFileSync(join(cwd, ".oms-mutation.lock"), "occupied\n");

  const commands = [
    ["sync", "api"],
    ["unsync", "api"],
    ["worktree", "add", "api", "locked-branch", "--from", "main"],
    ["worktree", "move", "api/main", "moved"],
    ["worktree", "remove", "api/main"],
    ["commit", "api/main", "-m", "test: locked"],
    ["record", "api"],
    ["fetch", "api"],
    ["pull", "api/main"],
    ["push", "api/main"],
    ["branch", "switch", "api/main", "locked-branch", "--from", "main"],
    ["branch", "checkout", "api/main", "dev"],
    ["branch", "delete", "api", "dev"],
    ["mode", "switch", "submodule", "--no-sync"],
  ];
  for (const args of commands) {
    const result = run(args, { cwd });
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /Another OMS mutation owns/, args.join(" "));
    assert.deepEqual(readFileSync(join(cwd, "oms.yaml")), manifestBefore);
    assert.deepEqual(readFileSync(join(cwd, ".oms", "workspace.json")), ownershipBefore);
    assert.equal(gitOut(common, "show-ref"), refsBefore);
    assert.equal(gitOut(main, "rev-parse", "HEAD"), headBefore);
    assert.equal(gitOut(main, "status", "--porcelain=v1", "--untracked-files=all"), statusBefore);
    assert.equal(readFileSync(join(cwd, ".oms-mutation.lock"), "utf8"), "occupied\n");
  }
});

test("init and root record lock conflicts refuse before manifest or index mutation", () => {
  const initRoot = tempWorkspace();
  writeFileSync(join(initRoot, ".oms-mutation.lock"), "occupied\n");
  const initResult = run(["init", "--mode", "worktree"], { cwd: initRoot });
  assert.equal(initResult.status, 1, initResult.stdout + initResult.stderr);
  assert.match(initResult.stdout + initResult.stderr, /Another OMS mutation owns/);
  assert.equal(existsSync(join(initRoot, "oms.yaml")), false);

  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api", "--commit"], { cwd }).status, 0);
  const indexBefore = readFileSync(join(cwd, ".git", "index"));
  const headBefore = gitOut(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, ".oms-mutation.lock"), "occupied\n");
  const record = run(["record", "api"], { cwd });
  assert.equal(record.status, 1, record.stdout + record.stderr);
  assert.match(record.stdout + record.stderr, /Another OMS mutation owns/);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), indexBefore);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), headBefore);
});

test("submodule branch list preserves refresh behavior behind the mutation lock", () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const headBefore = gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD");
  const refBefore = gitOut(join(cwd, "oms", "api"), "rev-parse", "refs/remotes/origin/main");
  writeFileSync(join(cwd, ".oms-mutation.lock"), "occupied\n");

  const result = run(["branch", "list", "api"], { cwd });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Another OMS mutation owns/);
  assert.equal(gitOut(join(cwd, "oms", "api"), "rev-parse", "HEAD"), headBefore);
  assert.equal(gitOut(join(cwd, "oms", "api"), "rev-parse", "refs/remotes/origin/main"), refBefore);
  assert.equal(readFileSync(join(cwd, ".oms-mutation.lock"), "utf8"), "occupied\n");
});

test("doctor reports a proven stale workspace mutation lock without removing it", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const lock = {
    version: 1,
    operation: "sync",
    operationId: "test-operation",
    ownerToken: "test-owner",
    targetHash: "test-target",
    workspaceId: null,
    pid: process.pid,
    processStart: "not-the-current-process-start",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(cwd, ".oms-mutation.lock"), `${JSON.stringify(lock)}\n`);

  const result = run(["doctor"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /refers to non-running sync process/);
  assert.match(result.stdout + result.stderr, /Verify no OMS mutation is active/);
  assert.equal(readFileSync(join(cwd, ".oms-mutation.lock"), "utf8"), `${JSON.stringify(lock)}\n`);
});

test("lock-free doctor Git subprocesses disable optional locks", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "\${GIT_OPTIONAL_LOCKS:-}" != "0" ]; then echo "optional locks enabled" >&2; exit 97; fi\nexec ${realGit} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);

  const result = run(["doctor"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 97, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /optional locks enabled/);
});

test("worktree doctor diagnoses endpoint, provenance, relative metadata, lock, exclude, and orphan drift read-only", () => {
  const bare = initBareUpstream({ branches: ["main", "external"] });
  const root = initGitWorkspace();
  const cwd = join(root, "nested");
  mkdirSync(cwd);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  const checkout = join(cwd, "oms", "api", "main");
  git(common, "config", "worktree.useRelativePaths", "false");
  git(common, "config", "--add", "remote.origin.url", `file://${bare}`);
  git(common, "config", "--replace-all", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
  git(common, "config", "url.file:///redirect.insteadOf", "file:///declared");
  git(common, "worktree", "lock", checkout);
  mkdirSync(join(cwd, ".oms", "repos", "orphan.git"));
  const excludePath = resolve(cwd, gitOut(cwd, "rev-parse", "--git-path", "info/exclude"));
  writeFileSync(excludePath, readFileSync(excludePath, "utf8").replace(/^.*\.oms\/workspace\.json.*\r?\n/m, ""));
  const before = snapshotDirectory(cwd);

  const result = run(["doctor"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /worktree\.useRelativePaths is not enabled/);
  assert.match(output, /endpoint configuration drifted/);
  assert.match(output, /fetch refspec drifted/);
  assert.match(output, /fetch provenance is untrusted/);
  assert.match(output, /URL rewrite configuration violates/);
  assert.match(output, /is locked/);
  assert.match(output, /orphaned from oms\.yaml/);
  assert.match(output, /local exclude block is missing \.oms\/workspace\.json/);
  assert.deepEqual(snapshotDirectory(cwd), before);
});

test("doctor reports ownership, symlink, external, stale, and incompatible topology boundaries", () => {
  const bare = initBareUpstream({ branches: ["main", "external"] });
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "branch", "external", "refs/remotes/origin/external");
  const external = tempWorkspace();
  git(common, "worktree", "add", external, "external");
  const externalResult = run(["doctor"], { cwd });
  assert.equal(externalResult.status, 2, externalResult.stdout + externalResult.stderr);
  assert.match(externalResult.stdout + externalResult.stderr, /external or ownership-ambiguous worktree/);

  git(common, "worktree", "remove", "--force", external);
  const aliasPath = join(cwd, "oms", "api");
  const actualPath = join(cwd, "oms", "api-actual");
  renameSync(aliasPath, actualPath);
  symlinkSync(actualPath, aliasPath, "dir");
  const symlinked = run(["doctor"], { cwd });
  assert.equal(symlinked.status, 2, symlinked.stdout + symlinked.stderr);
  assert.match(symlinked.stdout + symlinked.stderr, /symbolic|ownership-ambiguous/);

  unlinkSync(aliasPath);
  renameSync(actualPath, aliasPath);
  git(common, "config", "oms.workspaceId", "00000000-0000-0000-0000-000000000000");
  const foreign = run(["doctor"], { cwd });
  assert.equal(foreign.status, 2, foreign.stdout + foreign.stderr);
  assert.match(foreign.stdout + foreign.stderr, /ownership or shape does not match/);

  const submodule = initGitWorkspace();
  writeSources(submodule);
  mkdirSync(join(submodule, ".oms", "repos"), { recursive: true });
  const incompatible = run(["doctor"], { cwd: submodule });
  assert.equal(incompatible.status, 2, incompatible.stdout + incompatible.stderr);
  assert.match(incompatible.stdout + incompatible.stderr, /worktree-mode state remains in submodule mode/);
});

test("all lock-free worktree inspections disable optional locks and leave concurrent mutation state unchanged", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const processStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
  writeFileSync(join(cwd, ".oms-mutation.lock"), `${JSON.stringify({
    version: 1,
    operation: "representative concurrent mutation",
    operationId: "inspection-test",
    ownerToken: "inspection-test",
    targetHash: "inspection-test",
    workspaceId: JSON.parse(readFileSync(join(cwd, ".oms", "workspace.json"), "utf8")).workspaceId,
    transitionId: null,
    pid: process.pid,
    processStart,
    startedAt: "2026-01-01T00:00:00.000Z",
  })}\n`);
  const before = snapshotDirectory(cwd);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [ "\${GIT_OPTIONAL_LOCKS:-}" != "0" ]; then echo "optional locks enabled" >&2; exit 97; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(stubGit, 0o755);
  const env = { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  for (const args of [["status", "--json"], ["worktree", "list"], ["branch", "list", "api"], ["doctor"]]) {
    const result = run(args, { cwd, env });
    assert.notEqual(result.status, 97, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /optional locks enabled/);
    assert.deepEqual(snapshotDirectory(cwd), before, args.join(" "));
  }
});

test("worktree prompt and exit contracts are deterministic without real prompt fallback", () => {
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  const success = run(["sync", "api"], { cwd, env: queueEnv([]) });
  assert.equal(success.status, 0, success.stdout + success.stderr);
  const deterministic = run(["worktree", "add"], { cwd, env: queueEnv([{ type: "cancel" }]) });
  assert.equal(deterministic.status, 1, deterministic.stdout + deterministic.stderr);
  const refusal = run(["worktree", "add"], { cwd });
  assert.equal(refusal.status, 1, refusal.stdout + refusal.stderr);
  assert.match(refusal.stdout + refusal.stderr, /requires a repository alias outside an interactive terminal/);
  const common = join(cwd, ".oms", "repos", "api.git");
  git(common, "config", "--add", "remote.origin.url", `file://${bare}`);
  const safety = run(["fetch", "api"], { cwd, env: queueEnv([]) });
  assert.equal(safety.status, 1, safety.stdout + safety.stderr);
  const missing = join(cwd, "missing-remote.git");
  git(common, "config", "--unset-all", "remote.origin.url");
  git(common, "config", "--add", "remote.origin.url", `file://${missing}`);
  writeSources(cwd, `mode: worktree\n${sourceFor("api", missing)}`);
  const operational = run(["fetch", "api"], { cwd, env: queueEnv([]) });
  assert.equal(operational.status, 2, operational.stdout + operational.stderr);
});

test("credential canaries never cross output channels or OMS-managed durable files", () => {
  const canary = "OMS_CANARY_9f31";
  const bare = initBareUpstream();
  const cwd = tempWorkspace();
  writeSources(cwd, `mode: worktree\n${sourceFor("api", bare)}`);
  assert.equal(run(["sync", "api"], { cwd }).status, 0);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [ "$1" = "fetch" ]; then\n  printf '%s\\n' 'https://user:${canary}@example.invalid/repo.git?token=${canary}#${canary}' >&2\n  printf '%s\\n' 'https://user%3A${canary}%40example.invalid/repo.git' >&2\n  printf '%s\\n' 'Authorization: Bearer ${canary}' 'Proxy-Authorization: Basic ${canary}' 'http.extraHeader=Authorization: Bearer ${canary}' >&2\n  printf '\\001OMS_CANARY_9f31\\n' >&2\n  exit 42\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(stubGit, 0o755);
  const env = { ...testEnv, NO_COLOR: "1", PATH: `${stubDir}${delimiter}${process.env.PATH}` };
  delete env.FORCE_COLOR;
  const result = run(["fetch", "api"], {
    cwd,
    env,
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, new RegExp(canary));
  assert.doesNotMatch(output, /%3AOMS_CANARY|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  assert.match(output, /\[redacted\]/);
  for (const [path, kind, , hash] of snapshotDirectory(cwd)) {
    if (kind !== "file" || path === "oms.yaml") continue;
    assert.notEqual(hash, createHash("sha256").update(canary).digest("hex"));
    assert.doesNotMatch(readFileSync(join(cwd, path), "utf8"), new RegExp(canary), path);
  }
});

test("managed mutations reject Git older than 2.48 before workspace changes", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = mkdtempSync(join(tmpdir(), "oms-git-stub-"));
  const stubGit = join(stubDir, "git");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "git version 2.47.9"; exit 0; fi\nexec ${realGit} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);
  const result = run(["sync", "sample"], {
    cwd,
    env: { ...testEnv, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Git 2\.48 or newer is required/);
  assert.equal(existsSync(join(cwd, ".oms-mutation.lock")), false);
  assert.equal(existsSync(join(cwd, ".oms")), false);
  assert.equal(existsSync(join(cwd, "oms", "sample")), false);
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
