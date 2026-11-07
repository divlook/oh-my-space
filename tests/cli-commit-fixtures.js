import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { run, writeSources, git, initBareUpstream, initGitWorkspace, sourcesFor, tempFixture } from "./helpers.js";

let template;

export function workspaceWithThree() {
  template ??= createWorkspaceWithThree();
  const bares = Object.fromEntries(Object.keys(template.bares).map((alias) => [alias, initBareUpstream()]));
  const cwd = tempFixture("oms-three-");
  cpSync(template.cwd, cwd, { recursive: true });
  writeSources(cwd, sourcesFor(Object.entries(bares).map(([alias, bare]) => ({ alias, bare }))));
  for (const [alias, bare] of Object.entries(bares)) {
    const url = `file://${bare}`;
    git(cwd, "config", "-f", ".gitmodules", `submodule.oms/${alias}.url`, url);
    git(cwd, "config", `submodule.oms/${alias}.url`, url);
    git(join(cwd, "oms", alias), "remote", "set-url", "origin", url);
  }
  git(cwd, "add", "oms.yaml", ".gitmodules");
  git(cwd, "commit", "--amend", "--no-edit");
  return { cwd, bares };
}

function createWorkspaceWithThree() {
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
