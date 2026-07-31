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
import test from "./sharded-test.js";
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
  queueEnv,
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
  const stubDir = tempFixture("oms-git-stub-");
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
  const stubDir = tempFixture("oms-git-stub-");
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
  const stubDir = tempFixture("oms-git-stub-");
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
  const stubDir = tempFixture("oms-git-stub-");
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
  const stubDir = tempFixture("oms-git-stub-");
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
