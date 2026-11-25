import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { configIdentity, git, initBareUpstream, initGitWorkspace, sourcesFor, testEnv, writeSources } from "./helpers.js";

export function workspaceWithThree() {
  const bares = { api: initBareUpstream(), web: initBareUpstream(), core: initBareUpstream() };
  const cwd = initGitWorkspace();
  const entries = Object.entries(bares);
  writeSources(cwd, sourcesFor(entries.map(([alias, bare]) => ({ alias, bare }))));
  appendFileSync(join(cwd, ".git", "info", "exclude"), entries.map(([alias]) => `\n/oms/${alias}/\n`).join(""));
  git(cwd, "add", "oms.yaml");
  git(cwd, "commit", "-m", "declare sources");
  for (const [alias, bare] of entries) {
    const wt = join(cwd, "oms", alias);
    execFileSync("git", ["clone", `file://${bare}`, wt], { stdio: "ignore", env: testEnv });
    configIdentity(wt);
  }
  return { cwd, bares };
}
