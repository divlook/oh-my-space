import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runBranchClean } from "../../scripts/lib/branch-clean.js";
import { __resetPromptQueueForTests, assertPromptQueueDrained } from "../../scripts/lib/prompt-adapter.js";
import { configIdentity, git, gitOut, initBareUpstream, initGitWorkspace, localBranchExists, queueEnv, sourceFor, sourcesFor, syncedSubmodule, tempFixture, testEnv, workspaceWithApi, writeSources } from "../helpers.js";

Object.assign(process.env, testEnv);
const yes = [{ type: "confirm", value: true }];
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(base = "main") {
  const bare = initBareUpstream({ branches: [base] });
  const cwd = initGitWorkspace();
  const wt = syncedSubmodule(cwd, "api", bare, base);
  return { bare, cwd, wt };
}
function snapshot(cwd: string, wt: string) {
  return { root: gitOut(cwd, "rev-parse", "HEAD"), rootIndex: gitOut(cwd, "ls-files", "--stage"), head: gitOut(wt, "rev-parse", "HEAD"), current: gitOut(wt, "branch", "--show-current"), index: gitOut(wt, "ls-files", "--stage"), status: gitOut(wt, "status", "--porcelain"), remotes: gitOut(wt, "for-each-ref", "refs/remotes", "--format=%(refname) %(objectname)") };
}
function candidates(wt: string) {
  git(wt, "branch", "a-first");
  git(wt, "branch", "z-last");
}
async function clean(cwd: string, options: { alias?: string; base?: string; responses?: unknown[]; env?: Record<string, string>; change?: () => void } = {}) {
  const previous = { ...process.env };
  const oldCwd = process.cwd();
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let output = "";
  let changed = false;
  const capture = (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    // Observe the public immutable plan, not an internal implementation hook.
    if (!changed && options.change && /z-last[^\n]*[0-9a-f]{40}/.test(output)) {
      changed = true;
      options.change();
    }
    return true;
  };
  Object.assign(process.env, options.responses === undefined ? testEnv : queueEnv(options.responses), options.env);
  if (options.responses === undefined) delete process.env.OMS_TEST_PROMPT_RESPONSES;
  __resetPromptQueueForTests();
  process.stdout.write = capture as typeof stdout;
  process.stderr.write = capture as typeof stderr;
  try {
    process.chdir(cwd);
    const code = await runBranchClean(options.alias ?? "api", { base: options.base });
    if (options.change) assert.ok(changed, `Plan mutation boundary was not observed: ${output}`);
    if (code === 0) assertPromptQueueDrained();
    return { code, output };
  } finally {
    process.chdir(oldCwd);
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    __resetPromptQueueForTests();
  }
}
function wrapper(body: string) {
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const dir = tempFixture("clean-git-");
  const log = join(dir, "commands");
  const path = join(dir, "git");
  writeFileSync(path, `#!/usr/bin/env bash\nREAL=${shell(real)}\nprintf '%s\\n' "$*" >> ${shell(log)}\n${body}\nexec "$REAL" "$@"\n`);
  chmodSync(path, 0o755);
  return { env: { PATH: `${dir}${delimiter}${process.env.PATH}` }, log };
}

test("cleanup deletes sorted true ancestors independently of HEAD and upstream and preserves repository boundaries", async () => {
  const { cwd, wt } = fixture("develop");
  const initial = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "-b", "topic");
  git(wt, "commit", "--allow-empty", "-m", "topic");
  const tip = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "develop");
  git(wt, "merge", "--no-ff", "topic", "-m", "merge");
  git(wt, "branch", "a-merged", tip);
  git(wt, "branch", "--set-upstream-to", "origin/develop", "a-merged");
  git(wt, "checkout", "topic");
  git(wt, "commit", "--allow-empty", "-m", "post merge");
  git(wt, "checkout", "-b", "current", initial);
  git(wt, "branch", "z-last", tip);
  git(wt, "config", "branch.z-last.description", "remove only this section");
  git(wt, "config", "branch.current.description", "retain");
  writeFileSync(join(wt, "dirty"), "untouched");
  writeFileSync(join(wt, "staged"), "index contents");
  git(wt, "add", "staged");
  const before = snapshot(cwd, wt);
  const result = await clean(cwd, { responses: yes });
  assert.equal(result.code, 0, result.output);
  for (const branch of ["a-merged", "z-last"]) assert.equal(localBranchExists(wt, branch), false);
  for (const branch of ["topic", "current", "develop"]) assert.equal(localBranchExists(wt, branch), true);
  assert.deepEqual(snapshot(cwd, wt), before);
  assert.equal(readFileSync(join(wt, "dirty"), "utf8"), "untouched");
  assert.equal(gitOut(wt, "config", "branch.current.description"), "retain");
  assert.equal(spawnSync("git", ["-C", wt, "config", "--get-regexp", "^branch\\.(a-merged|z-last)\\."], { env: testEnv }).status, 1);
  assert.ok(result.output.indexOf("a-merged") < result.output.indexOf("z-last"));
  assert.ok(result.output.includes("refs/heads/develop") && result.output.includes(tip), result.output);
  assert.match(result.output, /git.*branch/);
});

test("cleanup protects metadata baselines and all external and managed worktree branches", async () => {
  const { cwd, wt } = fixture();
  for (const branch of ["drift", "external", "managed", "a-first"]) git(wt, "branch", branch);
  git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "drift");
  const external = join(tempFixture("clean-external-"), "tree");
  const managed = join(cwd, ".oms-tree", "api", "task");
  git(wt, "worktree", "add", external, "external");
  git(wt, "worktree", "add", managed, "managed");
  const before = gitOut(wt, "worktree", "list", "--porcelain");
  const result = await clean(cwd, { responses: yes });
  assert.equal(result.code, 0, result.output);
  for (const branch of ["main", "drift", "external", "managed"]) assert.ok(localBranchExists(wt, branch));
  assert.equal(localBranchExists(wt, "a-first"), false);
  assert.equal(gitOut(wt, "worktree", "list", "--porcelain"), before);
  const refusal = await clean(managed);
  assert.equal(refusal.code, 1, refusal.output);
});

test("cleanup uses each repository default and cached explicit remote bases without fetching", async () => {
  for (const base of ["develop", "release"]) {
    const { cwd, wt } = fixture(base);
    git(wt, "branch", "topic");
    const intercepted = wrapper('if [[ "$*" == *fetch* ]]; then echo forbidden-fetch >&2; exit 99; fi');
    const result = await clean(cwd, { base: `refs/remotes/origin/${base}`, responses: yes, env: intercepted.env });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(`refs/remotes/origin/${base}`));
    assert.equal(localBranchExists(wt, "topic"), false);
    assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /\bfetch\b/);
    const empty = await clean(cwd);
    assert.equal(empty.code, 0, empty.output);
    assert.ok(empty.output.includes(`refs/heads/${base}`));
  }
});

test("cleanup rejects missing ambiguous symbolic and nonbranch bases without protection bypass", async () => {
  const { cwd, wt, bare } = fixture();
  git(wt, "branch", "topic");
  git(wt, "tag", "tagged");
  git(wt, "branch", "origin/main");
  git(wt, "symbolic-ref", "refs/heads/symbolic", "refs/heads/main");
  for (const base of ["missing", "origin/main", "symbolic", "tagged", "HEAD~0", gitOut(wt, "rev-parse", "HEAD")]) {
    const result = await clean(cwd, { base });
    assert.equal(result.code, 1, `${base}: ${result.output}`);
    assert.ok(localBranchExists(wt, "topic"));
  }
  writeSources(cwd, sourceFor("api", bare).replace("    branch: main\n", ""));
  git(wt, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  const refused = await clean(cwd, { base: "refs/heads/main" });
  assert.equal(refused.code, 1, refused.output);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup declines cancels and refuses noninteractive candidates but succeeds without candidates", async () => {
  const { cwd, wt } = fixture();
  assert.equal((await clean(cwd)).code, 0);
  git(wt, "branch", "topic");
  for (const responses of [undefined, [{ type: "confirm", value: false }], [{ type: "cancel" }]]) {
    const result = await clean(cwd, { responses });
    assert.equal(result.code, 1, result.output);
    assert.ok(localBranchExists(wt, "topic"));
    assert.ok(result.output.includes(gitOut(wt, "rev-parse", "topic")));
  }
});

test("cleanup retains registered initialization baseline attachment and tracking after decline", async () => {
  const original = workspaceWithApi();
  git(original.wt, "branch", "topic");
  git(original.wt, "push", "origin", "topic");
  const cwd = tempFixture("clean-uninitialized-");
  execFileSync("git", ["clone", original.cwd, cwd], { env: testEnv, stdio: "ignore" });
  configIdentity(cwd);
  const wt = join(cwd, "oms", "api");
  const root = gitOut(cwd, "ls-files", "--stage");
  // Initialization creates the baseline; topic is made local when initialization is observed.
  const interception = wrapper(`if [[ "$*" == *"worktree list"* ]] && [[ ! -f ${shell(join(cwd, "injected"))} ]]; then "$REAL" -C ${shell(wt)} branch topic origin/topic; touch ${shell(join(cwd, "injected"))}; fi`);
  const result = await clean(cwd, { responses: [{ type: "confirm", value: false }], env: interception.env });
  assert.equal(result.code, 1, result.output);
  assert.ok(existsSync(join(wt, ".git")));
  assert.equal(gitOut(wt, "branch", "--show-current"), "main");
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), gitOut(cwd, "rev-parse", "HEAD:oms/api"));
  assert.equal(gitOut(wt, "config", "branch.main.remote"), "origin");
  assert.equal(gitOut(wt, "config", "branch.main.merge"), "refs/heads/main");
  assert.equal(gitOut(cwd, "ls-files", "--stage"), root);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup detached safety uses root HEAD gitlink rather than a staged pointer", async () => {
  const { cwd, wt } = fixture();
  const recorded = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "commit", "--allow-empty", "-m", "new pointer");
  const staged = gitOut(wt, "rev-parse", "HEAD");
  git(cwd, "add", "oms/api");
  git(wt, "checkout", "--detach", recorded);
  git(wt, "branch", "topic", recorded);
  const accepted = await clean(cwd, { responses: yes });
  assert.equal(accepted.code, 0, accepted.output);
  assert.equal(gitOut(cwd, "rev-parse", ":oms/api"), staged);
  git(wt, "checkout", "--detach", staged);
  git(wt, "branch", "topic");
  const refused = await clean(cwd);
  assert.equal(refused.code, 1, refused.output);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup shallow history deletes proven ancestors and preserves unproven ancestry without fetching", async () => {
  const { cwd, wt } = fixture();
  const old = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "commit", "--allow-empty", "-m", "boundary");
  const boundary = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "branch", "unproven", old);
  git(wt, "branch", "proven", boundary);
  git(wt, "commit", "--allow-empty", "-m", "base");
  writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "shallow"), `${boundary}\n`);
  const intercepted = wrapper('if [[ "$*" == *fetch* ]]; then exit 99; fi');
  const result = await clean(cwd, { responses: yes, env: intercepted.env });
  assert.equal(result.code, 0, result.output);
  assert.equal(localBranchExists(wt, "proven"), false);
  assert.ok(localBranchExists(wt, "unproven"));
  assert.match(result.output, /shallow|limited.history/i);
  assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /\bfetch\b/);
});

test("cleanup planning inspection errors fail closed instead of becoming idle detached or empty inventory", async () => {
  for (const match of ["for-each-ref", "worktree list", "merge-base --is-ancestor", "--is-shallow-repository", "symbolic-ref", "--git-path"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    const intercepted = wrapper(`if [[ "$*" == *${shell(match)}* ]]; then echo inspection-failure >&2; exit 128; fi`);
    const result = await clean(cwd, { env: intercepted.env });
    assert.notEqual(result.code, 0, `${match}: ${result.output}`);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"), match);
  }
});

test("cleanup preserves changed occupied symbolic and newly protected candidates and continues safe branches", async () => {
  for (const kind of ["tip", "occupied", "symbolic", "protected"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "base ahead");
    const result = await clean(cwd, { responses: yes, change: () => {
      if (kind === "tip") git(wt, "update-ref", "refs/heads/a-first", gitOut(wt, "rev-parse", "main"));
      if (kind === "occupied") git(wt, "worktree", "add", join(tempFixture("clean-occupied-"), "tree"), "a-first");
      if (kind === "symbolic") { git(wt, "update-ref", "-d", "refs/heads/a-first"); git(wt, "symbolic-ref", "refs/heads/a-first", "refs/heads/main"); }
      if (kind === "protected") git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.branch", "a-first");
    } });
    assert.equal(result.code, 2, `${kind}: ${result.output}`);
    assert.ok(localBranchExists(wt, "a-first"));
    // Registration metadata is shared state; changing it aborts the remaining batch.
    assert.equal(localBranchExists(wt, "z-last"), kind === "protected", result.output);
  }
});

test("cleanup treats same-name same-OID recreation as confirmed and already absent as successful", async () => {
  for (const recreate of [false, true]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    const tip = gitOut(wt, "rev-parse", "a-first");
    const result = await clean(cwd, { responses: yes, change: () => {
      git(wt, "update-ref", "-d", "refs/heads/a-first");
      if (recreate) git(wt, "branch", "a-first", tip);
      git(wt, "branch", "new-after-plan", tip);
    } });
    assert.equal(result.code, 0, result.output);
    assert.equal(localBranchExists(wt, "a-first"), false);
    assert.equal(localBranchExists(wt, "z-last"), false);
    assert.ok(localBranchExists(wt, "new-after-plan"));
    assert.match(result.output, recreate ? /deleted/i : /already.absent/i);
  }
});

test("cleanup aborts remaining work on base selected declaration registration recorded commit or operation changes", async () => {
  for (const kind of ["base", "declaration", "registration", "recorded", "operation"]) {
    const { cwd, wt, bare } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "available changed pointer");
    const changedPointer = gitOut(wt, "rev-parse", "HEAD");
    git(wt, "reset", "--hard", "HEAD^");
    const result = await clean(cwd, { responses: yes, change: () => {
      if (kind === "base") git(wt, "update-ref", "refs/heads/main", changedPointer);
      if (kind === "recorded") {
        git(cwd, "update-index", "--cacheinfo", `160000,${changedPointer},oms/api`);
        git(cwd, "commit", "-m", "record changed");
      }
      if (kind === "declaration") writeSources(cwd, sourceFor("api", bare, "main", { backup: bare }));
      if (kind === "registration") git(cwd, "config", "-f", ".gitmodules", "submodule.oms/api.url", "file:///changed");
      if (kind === "operation") writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${gitOut(wt, "rev-parse", "HEAD")}\n`);
    } });
    assert.equal(result.code, 2, `${kind}: ${result.output}`);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"));
    assert.match(result.output, /not.run/i);
  }
});

test("cleanup ignores unrelated root commits declarations and staged source pointer movement", async () => {
  const { cwd, wt, bare } = fixture();
  candidates(wt);
  git(wt, "commit", "--allow-empty", "-m", "available staged pointer");
  const stagedPointer = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "reset", "--hard", "HEAD^");
  const result = await clean(cwd, { responses: yes, change: () => {
    writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]));
    writeFileSync(join(cwd, "unrelated"), "root change");
    git(cwd, "add", "unrelated");
    git(cwd, "commit", "-m", "unrelated root commit");
    git(cwd, "update-index", "--cacheinfo", `160000,${stagedPointer},oms/api`);
  } });
  assert.equal(result.code, 0, result.output);
  assert.equal(localBranchExists(wt, "a-first"), false);
  assert.equal(localBranchExists(wt, "z-last"), false);
});

test("cleanup expected-tip and expected-base transactions reject races without force retries", async () => {
  for (const moved of ["a-first", "main"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    git(wt, "commit", "--allow-empty", "-m", "other OID");
    const other = gitOut(wt, "rev-parse", "HEAD");
    git(wt, "reset", "--hard", "HEAD^");
    const once = join(tempFixture("clean-race-"), "once");
    const intercepted = wrapper(`if [[ "$*" == *update-ref* && "$*" == *--stdin* && ! -f ${shell(once)} ]]; then touch ${shell(once)}; "$REAL" -C ${shell(wt)} update-ref ${shell(`refs/heads/${moved}`)} ${shell(other)}; fi`);
    const result = await clean(cwd, { responses: yes, env: intercepted.env });
    assert.equal(result.code, 2, result.output);
    assert.equal(gitOut(wt, "rev-parse", moved), other);
    assert.equal(localBranchExists(wt, "z-last"), moved === "main", result.output);
    assert.doesNotMatch(readFileSync(intercepted.log, "utf8"), /branch -[dD]|--force/);
  }
});

test("cleanup candidate-local ref and config failures retain accurate partial outcomes and recovery guidance", async () => {
  for (const failure of ["ref", "config"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    git(wt, "config", "branch.a-first.description", "candidate config");
    git(wt, "config", "branch.z-last.description", "later config");
    const tip = gitOut(wt, "rev-parse", "a-first");
    const once = join(tempFixture("clean-failure-"), "once");
    const body = failure === "ref"
      ? `if [[ "$*" == *update-ref* && "$*" == *--stdin* && ! -f ${shell(once)} ]]; then touch ${shell(once)}; cat >/dev/null; echo candidate-ref-failure >&2; exit 128; fi`
      : 'if [[ "$*" == *config* && "$*" == *--remove-section* && "$*" == *branch.a-first* ]]; then echo candidate-config-failure >&2; exit 128; fi';
    const intercepted = wrapper(body);
    const result = await clean(cwd, { responses: yes, env: intercepted.env });
    assert.equal(result.code, 2, result.output);
    assert.equal(localBranchExists(wt, "a-first"), failure === "ref");
    assert.equal(localBranchExists(wt, "z-last"), false);
    assert.equal(gitOut(wt, "config", "branch.a-first.description"), "candidate config");
    assert.ok(result.output.includes(tip), result.output);
    assert.match(result.output, /git.*branch/);
    if (failure === "config") assert.match(result.output, /--remove-section.*branch\.a-first/);
  }
});

test("cleanup preserves squash-equivalent branches and symbolic local refs", async () => {
  const { cwd, wt } = fixture();
  git(wt, "checkout", "-b", "squashed");
  writeFileSync(join(wt, "feature"), "same patch");
  git(wt, "add", "feature");
  git(wt, "commit", "-m", "topic patch");
  git(wt, "checkout", "main");
  git(wt, "merge", "--squash", "squashed");
  git(wt, "commit", "-m", "squash patch");
  git(wt, "symbolic-ref", "refs/heads/alias-ref", "refs/heads/main");
  const result = await clean(cwd);
  assert.equal(result.code, 0, result.output);
  assert.ok(localBranchExists(wt, "squashed"));
  assert.equal(gitOut(wt, "symbolic-ref", "refs/heads/alias-ref"), "refs/heads/main");
});

test("cleanup origin default requires its local branch and explicit bases do not silently substitute", async () => {
  const { cwd, wt, bare } = fixture("release");
  writeSources(cwd, sourceFor("api", bare, "release").replace("    branch: release\n", ""));
  git(wt, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
  git(wt, "branch", "origin/release");
  git(wt, "branch", "topic");
  const valid = await clean(cwd, { responses: [{ type: "confirm", value: false }] });
  assert.equal(valid.code, 1, valid.output);
  assert.ok(valid.output.includes("refs/heads/release"));
  assert.ok(localBranchExists(wt, "release") && localBranchExists(wt, "origin/release") && localBranchExists(wt, "topic"));
  git(wt, "checkout", "--detach");
  git(wt, "branch", "-d", "release");
  const missing = await clean(cwd);
  assert.equal(missing.code, 1, missing.output);
  assert.ok(localBranchExists(wt, "topic"));
  const explicit = await clean(cwd, { base: "refs/remotes/origin/release", responses: yes });
  assert.equal(explicit.code, 0, explicit.output);
  assert.equal(localBranchExists(wt, "topic"), false);
  assert.equal(localBranchExists(wt, "origin/release"), false);
});

test("cleanup refuses unregistered and in-progress targets without topology offers", async () => {
  const bare = initBareUpstream();
  const cwd = initGitWorkspace();
  writeSources(cwd, sourceFor("api", bare));
  const root = gitOut(cwd, "rev-parse", "HEAD");
  const unregistered = await clean(cwd);
  assert.equal(unregistered.code, 1, unregistered.output);
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), root);
  assert.equal(existsSync(join(cwd, ".gitmodules")), false);
  const wt = syncedSubmodule(cwd, "api", bare);
  git(wt, "branch", "topic");
  writeFileSync(gitOut(wt, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${gitOut(wt, "rev-parse", "HEAD")}\n`);
  const operation = await clean(cwd);
  assert.equal(operation.code, 1, operation.output);
  assert.ok(localBranchExists(wt, "topic"));
});

test("cleanup shared inspection failures after confirmation abort all remaining candidates", async () => {
  for (const match of ["ls-tree", "ls-files", "worktree list", "merge-base --is-ancestor"]) {
    const { cwd, wt } = fixture();
    candidates(wt);
    const marker = join(tempFixture("clean-inspect-race-"), "armed");
    const intercepted = wrapper(`if [[ -f ${shell(marker)} && "$*" == *${shell(match)}* ]]; then echo shared-inspection-failure >&2; exit 128; fi`);
    const result = await clean(cwd, { responses: yes, env: intercepted.env, change: () => writeFileSync(marker, "armed") });
    assert.equal(result.code, 2, `${match}: ${result.output}`);
    assert.ok(localBranchExists(wt, "a-first") && localBranchExists(wt, "z-last"));
    assert.match(result.output, /not.run/i);
  }
});

test("cleanup emits executable shell-safe recreation and exact configuration repair commands", async () => {
  const { cwd, wt } = fixture();
  const branch = "topic'quoted";
  git(wt, "branch", branch);
  git(wt, "config", `branch.${branch}.description`, "repair");
  const tip = gitOut(wt, "rev-parse", branch);
  const intercepted = wrapper('if [[ "$*" == *config* && "$*" == *--remove-section* ]]; then echo config-failure >&2; exit 128; fi');
  const result = await clean(cwd, { responses: yes, env: intercepted.env });
  assert.equal(result.code, 2, result.output);
  const commands = result.output.match(/git -C [^\n\r]+/g) ?? [];
  const recreate = commands.find((command) => command.includes(" branch -- "));
  const repair = commands.find((command) => command.includes(" config --local --remove-section "));
  assert.ok(recreate && repair, result.output);
  execFileSync("/bin/sh", ["-c", recreate], { cwd: wt, env: testEnv });
  execFileSync("/bin/sh", ["-c", repair], { cwd: wt, env: testEnv });
  assert.equal(gitOut(wt, "rev-parse", branch), tip);
  assert.equal(spawnSync("git", ["-C", wt, "config", "--get", `branch.${branch}.description`], { env: testEnv }).status, 1);
});

test("cleanup initialization failure preserves resumable state and inconsistent registration refuses deletion", async () => {
  const original = workspaceWithApi();
  const cwd = tempFixture("clean-init-failed-");
  execFileSync("git", ["clone", original.cwd, cwd], { env: testEnv, stdio: "ignore" });
  configIdentity(cwd);
  const root = gitOut(cwd, "ls-files", "--stage");
  const interception = wrapper('if [[ "$*" == *"submodule update --init"* ]]; then "$REAL" "$@"; echo initialization-failure >&2; exit 128; fi');
  const failed = await clean(cwd, { env: interception.env });
  assert.equal(failed.code, 2, failed.output);
  assert.ok(existsSync(join(cwd, "oms", "api", ".git")));
  assert.equal(gitOut(cwd, "ls-files", "--stage"), root);
  assert.match(failed.output, /initialization-failure/);
  assert.match(failed.output, /submodule update --init|retry|resum/i);
  const wt = original.wt;
  git(wt, "branch", "topic");
  git(original.cwd, "config", "-f", ".gitmodules", "submodule.oms/api.path", "oms/wrong");
  const refused = await clean(original.cwd);
  assert.equal(refused.code, 1, refused.output);
  assert.ok(localBranchExists(wt, "topic"));
});
