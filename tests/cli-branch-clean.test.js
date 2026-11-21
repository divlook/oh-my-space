import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test from "node:test";
import { configIdentity, git, gitOut, initBareUpstream, initGitWorkspace, localBranchExists, queueEnv, run, sourcesFor, tempFixture, testEnv, workspaceWithApi, writeSources } from "./helpers.js";

test("branch clean production journey deletes two merged branches and preserves protected unmerged and other repositories", () => {
  const bare = initBareUpstream({ branches: ["develop", "main"] });
  const cwd = initGitWorkspace();
  git(cwd, "clone", "--branch", "develop", `file://${bare}`, "oms/api");
  git(cwd, "clone", `file://${bare}`, "oms/web");
  const wt = join(cwd, "oms", "api");
  const web = join(cwd, "oms", "web");
  configIdentity(wt);
  writeSources(cwd, sourcesFor([{ alias: "api", bare }, { alias: "web", bare }]).replace("branch: main", "branch: develop"));
  for (const branch of ["a-merged", "z-merged"]) git(wt, "branch", branch);
  git(web, "branch", "other-repository");
  git(cwd, "branch", "root-branch");
  git(wt, "checkout", "-b", "unmerged");
  git(wt, "commit", "--allow-empty", "-m", "not in develop");
  git(wt, "checkout", "develop");
  const root = gitOut(cwd, "ls-files", "--stage");
  const head = gitOut(wt, "rev-parse", "HEAD");
  const result = run(["branch", "clean", "api"], { cwd, env: queueEnv([{ type: "confirm", value: true }]) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const branch of ["a-merged", "z-merged"]) assert.equal(localBranchExists(wt, branch), false);
  for (const branch of ["develop", "unmerged"]) assert.ok(localBranchExists(wt, branch));
  assert.ok(localBranchExists(web, "other-repository") && localBranchExists(cwd, "root-branch"));
  assert.equal(gitOut(cwd, "ls-files", "--stage"), root);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.ok(result.stdout.includes("refs/heads/develop") && result.stdout.includes(head));
  assert.match(result.stdout, /git.*branch/);
});

test("branch clean production routing rejects unsupported selection and preserves noninteractive candidates", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "branch", "topic");
  for (const args of [["clean", "api", "web"], ["clean", "api", "--force"], ["clean", "api", "--all"], ["clean", "api", "--yes"], ["clean", "unknown"], ["clean"], ["clean", "api"]]) {
    const result = run(["branch", ...args], { cwd: join(cwd, "oms", "api") });
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.ok(localBranchExists(wt, "topic"));
  }
  const cancelled = run(["branch", "clean"], { cwd, env: queueEnv([{ type: "cancel" }]) });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.ok(localBranchExists(wt, "topic"));
  const result = run(["branch", "clean", "api", "--base", "refs/remotes/origin/main"], { cwd, env: queueEnv([{ type: "confirm", value: false }]) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("refs/remotes/origin/main"));
  assert.ok(localBranchExists(wt, "topic"));
  const selected = run(["branch", "clean"], { cwd, env: queueEnv([{ type: "select", value: "api" }, { type: "confirm", value: true }]) });
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.equal(localBranchExists(wt, "topic"), false);
  git(wt, "branch", "menu-topic");
  const menu = run(["branch"], { cwd, env: queueEnv([{ type: "select", value: "clean" }, { type: "select", value: "api" }, { type: "confirm", value: true }]) });
  assert.equal(menu.status, 0, menu.stdout + menu.stderr);
  assert.equal(localBranchExists(wt, "menu-topic"), false);
});

test("branch clean production transactions preserve raced refs and continue only while the base is unchanged", () => {
  for (const changed of ["a-first", "main"]) {
    const { cwd, wt } = workspaceWithApi();
    git(wt, "branch", "a-first");
    git(wt, "branch", "z-last");
    git(wt, "checkout", "-b", "racing");
    git(wt, "commit", "--allow-empty", "-m", "raced data");
    const newTip = gitOut(wt, "rev-parse", "HEAD");
    git(wt, "checkout", "main");
    git(wt, "branch", "-D", "racing");
    const stubDir = tempFixture("clean-production-git-");
    const stub = join(stubDir, "git");
    const log = join(stubDir, "commands");
    const once = join(stubDir, "changed");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(stub, `#!/usr/bin/env bash
REAL=${JSON.stringify(real)}
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [[ "$1" == update-ref && "$*" == *--stdin* && ! -f ${JSON.stringify(once)} ]]; then
  touch ${JSON.stringify(once)}
  "$REAL" update-ref refs/heads/${changed} ${newTip} || exit 88
fi
exec "$REAL" "$@"
`);
    chmodSync(stub, 0o755);
    const result = run(["branch", "clean", "api"], {
      cwd,
      env: queueEnv([{ type: "confirm", value: true }], { PATH: `${stubDir}${delimiter}${process.env.PATH}` }),
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 2, output);
    assert.equal(gitOut(wt, "rev-parse", changed), newTip);
    assert.ok(localBranchExists(wt, "a-first"));
    assert.equal(localBranchExists(wt, "z-last"), changed === "main");
    assert.match(output, /failed: a-first.*expected-commit ref transaction failed/);
    assert.match(output, changed === "main" ? /not run: z-last.*comparison base changed/ : /deleted: z-last/);
    assert.match(output, /no rollback or force retry/);
    assert.doesNotMatch(readFileSync(log, "utf8"), /(?:branch -[dD]|^clone |^fetch )/m);
  }
});
