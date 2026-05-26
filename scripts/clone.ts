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

type CloneResult = "cloned" | "skipped" | "failed";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_TOP_KEYS = new Set(["repos"]);
const ALLOWED_ITEM_KEYS = new Set(["alias", "url", "branch"]);

const useColor = process.stdout.isTTY;
const dim = (s: string) =>
  useColor ? `\x1b[2m${s}\x1b[0m` : s;

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
    console.log(
      `${pad(r.alias, aliasW)}  ${pad(r.url, urlW)}  ${r.branch ?? ""}`,
    );
  }
}

async function selectInteractive(repos: Repo[]): Promise<Repo[] | null> {
  const choice = await multiselect({
    message: "Select repos to clone (space to toggle, enter to confirm)",
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

function cloneOne(repo: Repo, sourcesDir: string): CloneResult {
  const dest = join(sourcesDir, repo.alias);
  if (existsSync(dest)) {
    log.warn(`${repo.alias}: ${dest} already exists, skipping`);
    return "skipped";
  }
  const args = ["clone"];
  if (repo.branch) args.push("--branch", repo.branch);
  args.push(repo.url, dest);

  log.step(`git ${args.join(" ")}`);
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.success) {
    log.success(`${repo.alias}: cloned`);
    return "cloned";
  }
  log.error(`${repo.alias}: clone failed (exit ${result.exitCode})`);
  return "failed";
}

function printSummary(results: CloneResult[]): void {
  const counts = { cloned: 0, skipped: 0, failed: 0 };
  for (const r of results) counts[r]++;
  log.message(
    `Summary: cloned ${counts.cloned}, skipped ${counts.skipped}, failed ${counts.failed}`,
  );
}

function exitFromResults(results: CloneResult[]): number {
  return results.includes("failed") ? 2 : 0;
}

type Options = {
  all?: boolean;
  list?: boolean;
};

async function runAction(
  aliases: string[],
  options: Options,
): Promise<number> {
  let repos: Repo[];
  try {
    repos = validateSources(sourcesData);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  if (options.list) {
    printList(repos);
    return 0;
  }

  const repoRoot = resolve(import.meta.dir, "..");
  const sourcesDir = join(repoRoot, "sources");

  if (options.all) {
    const results = repos.map((r) => cloneOne(r, sourcesDir));
    printSummary(results);
    return exitFromResults(results);
  }

  let picked: Repo[];

  if (aliases.length === 0) {
    const interactive = await selectInteractive(repos);
    if (!interactive || interactive.length === 0) return 1;
    picked = interactive;
  } else {
    const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
    if (unknown.length > 0) {
      log.error(
        `Unknown alias(es): ${unknown.join(", ")}. Use --list to see available aliases.`,
      );
      return 1;
    }
    const seen = new Set<string>();
    picked = aliases
      .filter((a) => {
        if (seen.has(a)) return false;
        seen.add(a);
        return true;
      })
      .map((a) => repos.find((r) => r.alias === a)!);
  }

  const results = picked.map((r) => cloneOne(r, sourcesDir));
  if (results.length > 1) printSummary(results);
  return exitFromResults(results);
}

const program = new Command();
program
  .name("bun run clone")
  .description(
    "Clone repositories listed in sources.yaml into sources/<alias>/.",
  )
  .argument(
    "[aliases...]",
    "repo aliases to clone (omit for interactive multi-select)",
  )
  .option("--all", "clone every registered repo")
  .option("--list", "print registered repos")
  .addHelpText(
    "after",
    "\nExit codes: 0 ok | 1 usage/config error | 2 one or more clones failed.",
  )
  .action(async (aliases: string[], options: Options) => {
    const code = await runAction(aliases, options);
    process.exit(code);
  });

await program.parseAsync();
