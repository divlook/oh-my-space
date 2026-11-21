import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { testEnv, run, queueEnv, tempFixture, writeSources, git, initBareUpstream, initGitWorkspace, gitOut, initEmptyBare, sourceFor, sourcesFor, workspaceWithApi, workspaceWithMovedApi } from "./helpers.js";

function gitFailureEnv(command, diagnostic) {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-git-stub-");
  const stubGit = join(stubDir, "git");
  const condition = command.map((arg, index) => `[ "$${index + 1}" = ${JSON.stringify(arg)} ]`).join(" && ");
  writeFileSync(
    stubGit,
    `#!/usr/bin/env bash\nif ${condition}; then printf '%s\\n' ${JSON.stringify(`fatal: ${diagnostic}`)} >&2; exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(stubGit, 0o755);
  return { ...testEnv, PATH: `${stubDir}${delimiter}${process.env.PATH}` };
}

test("branch list auto-selects the sole eligible clone without rewriting root Git state or the manifest", () => {
  const { cwd, wt: dir } = workspaceWithApi();
  const manifest = join(cwd, "oms.yaml");
  const metadataBefore = readFileSync(manifest, "utf8");
  const root = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "ls-files", "--stage");
  const head = gitOut(dir, "rev-parse", "HEAD");

  const result = run(["branch", "list"], { cwd });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Branch inventory: api/);
  assert.equal(readFileSync(manifest, "utf8"), metadataBefore);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), root);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), rootIndex);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), head);
});

test("branch list rejects unknown, ambiguous, missing, and blocked aliases with actionable guidance", () => {
  const { cwd, bare } = workspaceWithApi();
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
  git(cwd, "clone", `file://${bare}`, "oms/web");

  const unknown = run(["branch", "list", "unknown"], { cwd });
  assert.equal(unknown.status, 1, unknown.stdout + unknown.stderr);
  assert.match(unknown.stdout + unknown.stderr, /Unknown alias.*oms clone --list/);
  const ambiguous = run(["branch", "list"], { cwd });
  assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stdout + ambiguous.stderr, /oms branch list <alias>/);

  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }, { alias: "missing", bare }]));
  const missing = run(["branch", "list", "missing"], { cwd });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /oms clone missing/);
  assert.equal(existsSync(join(cwd, "oms", "missing")), false);

  git(join(cwd, "oms", "web"), "remote", "set-url", "origin", `file://${initBareUpstream()}`);
  const blocked = run(["branch", "list", "web"], { cwd, env: queueEnv([]) });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /origin does not match.*declaration.*Check oms\/web/);
});

test("bare branch routes list through the guarded action selector without leftover responses", () => {
  const { cwd } = workspaceWithApi();
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
  git(cwd, "clone", `file://${origin}`, "oms/api");
  const dir = join(cwd, "oms", "api");
  const credentialUrl = "https://secret:token@example.invalid/private.git";
  git(dir, "remote", "set-url", "origin", credentialUrl);
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: ${credentialUrl}\n    branch: main\n`);
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "diff", "--cached", "--name-only");
  const sourceHead = gitOut(dir, "rev-parse", "HEAD");
  const branch = gitOut(dir, "branch", "--show-current");

  const result = run(["branch", "list", "api"], {
    cwd,
    env: gitFailureEnv(["fetch", "origin"], `${credentialUrl}?token=query-secret is unavailable`),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /origin\tstale\tcached/);
  assert.match(output, /example\.invalid\/private\.git/);
  assert.doesNotMatch(output, /secret:token/);
  assert.doesNotMatch(output, /query-secret/);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "diff", "--cached", "--name-only"), rootIndex);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), sourceHead);
  assert.equal(gitOut(dir, "branch", "--show-current"), branch);
});

test("branch list reports fresh empty remote groups and detached HEAD", () => {
  const origin = initBareUpstream();
  const empty = initEmptyBare();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin, "main", { empty }));
  git(cwd, "clone", `file://${origin}`, "oms/api");
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

test("branch list shows local refs when it cannot refresh the omitted origin default", () => {
  const { cwd, bare, wt: dir } = workspaceWithApi();
  writeSources(cwd, sourceFor("api", bare).replace("    branch: main\n", ""));
  git(dir, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  const result = run(["branch", "list", "api"], {
    cwd,
    env: gitFailureEnv(["remote", "set-head", "origin"], "cannot refresh origin HEAD"),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /BASELINE \[unknown\]: \(none\)/);
  assert.match(output, /origin\/HEAD is not reliable/);
  assert.match(output, /cannot refresh origin HEAD/);
  assert.match(output, /LOCAL/);
  assert.match(output, /main\tcurrent/);
});

test("branch list can clone a missing alias interactively, continue listing, or cancel without root changes", () => {
  const origin = initBareUpstream();
  const acceptedCwd = initGitWorkspace();
  writeSources(acceptedCwd, sourceFor("api", origin));
  const accepted = run(["branch", "list", "api"], {
    cwd: acceptedCwd,
    env: queueEnv([{ type: "select", value: "clone" }]),
  });
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout + accepted.stderr, /Branch inventory: api/);
  assert.equal(existsSync(join(acceptedCwd, "oms", "api", ".git")), true);
  const rerun = run(["branch", "list", "api"], { cwd: acceptedCwd });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout + rerun.stderr, /Branch inventory: api/);
  assert.equal(gitOut(acceptedCwd, "ls-files", "--stage"), "");

  const cancelledCwd = initGitWorkspace();
  writeSources(cancelledCwd, sourceFor("api", origin));
  const cancelled = run(["branch", "list", "api"], {
    cwd: cancelledCwd,
    env: queueEnv([{ type: "select", value: "cancel" }]),
  });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.equal(existsSync(join(cancelledCwd, "oms", "api")), false);
  assert.equal(gitOut(cancelledCwd, "status", "--porcelain"), "?? oms.yaml");
});

test("branch list preserves stdin for credential prompts during delegated clone redaction", () => {
  const origin = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", origin));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-git-stub-");
  const marker = join(stubDir, "stdin-read");
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash\nif [ "$1" = "clone" ]; then IFS= read -r credential; [ "$credential" = "credential-value" ] || exit 88; printf '%s' "$credential" > "${marker}"; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(stubGit, 0o755);

  const result = run(["branch", "list", "api"], {
    cwd,
    input: "credential-value\n",
    env: queueEnv([{ type: "select", value: "clone" }], { PATH: `${stubDir}${delimiter}${process.env.PATH}` }),
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
  git(cwd, "clone", `file://${origin}`, "oms/api");
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
  git(cwd, "clone", `file://${origin}`, "oms/api");
  git(join(cwd, "oms", "api"), "remote", "add", "configfail", `file://${configfail}`);
  git(join(cwd, "oms", "api"), "fetch", "configfail");
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
  const { cwd, wt: dir } = workspaceWithApi();
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
  git(cwd, "clone", `file://${origin}`, "oms/api");
  git(join(cwd, "oms", "api"), "symbolic-ref", "-d", "refs/remotes/origin/HEAD");

  const fresh = run(["branch", "list", "api"], { cwd });
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stdout + fresh.stderr, /BASELINE \[known\]: main/);

  renameSync(origin, `${origin}.offline`);
  const stale = run(["branch", "list", "api"], { cwd });
  const output = stale.stdout + stale.stderr;
  assert.equal(stale.status, 0, output);
  assert.match(output, /origin\tstale\tmain/);
  assert.match(output, /BASELINE \[unknown\]: \(none\)/);
  assert.match(output, /origin\/HEAD is not reliable/);
});

test("branch list allows independent local commits but rejects a source tracked by the workspace", () => {
  const { cwd, wt: dir } = workspaceWithMovedApi();
  const local = gitOut(dir, "rev-parse", "HEAD");
  const moved = run(["branch", "list", "api"], { cwd });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout + moved.stderr, /main\t[^\n]*origin\/main\t1\t0/);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), local);

  const workspaceFile = join("oms", "api", "root-file");
  writeFileSync(join(cwd, workspaceFile), "root-owned\n");
  git(cwd, "update-index", "--add", "--cacheinfo", `100644,${gitOut(cwd, "hash-object", "-w", workspaceFile)},${workspaceFile}`);
  const blocked = run(["branch", "list", "api"], { cwd });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout + blocked.stderr, /tracked by the workspace root/);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), local);
});

test("branch list cleans up its failed temporary clone and redacts manifest credentials", () => {
  const cwd = initGitWorkspace();
  const origin = initBareUpstream();
  writeSources(cwd, "repos:\n  - alias: api\n    remotes:\n      origin: https://secret:token@example.invalid/private.git\n    branch: main\n");
  const rootIndex = gitOut(cwd, "ls-files", "--stage");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const stubDir = tempFixture("oms-git-stub-");
  const stubGit = join(stubDir, "git");
  writeFileSync(stubGit, `#!/usr/bin/env bash
if [[ "$1" == clone ]]; then
  ${JSON.stringify(realGit)} clone ${JSON.stringify(`file://${origin}`)} "\${@: -1}" || exit 88
  echo 'fatal: https://secret:token@example.invalid/private.git is unavailable' >&2
  exit 128
fi
exec ${JSON.stringify(realGit)} "$@"
`);
  chmodSync(stubGit, 0o755);
  const result = run(["branch", "list", "api"], {
    cwd,
    env: queueEnv([{ type: "select", value: "clone" }], { PATH: `${stubDir}${delimiter}${process.env.PATH}` }),
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 2, output);
  assert.match(output, /git clone failed \(exit 128\)/);
  assert.match(output, /example\.invalid\/private\.git/);
  assert.doesNotMatch(output, /secret:token|Branch inventory/);
  assert.deepEqual(readdirSync(join(cwd, "oms")), []);
  assert.equal(gitOut(cwd, "ls-files", "--stage"), rootIndex);
});

test("branch list preserves blocked-checkout and operational clone exit codes", () => {
  const origin = initBareUpstream();
  const preconditionCwd = initGitWorkspace();
  writeSources(preconditionCwd, sourceFor("api", origin));
  mkdirSync(join(preconditionCwd, "oms"));
  mkdirSync(join(preconditionCwd, "oms", "api"));
  writeFileSync(join(preconditionCwd, "oms", "api", "occupied.txt"), "keep\n");
  const precondition = run(["branch", "list", "api"], {
    cwd: preconditionCwd,
    env: queueEnv([]),
  });
  assert.equal(precondition.status, 1, precondition.stdout + precondition.stderr);
  assert.match(precondition.stdout + precondition.stderr, /not an independent Git checkout.*left it unchanged/);
  assert.equal(readFileSync(join(preconditionCwd, "oms", "api", "occupied.txt"), "utf8"), "keep\n");

  const operationalCwd = initGitWorkspace();
  writeSources(operationalCwd, "repos:\n  - alias: api\n    remotes:\n      origin: https://secret:token@example.invalid/private.git\n    branch: main\n");
  const failureEnv = gitFailureEnv(["clone"], "https://secret:token@example.invalid/private.git is unavailable");
  const operational = run(["branch", "list", "api"], {
    cwd: operationalCwd,
    env: queueEnv([{ type: "select", value: "clone" }], { PATH: failureEnv.PATH }),
  });
  const output = operational.stdout + operational.stderr;
  assert.equal(operational.status, 2, output);
  assert.match(output, /git clone failed/);
  assert.match(output, /example\.invalid\/private\.git/);
  assert.doesNotMatch(output, /secret:token/);
});

test("branch list keeps an exhausted declared remote with no cached refs visible as unavailable", () => {
  const { bare: origin, cwd } = workspaceWithApi();
  const missingRemote = join(tempFixture("missing-remote-"), "missing.git");
  writeSources(cwd, `repos:\n  - alias: api\n    remotes:\n      origin: file://${origin}\n      missing: file://${missingRemote}\n    branch: main\n`);

  const result = run(["branch", "list", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /missing\tunavailable\t\(empty\)/);
  assert.match(output, /does not appear to be a git repository/);
  assert.match(output, /origin\tfresh\tmain/);
});
