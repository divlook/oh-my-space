import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  cli, git, initBareUpstream, initGitWorkspace, run, sourcesFor,
  syncedSubmodule, testEnv, writeSources,
} from "./helpers.js";

function workspace(aliases = ["api", "web"]) {
  const cwd = initGitWorkspace();
  const bare = initBareUpstream();
  for (const alias of aliases) syncedSubmodule(cwd, alias, bare);
  writeSources(cwd, sourcesFor(aliases.map((alias) => ({ alias, bare }))));
  git(cwd, "add", "oms.yaml");
  git(cwd, "commit", "--allow-empty", "-m", "record full manifest");
  return cwd;
}

function childScript(cwd, content) {
  const file = join(cwd, "exec-child.cjs");
  writeFileSync(file, content);
  return file;
}

function start(t, cwd, aliases, script) {
  const process = spawn(globalThis.process.execPath, [cli, "exec", ...aliases, "--", globalThis.process.execPath, script], {
    cwd, env: testEnv, stdio: ["pipe", "pipe", "pipe"],
  });
  const events = new EventEmitter();
  const state = { process, stdout: "", stderr: "", closed: false };
  for (const stream of ["stdout", "stderr"]) {
    process[stream].setEncoding("utf8");
    process[stream].on("data", (text) => {
      state[stream] += text;
      events.emit("change");
    });
  }
  state.close = new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code, signal) => {
      state.closed = true;
      events.emit("change");
      resolve({ code, signal });
    });
  });
  state.until = (predicate) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Child handshake timed out\n${state.stdout}\n${state.stderr}`)), 10000);
    function finish(error) {
      clearTimeout(timer);
      events.off("change", check);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (predicate()) finish();
      else if (state.closed) finish(new Error(`OMS closed before child handshake\n${state.stdout}\n${state.stderr}`));
    }
    events.on("change", check);
    check();
  });
  t.after(async () => {
    if (!state.closed) {
      for (const match of state.stdout.matchAll(/CHILD_PID:(\d+)/g)) {
        try { globalThis.process.kill(Number(match[1]), "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      process.kill("SIGKILL");
    }
    await state.close;
  });
  return state;
}

function assertStopped(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

const reportScript = `
  const fs = require('node:fs');
  const path = require('node:path');
  const report = { alias: path.basename(process.cwd()), cwd: fs.realpathSync(process.cwd()), argv: process.argv.slice(2) };
  fs.appendFileSync(path.resolve('..', '..', 'runs.jsonl'), JSON.stringify(report) + '\\n');
  console.log('REPORT:' + JSON.stringify(report));
`;

function reports(cwd) {
  return readFileSync(join(cwd, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("exec production routing preserves literal child arguments and explicit alias order", () => {
  const cwd = workspace();
  const script = childScript(cwd, reportScript);
  const args = ["two words", "", "*", ";", "$HOME", "--all", "--help", "--"];
  const result = run(["exec", "web", "api", "web", "--", process.execPath, script, ...args], { cwd, timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const rows = reports(cwd);
  assert.deepEqual(rows.map((row) => row.alias), ["web", "api"]);
  for (const row of rows) {
    assert.deepEqual(row.argv, args);
    assert.equal(row.cwd, realpathSync(join(cwd, "oms", row.alias)));
  }
  assert.match(result.stdout, /web/);
  assert.match(result.stdout, /api/);
});

test("exec --all routes manifest order and takes precedence over explicit aliases", () => {
  const cwd = workspace();
  const script = childScript(cwd, reportScript);
  for (const selection of [["--all"], ["web", "unknown", "--all"]]) {
    const result = run(["exec", ...selection, "--", process.execPath, script], { cwd, timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(reports(cwd).map((row) => row.alias), ["api", "web", "api", "web"]);
});

test("exec rejects invalid selection and missing command boundaries before starting any child", () => {
  const cwd = workspace();
  const script = childScript(cwd, reportScript);
  const cases = [
    ["exec", "api", "unknown", "--", process.execPath, script],
    ["exec", "--", process.execPath, script],
    ["exec", "api", process.execPath, script],
    ["exec", "api", "--"],
    ["exec", "api", "--", "", script],
    ["exec", "--"],
  ];
  for (const args of cases) {
    const result = run(args, { cwd, timeout: 10000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(existsSync(join(cwd, "runs.jsonl")), false);
    if (args[1] === "--" && args.length > 2) {
      assert.match(result.stdout + result.stderr, /--all/);
      assert.match(result.stdout + result.stderr, /alias/i);
    }
  }
});

test("exec streams stdout and stderr live and inherits stdin before the child closes", { timeout: 20000 }, async (t) => {
  const cwd = workspace(["api"]);
  const script = childScript(cwd, `
    process.stdin.once('data', data => {
      console.log('INPUT:' + data.toString().trim());
      process.exit(0);
    });
    console.log('LIVE_STDOUT');
    console.error('LIVE_STDERR');
  `);
  const state = start(t, cwd, ["api"], script);
  await state.until(() => state.stdout.includes("LIVE_STDOUT") && state.stderr.includes("LIVE_STDERR"));
  assert.equal(state.closed, false);
  assert.equal(state.process.exitCode, null);
  state.process.stdin.end("caller input\n");
  assert.deepEqual(await state.close, { code: 0, signal: null });
  assert.match(state.stdout, /INPUT:caller input/);
});

test("exec parent-only SIGINT waits for child closure and preserves completed effects", { timeout: 20000 }, async (t) => {
  const cwd = workspace(["api", "web", "later"]);
  const script = childScript(cwd, `
    const fs = require('node:fs');
    const alias = require('node:path').basename(process.cwd());
    fs.writeFileSync('effect.txt', alias);
    if (alias !== 'web') process.exit(0);
    process.on('SIGINT', () => console.log('INTERRUPT_RECEIVED'));
    process.stdin.once('data', () => {
      fs.writeFileSync('closed.txt', 'closed');
      process.exit(23);
    });
    console.log('CHILD_PID:' + process.pid);
    console.log('CHILD_READY');
  `);
  const state = start(t, cwd, ["api", "web", "later"], script);
  await state.until(() => state.stdout.includes("CHILD_READY"));
  const pid = Number(state.stdout.match(/CHILD_PID:(\d+)/)[1]);
  state.process.kill("SIGINT");
  await state.until(() => state.stdout.includes("INTERRUPT_RECEIVED"));
  assert.equal(state.closed, false);
  assert.equal(existsSync(join(cwd, "oms", "web", "closed.txt")), false);
  assert.equal(existsSync(join(cwd, "oms", "later", "effect.txt")), false);
  state.process.stdin.end("release\n");
  assert.deepEqual(await state.close, { code: 130, signal: null });
  assertStopped(pid);
  assert.equal(readFileSync(join(cwd, "oms", "api", "effect.txt"), "utf8"), "api");
  assert.equal(readFileSync(join(cwd, "oms", "web", "closed.txt"), "utf8"), "closed");
  assert.equal(existsSync(join(cwd, "oms", "later", "effect.txt")), false);
  assert.match(state.stdout + state.stderr, /web.*interrupt/i);
  assert.match(state.stdout + state.stderr, /later.*not run/i);
});

test("exec child-first SIGINT interrupts the invocation without starting later targets", { timeout: 20000 }, async (t) => {
  const cwd = workspace(["api", "web", "later"]);
  const script = childScript(cwd, `
    const fs = require('node:fs');
    const alias = require('node:path').basename(process.cwd());
    fs.writeFileSync('effect.txt', alias);
    if (alias !== 'web') process.exit(0);
    setInterval(() => {}, 1000);
    console.log('CHILD_PID:' + process.pid);
    console.log('CHILD_READY');
  `);
  const state = start(t, cwd, ["api", "web", "later"], script);
  await state.until(() => state.stdout.includes("CHILD_READY"));
  const pid = Number(state.stdout.match(/CHILD_PID:(\d+)/)[1]);
  process.kill(pid, "SIGINT");
  assert.deepEqual(await state.close, { code: 130, signal: null });
  assertStopped(pid);
  assert.equal(readFileSync(join(cwd, "oms", "api", "effect.txt"), "utf8"), "api");
  assert.equal(readFileSync(join(cwd, "oms", "web", "effect.txt"), "utf8"), "web");
  assert.equal(existsSync(join(cwd, "oms", "later", "effect.txt")), false);
  assert.match(state.stdout + state.stderr, /web.*interrupt/i);
  assert.match(state.stdout + state.stderr, /later.*not run/i);
});

test("exec continues after a ready child receives a non-SIGINT signal", { timeout: 20000 }, async (t) => {
  const cwd = workspace();
  const script = childScript(cwd, `
    const fs = require('node:fs');
    const alias = require('node:path').basename(process.cwd());
    fs.writeFileSync('effect.txt', alias);
    if (alias === 'web') process.exit(0);
    setInterval(() => {}, 1000);
    console.log('CHILD_PID:' + process.pid);
    console.log('CHILD_READY');
  `);
  const state = start(t, cwd, ["api", "web"], script);
  await state.until(() => state.stdout.includes("CHILD_READY"));
  const pid = Number(state.stdout.match(/CHILD_PID:(\d+)/)[1]);
  process.kill(pid, "SIGTERM");
  assert.deepEqual(await state.close, { code: 2, signal: null });
  assertStopped(pid);
  assert.equal(readFileSync(join(cwd, "oms", "web", "effect.txt"), "utf8"), "web");
  assert.match(state.stdout + state.stderr, /api.*SIGTERM/);
});
