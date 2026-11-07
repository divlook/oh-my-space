import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { run, writeSources, git, initBareUpstream, initGitWorkspace, sourcesFor } from "./helpers.js";

export function workspaceWithThree() {
  const bares = { api: initBareUpstream(), web: initBareUpstream(), core: initBareUpstream() };
  const cwd = initGitWorkspace();
  writeSources(cwd, sourcesFor(Object.entries(bares).map(([alias, bare]) => ({ alias, bare }))));
  assert.equal(run(["sync", "--all", "--no-commit"], { cwd }).status, 0);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "add submodules");
  return { cwd, bares };
}

export function movePointer(cwd, alias, content = "x") {
  const wt = join(cwd, "oms", alias);
  writeFileSync(join(wt, "f.txt"), content);
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "work");
}
