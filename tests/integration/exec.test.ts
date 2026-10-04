import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runExec } from "../../scripts/lib/exec.js";
import { configIdentity, git, gitOut, initBareUpstream, initGitWorkspace, sourceFor, syncedSubmodule, tempFixture, testEnv } from "../helpers.js";
Object.assign(process.env, testEnv);

function workspace() {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  syncedSubmodule(cwd, "api", bare);
  syncedSubmodule(cwd, "web", bare);
  writeSources(cwd, bare, ["api", "web"]);
  git(cwd, "add", "oms.yaml");
  git(cwd, "commit", "-m", "declare both");
  return { cwd, bare };
}
function writeSources(cwd: string, bare: string, aliases: string[]) {
  writeFileSync(join(cwd, "oms.yaml"), "repos:\n" + aliases.map(alias => sourceFor(alias, bare).replace("repos:\n", "")).join(""));
}
function snapshot(cwd: string) {
  return { head: gitOut(cwd, "rev-parse", "HEAD"), index: gitOut(cwd, "ls-files", "--stage"),
    branch: gitOut(cwd, "rev-parse", "--abbrev-ref", "HEAD"), status: gitOut(cwd, "status", "--porcelain"), config: gitOut(cwd, "config", "--local", "--list") };
}
async function at(cwd: string, action: () => Promise<number>) {
  const previous = process.cwd();
  process.chdir(cwd);
  try { return await action(); } finally { process.chdir(previous); }
}

test("exec accepts dirty detached canonical targets without changing root or source Git state", async () => {
  const { cwd } = workspace();
  const api = join(cwd, "oms", "api");
  git(api, "checkout", "--detach");
  writeFileSync(join(api, "dirty.txt"), "keep");
  git(api, "remote", "set-url", "origin", "/unreachable/exec-test");
  const paths = [cwd, api, join(cwd, "oms", "web")];
  const before = paths.map(snapshot);
  assert.equal(await at(cwd, () => runExec(["api", "web"], {}, [process.execPath, "-e", "console.log(process.cwd())"])), 0);
  assert.deepEqual(paths.map(snapshot), before);
});

test("exec fails unavailable and foreign targets individually without preparation and continues healthy targets", async () => {
  const { cwd, bare } = workspace();
  const cloned = tempFixture("exec-uninit-");
  execFileSync("git", ["clone", cwd, cloned], { env: testEnv, stdio: "ignore" });
  configIdentity(cloned);
  const beforeClone = snapshot(cloned);
  assert.equal(await at(cloned, () => runExec([], { all: true }, [process.execPath, "-e", "require('fs').writeFileSync('ran','bad')"])), 2);
  assert.equal(existsSync(join(cloned, "oms", "api", ".git")), false);
  assert.deepEqual(snapshot(cloned), beforeClone);
  renameSync(join(cwd, "oms", "api"), join(cwd, "saved-api"));
  mkdirSync(join(cwd, "oms", "api"));
  git(join(cwd, "oms", "api"), "init");
  writeFileSync(join(cwd, "oms", "api", "foreign"), "keep");
  writeSources(cwd, bare, ["api", "missing", "web"]);
  const before = snapshot(cwd);
  assert.equal(await at(cwd, () => runExec([], { all: true }, [process.execPath, "-e", "require('fs').writeFileSync('ran','yes')"])), 2);
  assert.equal(existsSync(join(cwd, "oms", "api", "ran")), false);
  assert.equal(readFileSync(join(cwd, "oms", "api", "foreign"), "utf8"), "keep");
  assert.equal(existsSync(join(cwd, "oms", "missing")), false);
  assert.equal(readFileSync(join(cwd, "oms", "web", "ran"), "utf8"), "yes");
  assert.deepEqual({ ...snapshot(cwd), status: before.status }, before);
});

test("exec preserves literal arguments and failure effects while running unique aliases sequentially", async () => {
  const { cwd } = workspace();
  const order = join(cwd, "order.jsonl");
  const args = ["space value", "", "*", ";", "$HOME", "--all", "--help", "--"];
  const script = `const fs=require('fs'),path=require('path'); const alias=path.basename(process.cwd()); fs.appendFileSync(${JSON.stringify(order)},JSON.stringify([alias,process.argv.slice(1),process.env.EXEC_INHERITED])+'\\n'); if(alias==='web') { fs.writeFile('failed-effect','keep',()=>{fs.appendFileSync(${JSON.stringify(order)},JSON.stringify(['web-finished'])+'\\n');process.exit(7)}); }`;
  process.env.EXEC_INHERITED = "inherited";
  try {
    assert.equal(await at(cwd, () => runExec(["web", "api", "web"], {}, [process.execPath, "-e", script, "--", ...args])), 2);
  } finally { delete process.env.EXEC_INHERITED; }
  assert.deepEqual(readFileSync(order, "utf8").trim().split("\n").map(line => JSON.parse(line)), [["web", args, "inherited"], ["web-finished"], ["api", args, "inherited"]]);
  assert.equal(readFileSync(join(cwd, "oms", "web", "failed-effect"), "utf8"), "keep");
  assert.equal(await at(cwd, () => runExec(["api", "web"], {}, [join(cwd, "no-such-executable")])), 2);
});

test("exec rechecks later targets after a child changes their registration", async () => {
  const { cwd } = workspace();
  const script = "const fs=require('fs');fs.renameSync('../web','../saved-web');fs.writeFileSync('ran','yes')";
  assert.equal(await at(cwd, () => runExec(["api", "web"], {}, [process.execPath, "-e", script])), 2);
  assert.equal(readFileSync(join(cwd, "oms", "api", "ran"), "utf8"), "yes");
  assert.equal(existsSync(join(cwd, "oms", "saved-web", "ran")), false);
});
