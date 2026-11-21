import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { run, git, gitOut, initEmptyBare, initGitWorkspace, sourceFor, workspaceWithApi, writeSources } from "./helpers.js";

test("commit rejects an unanchored detached source HEAD without touching the root", () => {
  const { cwd, wt } = workspaceWithApi();
  git(wt, "commit", "--allow-empty", "-m", "detached tip");
  const detached = gitOut(wt, "rev-parse", "HEAD");
  git(wt, "checkout", "--detach");
  git(wt, "branch", "-f", "main", "HEAD^");
  writeFileSync(join(wt, "work.txt"), "uncommitted");
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");

  const result = run(["commit", "api", "-m", "x"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /detached HEAD/);
  assert.match(output, /oms branch switch api/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), detached);
  assert.equal(gitOut(wt, "status", "--porcelain"), "?? work.txt");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
});

test("commit infers the alias inside an existing independent checkout", () => {
  const { cwd, wt } = workspaceWithApi();
  const rootHeadBefore = gitOut(cwd, "rev-parse", "HEAD");
  const clean = run(["commit"], { cwd: wt });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout + clean.stderr, /Nothing to commit for api/);

  writeFileSync(join(wt, "work.txt"), "source-only work");
  const missingMessage = run(["commit"], { cwd: wt });
  assert.equal(missingMessage.status, 1, missingMessage.stdout + missingMessage.stderr);
  assert.match(missingMessage.stdout + missingMessage.stderr, /-m is required/);
  assert.equal(gitOut(wt, "status", "--porcelain"), "?? work.txt");

  const result = run(["commit", "-m", "feat: inferred", "-m", "Details"], { cwd: wt });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(gitOut(wt, "log", "-1", "--format=%B"), "feat: inferred\n\nDetails");
  assert.equal(gitOut(wt, "show", "HEAD:work.txt"), "source-only work");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHeadBefore);
  assert.equal(gitOut(cwd, "status", "--porcelain"), "");
});

test("commit uses the source index first and leaves staged root work untouched", () => {
  const { cwd, wt } = workspaceWithApi();
  writeFileSync(join(cwd, "keep.txt"), "root work");
  git(cwd, "add", "keep.txt");
  const rootHead = gitOut(cwd, "rev-parse", "HEAD");
  const rootIndex = gitOut(cwd, "diff", "--cached", "--binary");
  writeFileSync(join(wt, "source.txt"), "staged snapshot");
  git(wt, "add", "source.txt");
  writeFileSync(join(wt, "source.txt"), "unstaged revision");
  writeFileSync(join(wt, "untracked.txt"), "new work");

  const first = run(["commit", "api", "-m", "feat: staged only"], { cwd });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout + first.stderr, /committed staged changes only/);
  assert.equal(gitOut(wt, "show", "HEAD:source.txt"), "staged snapshot");
  assert.equal(gitOut(wt, "status", "--porcelain"), "M source.txt\n?? untracked.txt");

  const second = run(["commit", "api", "-m", "feat: remaining changes"], { cwd });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(gitOut(wt, "show", "HEAD:source.txt"), "unstaged revision");
  assert.equal(gitOut(wt, "show", "HEAD:untracked.txt"), "new work");
  assert.equal(gitOut(wt, "status", "--porcelain"), "");
  assert.equal(gitOut(cwd, "rev-parse", "HEAD"), rootHead);
  assert.equal(gitOut(cwd, "diff", "--cached", "--binary"), rootIndex);
});

test("push --remote with an unknown remote fails for that repo", () => {
  const { cwd } = workspaceWithApi();
  const result = run(["push", "api", "--remote", "nope"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /unknown remote\(s\): nope/);
});

test("pull rejects more than one --remote", () => {
  const { cwd, bare, wt } = workspaceWithApi();
  writeSources(cwd, sourceFor("api", bare, "main", { upstream: initEmptyBare() }));
  const head = gitOut(wt, "rev-parse", "HEAD");
  const result = run(["pull", "api", "--remote", "origin", "--remote", "upstream"], { cwd });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /pull targets a single remote/);
  assert.equal(gitOut(wt, "rev-parse", "HEAD"), head);
  assert.equal(gitOut(wt, "remote"), "origin");
});

test("legacy url key points to the 0.7.0 migration doc", () => {
  const cwd = initGitWorkspace();
  writeSources(cwd, "repos:\n  - alias: api\n    url: git@example.com:org/repo.git\n");
  const result = run(["clone", "api"], { cwd });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /url is no longer supported/);
  assert.match(output, /https:\/\/github\.com\/divlook\/oh-my-space\/blob\/[^/\s]+\/docs\/migrations\/0\.6\.x-to-0\.7\.0\.md/);
});
