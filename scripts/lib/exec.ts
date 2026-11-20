import { log } from "@clack/prompts";
import { spawn, type ChildProcess } from "node:child_process";
import { aliasRegistration, canonicalCheckoutOwned, pendingRegistrationGuidance } from "./alias-registration.js";
import { aliasDir, submoduleInitialized } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { selectRepos } from "./prompts.js";
import { refuseInsideManagedTree } from "./tree-context.js";
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
  if (registration.kind === "pending registration") return pendingRegistrationGuidance(alias);
  const repair = `State preserved; run "oms sync ${alias}".`;
  if (registration.kind === "partially registered") return `${registration.kind}: ${registration.reason}. ${repair}`;
  if (registration.kind === "indeterminate") return `${registration.reason}. State preserved; retry once Git is idle.`;
  if (registration.kind !== "initialized") return `${registration.kind}. ${repair}`;
  if (!submoduleInitialized(repoRoot, alias)) return `checkout is not initialized. ${repair}`;
  return canonicalCheckoutOwned(repoRoot, alias)
    ? null
    : `checkout does not belong to the declared canonical submodule. ${repair}`;
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
  // Manifest validation guarantees a nonempty selection domain; target state is rechecked per child.
  if (refuseInsideManagedTree(repoRoot)) return 1;
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
          result = { kind: "target", reason: failure };
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
