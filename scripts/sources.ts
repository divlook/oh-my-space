#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { cancel, isCancel, log, multiselect } from "@clack/prompts";
import sourcesData from "../sources.yaml";

type Repo = {
  alias: string;
  url: string;
  branch?: string;
};

type SourcesOptions = {
  all?: boolean;
  list?: boolean;
};

type OperationResult = "added" | "updated" | "fetched" | "pulled" | "pushed" | "failed";

type GitResult = {
  exitCode: number | null;
  success: boolean;
  stdout: string;
};

type ManageCommand = "fetch" | "pull" | "push";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_TOP_KEYS = new Set(["repos"]);
const ALLOWED_ITEM_KEYS = new Set(["alias", "url", "branch"]);
const MANAGE_GIT_ARGS: Record<ManageCommand, string[]> = {
  fetch: ["fetch", "--all", "--prune"],
  pull: ["pull", "--ff-only"],
  push: ["-c", "push.autoSetupRemote=false", "push"],
};
const RESULT_BY_COMMAND: Record<ManageCommand, OperationResult> = {
  fetch: "fetched",
  pull: "pulled",
  push: "pushed",
};

const useColor = process.stdout.isTTY;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

function validateSources(data: unknown): Repo[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("sources.yaml: root must be a mapping");
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`sources.yaml: unknown top-level key "${key}"`);
    }
  }
  const { repos } = obj;
  if (!Array.isArray(repos)) {
    throw new Error('sources.yaml: "repos" must be an array');
  }
  if (repos.length === 0) {
    throw new Error('sources.yaml: "repos" must have at least one item');
  }

  const validated: Repo[] = [];
  const seen = new Set<string>();

  repos.forEach((item, idx) => {
    const where = `repos[${idx}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`sources.yaml: ${where} must be a mapping`);
    }
    const r = item as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!ALLOWED_ITEM_KEYS.has(key)) {
        throw new Error(`sources.yaml: ${where} has unknown key "${key}"`);
      }
    }
    if (typeof r.alias !== "string" || r.alias.length === 0) {
      throw new Error(`sources.yaml: ${where} missing required "alias"`);
    }
    if (!ALIAS_PATTERN.test(r.alias)) {
      throw new Error(
        `sources.yaml: ${where}.alias "${r.alias}" must match ${ALIAS_PATTERN}`,
      );
    }
    if (seen.has(r.alias)) {
      throw new Error(`sources.yaml: duplicate alias "${r.alias}"`);
    }
    seen.add(r.alias);
    if (typeof r.url !== "string" || r.url.length === 0) {
      throw new Error(`sources.yaml: ${where} missing required "url"`);
    }
    let branch: string | undefined;
    if (r.branch !== undefined) {
      if (typeof r.branch !== "string" || r.branch.length === 0) {
        throw new Error(`sources.yaml: ${where}.branch must be a non-empty string`);
      }
      branch = r.branch;
    }
    validated.push({ alias: r.alias, url: r.url, branch });
  });

  return validated;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

function printList(repos: Repo[]): void {
  const aliasW = Math.max("ALIAS".length, ...repos.map((r) => r.alias.length));
  const urlW = Math.max("URL".length, ...repos.map((r) => r.url.length));
  console.log(dim(`${pad("ALIAS", aliasW)}  ${pad("URL", urlW)}  BRANCH`));
  for (const r of repos) {
    console.log(`${pad(r.alias, aliasW)}  ${pad(r.url, urlW)}  ${r.branch ?? ""}`);
  }
}

async function selectInteractive(repos: Repo[], actionLabel: string): Promise<Repo[] | null> {
  const choice = await multiselect({
    message: `Select source repos to ${actionLabel} (space to toggle, enter to confirm)`,
    options: repos.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice
    .map((alias) => repos.find((r) => r.alias === alias))
    .filter((r): r is Repo => r !== undefined);
}

function runGit(cwd: string, args: string[], inheritOutput = false): GitResult {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: inheritOutput ? "inherit" : "pipe",
    stderr: inheritOutput ? "inherit" : "pipe",
  });

  return {
    exitCode: result.exitCode,
    success: result.success,
    stdout: inheritOutput ? "" : new TextDecoder().decode(result.stdout),
  };
}

function isRegisteredSubmodule(repoRoot: string, sourcePath: string): boolean {
  if (!existsSync(join(repoRoot, ".gitmodules"))) return false;

  const result = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!result.success) return false;

  return result.stdout
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[1] === sourcePath);
}

function isCheckedOutGitRepo(repoRoot: string, sourcePath: string): boolean {
  const dest = join(repoRoot, sourcePath);
  if (!existsSync(dest)) return false;

  const result = runGit(dest, ["rev-parse", "--is-inside-work-tree"]);
  return result.success && result.stdout.trim() === "true";
}

function syncSubmodule(repo: Repo, repoRoot: string): OperationResult {
  const sourcePath = `sources/${repo.alias}`;
  const dest = join(repoRoot, sourcePath);
  const registered = isRegisteredSubmodule(repoRoot, sourcePath);

  if (!registered && existsSync(dest)) {
    log.error(
      `${repo.alias}: ${sourcePath} already exists but is not registered as a git submodule. Move or remove it manually, then retry.`,
    );
    return "failed";
  }

  const args = registered
    ? ["submodule", "update", "--init", "--recursive", sourcePath]
    : [
        "submodule",
        "add",
        "--name",
        repo.alias,
        ...(repo.branch ? ["--branch", repo.branch] : []),
        repo.url,
        sourcePath,
      ];

  log.step(`git ${args.join(" ")}`);
  const result = runGit(repoRoot, args, true);
  if (result.success) {
    log.success(`${repo.alias}: ${registered ? "updated" : "added"}`);
    return registered ? "updated" : "added";
  }

  log.error(
    `${repo.alias}: submodule ${registered ? "update" : "add"} failed (exit ${result.exitCode})`,
  );
  return "failed";
}

function manageSubmodule(repo: Repo, repoRoot: string, command: ManageCommand): OperationResult {
  const sourcePath = `sources/${repo.alias}`;
  if (!isRegisteredSubmodule(repoRoot, sourcePath) || !isCheckedOutGitRepo(repoRoot, sourcePath)) {
    log.error(
      `${repo.alias}: ${sourcePath} is not a checked-out source submodule. Run "bun run sources sync ${repo.alias}" first.`,
    );
    return "failed";
  }

  const sourceWorktree = join(repoRoot, sourcePath);
  if (command === "push") {
    const upstream = runGit(sourceWorktree, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    if (!upstream.success) {
      log.error(
        `${repo.alias}: git push requires the current branch to have an upstream. Set it manually before pushing.`,
      );
      return "failed";
    }
  }

  const args = MANAGE_GIT_ARGS[command];
  log.step(`${repo.alias}: git ${args.join(" ")}`);
  const result = runGit(sourceWorktree, args, true);
  if (result.success) {
    const operation = RESULT_BY_COMMAND[command];
    log.success(`${repo.alias}: ${operation}`);
    return operation;
  }

  log.error(`${repo.alias}: git ${command} failed (exit ${result.exitCode})`);
  return "failed";
}

function printSummary(results: OperationResult[]): void {
  const counts: Record<OperationResult, number> = {
    added: 0,
    updated: 0,
    fetched: 0,
    pulled: 0,
    pushed: 0,
    failed: 0,
  };
  for (const r of results) counts[r]++;

  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  log.message(`Summary: ${parts.join(", ")}`);
}

function exitFromResults(results: OperationResult[]): number {
  return results.includes("failed") ? 2 : 0;
}

function loadRepos(): Repo[] | null {
  try {
    return validateSources(sourcesData);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    if (seen.has(alias)) return false;
    seen.add(alias);
    return true;
  });
}

async function selectRepos(
  repos: Repo[],
  aliases: string[],
  options: SourcesOptions,
  actionLabel: string,
): Promise<Repo[] | null> {
  if (options.all) return repos;

  if (aliases.length === 0) {
    return selectInteractive(repos, actionLabel);
  }

  const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
  if (unknown.length > 0) {
    log.error(
      `Unknown alias(es): ${unknown.join(", ")}. Use "bun run sources sync --list" to see available aliases.`,
    );
    return null;
  }

  const byAlias = new Map(repos.map((repo) => [repo.alias, repo]));
  return uniqueAliases(aliases).map((alias) => byAlias.get(alias)!);
}

async function runSync(aliases: string[], options: SourcesOptions): Promise<number> {
  const repos = loadRepos();
  if (!repos) return 1;

  if (options.list) {
    printList(repos);
    return 0;
  }

  const picked = await selectRepos(repos, aliases, options, "sync");
  if (!picked || picked.length === 0) return 1;

  const repoRoot = resolve(import.meta.dir, "..");
  const results = picked.map((repo) => syncSubmodule(repo, repoRoot));
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runManage(
  command: ManageCommand,
  aliases: string[],
  options: SourcesOptions,
): Promise<number> {
  const repos = loadRepos();
  if (!repos) return 1;

  const picked = await selectRepos(repos, aliases, options, command);
  if (!picked || picked.length === 0) return 1;

  const repoRoot = resolve(import.meta.dir, "..");
  const results = picked.map((repo) => manageSubmodule(repo, repoRoot, command));
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function exitWith(action: Promise<number>): Promise<void> {
  try {
    process.exit(await action);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const exitHelp = "\nExit codes: 0 ok | 1 usage/config error | 2 one or more git operations failed.";
const commandNames = new Set(["sync", "fetch", "pull", "push", "help"]);
const program = new Command();

program
  .name("bun run sources")
  .description("Manage source repositories listed in sources.yaml under sources/<alias>/.")
  .addHelpText("after", exitHelp);

program
  .command("sync")
  .description("Sync sources.yaml entries into git submodules under sources/<alias>/.")
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runSync(aliases, options));
  });

program
  .command("fetch")
  .description("Run git fetch --all --prune inside checked-out source submodule worktrees.")
  .argument("[aliases...]", "repo aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every registered source repo")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runManage("fetch", aliases, options));
  });

program
  .command("pull")
  .description("Run git pull --ff-only inside checked-out source submodule worktrees; requires branch/upstream.")
  .argument("[aliases...]", "repo aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every registered source repo")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runManage("pull", aliases, options));
  });

program
  .command("push")
  .description("Run git push inside explicit source submodule worktrees; no --all, force, or upstream setup.")
  .argument("<aliases...>", "repo aliases to push")
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[]) => {
    await exitWith(runManage("push", aliases, {}));
  });

const requestedCommand = process.argv[2];
if (
  requestedCommand &&
  !requestedCommand.startsWith("-") &&
  !commandNames.has(requestedCommand)
) {
  console.error(`error: unknown command '${requestedCommand}'`);
  process.exit(1);
}

await program.parseAsync();
