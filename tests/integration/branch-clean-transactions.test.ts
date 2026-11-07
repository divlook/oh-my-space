import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { configIdentity, git, gitOut, localBranchExists, tempFixture, testEnv, workspaceWithApi } from "../helpers.js";
import { yes, shell, fixture, candidates, clean, wrapper } from "./branch-clean-fixtures.js";

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
