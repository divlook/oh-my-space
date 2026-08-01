import { cancel, log } from "@clack/prompts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { aliasRegistration, prepareAlias } from "./alias-preparation.js";
import { reportBaselines } from "./branch-baseline.js";
import {
  aliasDir,
  currentBranch,
  inspectLocalBranches,
  inspectRemoteBranches,
  isRegisteredSubmodule,
  redactSensitiveUrls,
  runGit,
  runSub,
  shortOid,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { guardedSelect, isCancel, promptQueueActive } from "./prompt-adapter.js";
import { runSync } from "./repo-ops.js";
import { assertRootTopologySafe, gitlinkState } from "./status.js";
import { ensureRemotes } from "./submodule-config.js";
import type { Repo } from "./types.js";

type RemoteState = "fresh" | "stale" | "unavailable";
type RemoteInventory = { name: string; state: RemoteState; branches: string[]; warning: string | null };
type AliasResult = { kind: "repo"; repo: Repo } | { kind: "error"; code: number };

function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

const PREPARE = { command: "branch list", topologyOffer: true } as const;

async function resolveAlias(repos: Repo[], repoRoot: string, aliasArg: string | undefined): Promise<AliasResult> {
  if (aliasArg) {
    const repo = repos.find(({ alias }) => alias === aliasArg);
    if (!repo) {
      log.error(`Unknown alias "${aliasArg}". Use "oms sync --list" to list aliases declared in oms.yaml.`);
      return { kind: "error", code: 1 };
    }
    const prepared = await prepareAlias(repoRoot, repo, PREPARE);
    return prepared.ok ? { kind: "repo", repo } : { kind: "error", code: prepared.code };
  }
  if (repos.length === 0) {
    log.error("No aliases are declared in oms.yaml. Add one before listing branches.");
    return { kind: "error", code: 1 };
  }
  if (repos.length === 1) {
    const repo = repos[0];
    const prepared = await prepareAlias(repoRoot, repo, PREPARE);
    return prepared.ok ? { kind: "repo", repo } : { kind: "error", code: prepared.code };
  }
  if (!interactive()) {
    log.error('No alias given and stdin is not a TTY. Pass an alias: "oms branch list <alias>".');
    return { kind: "error", code: 1 };
  }

  const choice = await guardedSelect<string>({
    message: "Select a submodule to list branches from",
    options: repos.map((repo) => ({
      value: repo.alias,
      label: repo.alias,
      hint: aliasRegistration(repoRoot, repo.alias),
    })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled. Repository state was preserved.");
    return { kind: "error", code: 1 };
  }
  const repo = repos.find(({ alias }) => alias === choice);
  if (!repo) return { kind: "error", code: 1 };
  const prepared = await prepareAlias(repoRoot, repo, PREPARE);
  return prepared.ok ? { kind: "repo", repo } : { kind: "error", code: prepared.code };
}

function diagnosticOrFallback(diagnostic: string, fallback: string): string {
  return diagnostic.trim().length > 0 ? diagnostic.trim() : fallback;
}

/** Reconcile and refresh declared remotes sequentially, retrying each failed fetch exactly once. */
function refreshRemotes(repoRoot: string, repo: Repo): { remotes: RemoteInventory[]; originHeadReliable: boolean } {
  const reconciled = new Map(ensureRemotes(repoRoot, repo.alias, repo.remotes).map((result) => [result.name, result]));
  const remotes: RemoteInventory[] = [];
  let originHeadReliable = false;

  for (const name of Object.keys(repo.remotes)) {
    const configured = reconciled.get(name);
    if (!configured?.ok) {
      remotes.push({
        name,
        state: "unavailable",
        branches: [],
        warning: diagnosticOrFallback(configured?.diagnostic ?? "", `${name}: remote configuration failed; retry with "oms branch list ${repo.alias}"`),
      });
      continue;
    }

    log.step(`${repo.alias}: fetching ${name} with prune`);
    let fetch = runSub(repoRoot, repo.alias, ["fetch", name, "--prune"]);
    if (!fetch.success) fetch = runSub(repoRoot, repo.alias, ["fetch", name, "--prune"]);
    const refs = inspectRemoteBranches(aliasDir(repoRoot, repo.alias), name);
    if (!refs.ok) {
      remotes.push({
        name,
        state: "unavailable",
        branches: [],
        warning: diagnosticOrFallback(refs.diagnostic, `${name}: remote ref inspection failed; inspect refs with git -C ${submodulePath(repo.alias)} for-each-ref`),
      });
      continue;
    }
    if (!fetch.success) {
      const diagnostic = redactSensitiveUrls(fetch.stderr.trim());
      remotes.push({
        name,
        state: refs.branches.length > 0 ? "stale" : "unavailable",
        branches: refs.branches,
        warning: `${diagnosticOrFallback(diagnostic, `${name}: fetch failed twice`)} Cached refs were preserved; retry "oms branch list ${repo.alias}".`,
      });
      continue;
    }

    if (name === "origin" && !repo.branch) {
      const setHead = runSub(repoRoot, repo.alias, ["remote", "set-head", "origin", "-a"]);
      originHeadReliable = setHead.success;
      if (!setHead.success) {
        const diagnostic = redactSensitiveUrls(setHead.stderr.trim());
        remotes.push({
          name,
          state: "fresh",
          branches: refs.branches,
          warning: diagnosticOrFallback(diagnostic, "origin/HEAD refresh failed; baseline reporting is degraded"),
        });
        continue;
      }
    } else if (name === "origin") {
      originHeadReliable = true;
    }
    remotes.push({ name, state: "fresh", branches: refs.branches, warning: null });
  }
  return { remotes, originHeadReliable };
}

function renderInventory(
  repo: Repo,
  current: string | null,
  detachedOid: string | null,
  local: Extract<ReturnType<typeof inspectLocalBranches>, { ok: true }>["branches"],
  remotes: RemoteInventory[],
  baseline: ReturnType<typeof reportBaselines>,
): void {
  const baselineNames = baseline.baselines.map(({ branch }) => branch);
  const baselineSet = new Set(baselineNames);
  const lines = [`Branch inventory: ${repo.alias}`, `HEAD: ${current ?? `detached ${detachedOid}`}`];
  lines.push(`BASELINE [${baseline.state}]: ${baselineNames.join(", ") || "(none)"}`);
  if (baseline.unmatched.length > 0) lines.push(`Unmatched reliable baselines: ${baseline.unmatched.join(", ")}`);
  lines.push("", "LOCAL", "NAME\tFLAGS\tUPSTREAM\tAHEAD\tBEHIND");
  if (local.length === 0) lines.push("(empty)");
  for (const branch of local) {
    const flags = [branch.name === current ? "current" : null, baselineSet.has(branch.name) ? "baseline" : null]
      .filter(Boolean)
      .join(",");
    const hasUpstream = branch.upstream !== null;
    lines.push([
      branch.name,
      flags,
      branch.upstream ?? "",
      hasUpstream ? branch.ahead ?? "?" : "",
      hasUpstream ? branch.behind ?? "?" : "",
    ].join("\t"));
  }
  lines.push("", "REMOTE", "REMOTE\tSTATE\tBRANCH");
  for (const remote of remotes) {
    if (remote.branches.length === 0) lines.push(`${remote.name}\t${remote.state}\t(empty)`);
    else for (const branch of remote.branches) lines.push(`${remote.name}\t${remote.state}\t${branch}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  for (const warning of [...baseline.warnings, ...remotes.map(({ warning }) => warning).filter((value): value is string => value !== null)]) {
    log.warn(`${repo.alias}: ${redactSensitiveUrls(warning)}`);
  }
}

/** List local and declared-remote branches for one safely prepared submodule. */
export async function runBranchList(aliasArg: string | undefined): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const resolved = await resolveAlias(loaded.repos, loaded.repoRoot, aliasArg);
  if (resolved.kind === "error") return resolved.code;
  const { repo } = resolved;
  const dir = aliasDir(loaded.repoRoot, repo.alias);

  const refreshed = refreshRemotes(loaded.repoRoot, repo);
  const local = inspectLocalBranches(dir);
  if (!local.ok) {
    if (local.diagnostic) log.error(local.diagnostic);
    log.error(
      `${repo.alias}: local branch ref inspection failed. Branches, checkout state, and root state were preserved. Retry "git -C ${submodulePath(repo.alias)} for-each-ref refs/heads", then "oms branch list ${repo.alias}".`,
    );
    return 2;
  }
  const current = currentBranch(dir);
  const detachedOid = current === null ? shortOid(dir, "HEAD") : null;
  const baseline = reportBaselines(
    loaded.repoRoot,
    repo,
    local.branches.map(({ name }) => name),
    refreshed.originHeadReliable,
  );
  renderInventory(repo, current, detachedOid, local.branches, refreshed.remotes, baseline);
  return 0;
}
