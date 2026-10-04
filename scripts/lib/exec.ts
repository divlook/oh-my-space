import { log } from "@clack/prompts";
import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { aliasRegistration } from "./alias-preparation.js";
import { aliasDir, runGit, submoduleInitialized, submodulePath } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { selectRepos } from "./prompts.js";
import { refuseInsideManagedTree } from "./tree-ops.js";
import type { SourcesOptions } from "./types.js";

type ExecResult =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: NodeJS.Signals }
  | { kind: "spawn"; reason: string }
  | { kind: "target"; reason: string }
  | { kind: "interrupted" }
  | { kind: "not-run" };

function targetFailure(repoRoot: string, alias: string): string | null {
  const registration = aliasRegistration(repoRoot, alias);
  if (registration !== "initialized") return registration;
  if (!submoduleInitialized(repoRoot, alias)) return "checkout is not initialized";
  const cwd = aliasDir(repoRoot, alias);
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const actual = runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
  const expected = runGit(repoRoot, ["rev-parse", "--git-path", `modules/${submodulePath(alias)}`]);
  try {
    if (top.success && actual.success && expected.success
      && realpathSync(top.stdout.trim()) === realpathSync(cwd)
      && realpathSync(actual.stdout.trim()) === realpathSync(resolve(repoRoot, expected.stdout.trim()))) return null;
  } catch {
    // Missing or foreign Git metadata is not an eligible canonical checkout.
  }
  return "checkout does not belong to the declared canonical submodule";
}

function describe(result: ExecResult): string {
  switch (result.kind) {
    case "exit": return `exit ${result.code}`;
    case "signal": return `signal ${result.signal}`;
    case "spawn": return `spawn failure: ${result.reason}`;
    case "target": return `target failure: ${result.reason}`;
    case "interrupted": return "interrupted";
    case "not-run": return "not run (interrupted invocation)";
  }
}

export async function runExec(aliases: string[], options: SourcesOptions, command: string[]): Promise<number> {
  const [executable, ...args] = command;
  if (!executable) {
    log.error("Usage: oms exec [aliases...] [--all] -- <command> [args...]");
    return 1;
  }
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;
  if (repos.length === 0) {
    log.error("No repositories declared in the workspace.");
    return 1;
  }
  const picked = await selectRepos(repos, aliases, options, "exec");
  if (!picked || picked.length === 0) return 1;

  const results: { alias: string; result: ExecResult }[] = [];
  let interrupted = false;
  let active: ChildProcess | undefined;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    active?.kill("SIGINT");
  };
  process.on("SIGINT", interrupt);
  try {
    for (const repo of picked) {
      let result: ExecResult;
      if (interrupted) {
        result = { kind: "not-run" };
      } else {
        const failure = targetFailure(repoRoot, repo.alias);
        if (failure) {
          result = { kind: "target", reason: `${failure}. State preserved; run \"oms sync ${repo.alias}\".` };
        } else {
          log.step(`${repo.alias}: exec`);
          result = await new Promise<ExecResult>((complete) => {
            let spawnError: Error | undefined;
            try {
              active = spawn(executable, args, { cwd: aliasDir(repoRoot, repo.alias), shell: false, stdio: "inherit" });
            } catch (error) {
              complete({ kind: "spawn", reason: error instanceof Error ? error.message : String(error) });
              return;
            }
            active.once("error", (error) => { spawnError = error; });
            active.once("close", (code, signal) => {
              active = undefined;
              if (signal === "SIGINT") interrupted = true;
              if (interrupted) complete({ kind: "interrupted" });
              else if (spawnError) complete({ kind: "spawn", reason: spawnError.message });
              else if (signal) complete({ kind: "signal", signal });
              else complete({ kind: "exit", code: code ?? 1 });
            });
          });
        }
      }
      results.push({ alias: repo.alias, result });
      log.info(`${repo.alias}: ${describe(result)}`);
    }
  } finally {
    process.off("SIGINT", interrupt);
  }
  log.step("Execution summary");
  for (const { alias, result } of results) log.info(`${alias}: ${describe(result)}`);
  if (interrupted) return 130;
  return results.every(({ result }) => result.kind === "exit" && result.code === 0) ? 0 : 2;
}
