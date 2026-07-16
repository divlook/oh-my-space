import { cancel, log } from "@clack/prompts";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

type AliasRegistration = "initialized" | "registered-uninitialized" | "partially registered" | "unregistered";
type RemoteState = "fresh" | "stale" | "unavailable";
type RemoteInventory = { name: string; state: RemoteState; branches: string[]; warning: string | null };
type AliasResult = { kind: "repo"; repo: Repo } | { kind: "error"; code: number };

function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

/** Whether one committed or indexed `.gitmodules` snapshot registers this alias's canonical path. */
function snapshotRegisters(repoRoot: string, alias: string, snapshot: "HEAD" | "index"): boolean {
  const path = submodulePath(alias);
  const configArgs = snapshot === "HEAD" ? ["--blob", "HEAD:.gitmodules"] : ["--blob", ":0:.gitmodules"];
  const result = runGit(repoRoot, ["config", ...configArgs, "--get-all", `submodule.${path}.path`]);
  return result.success && result.stdout.split("\n").map((value) => value.trim()).filter(Boolean).length === 1
    && result.stdout.trim() === path;
}

/** Classify registration presence across root HEAD, index, and working tree without comparing gitlink OIDs. */
function aliasRegistration(repoRoot: string, alias: string): AliasRegistration {
  const state = gitlinkState(repoRoot, alias);
  const path = submodulePath(alias);
  const gitmodulesConflict = runGit(repoRoot, ["ls-files", "-u", "--", ".gitmodules"]).stdout.trim().length > 0;
  if (state.conflict || gitmodulesConflict) return "partially registered";

  const gitlinks = [state.headOid !== null, state.indexOid !== null, state.indexOid !== null && state.pathExists];
  const worktreeConfigReadable = runGit(repoRoot, ["config", "--file", ".gitmodules", "--list"]).success;
  const worktreeRegistration = isRegisteredSubmodule(repoRoot, path)
    || (state.initialized
      && existsSync(join(repoRoot, ".gitmodules"))
      && !worktreeConfigReadable
      && snapshotRegisters(repoRoot, alias, "HEAD")
      && snapshotRegisters(repoRoot, alias, "index"));
  const registrations = [
    snapshotRegisters(repoRoot, alias, "HEAD"),
    snapshotRegisters(repoRoot, alias, "index"),
    worktreeRegistration,
  ];
  if (gitlinks.every(Boolean) && registrations.every(Boolean)) {
    return state.initialized ? "initialized" : "registered-uninitialized";
  }
  if ([...gitlinks, ...registrations].every((present) => !present)) return "unregistered";
  return "partially registered";
}

/** Initialize only an already registered alias, overriding a drifted registration URL for this command only. */
function initializeRegisteredAlias(repoRoot: string, repo: Repo): { ok: true } | { ok: false; code: number } {
  log.step(`${repo.alias}: initializing registered submodule`);
  const update = runGit(repoRoot, [
    "-c",
    `submodule.${submodulePath(repo.alias)}.url=${repo.remotes.origin}`,
    "submodule",
    "update",
    "--init",
    "--",
    submodulePath(repo.alias),
  ]);
  if (update.success) return { ok: true };

  const diagnostic = redactSensitiveUrls(update.stderr.trim());
  if (diagnostic) log.error(diagnostic);
  log.error(
    `${repo.alias}: automatic initialization failed (exit ${update.exitCode}). Git's resumable partial state was preserved. Retry "oms branch list ${repo.alias}" or repair with "git submodule update --init -- ${submodulePath(repo.alias)}".`,
  );
  return { ok: false, code: 2 };
}

/** Delegate topology creation to sync while redacting inherited Git diagnostics for this invocation. */
async function syncAndContinue(repo: Repo): Promise<number> {
  const previous = process.env.OMS_REDACT_GIT_DIAGNOSTICS;
  process.env.OMS_REDACT_GIT_DIAGNOSTICS = "1";
  try {
    return await runSync([repo.alias], {});
  } finally {
    if (previous === undefined) delete process.env.OMS_REDACT_GIT_DIAGNOSTICS;
    else process.env.OMS_REDACT_GIT_DIAGNOSTICS = previous;
  }
}

async function prepareAlias(repoRoot: string, repo: Repo): Promise<{ ok: true } | { ok: false; code: number }> {
  const registration = aliasRegistration(repoRoot, repo.alias);
  if (registration === "initialized") return { ok: true };
  if (registration === "registered-uninitialized") return initializeRegisteredAlias(repoRoot, repo);
  if (registration === "partially registered") {
    log.error(
      `${repo.alias}: root gitlink and .gitmodules registration are inconsistent or pending addition/removal. Repository state was preserved. Repair it with "oms sync ${repo.alias}", then retry.`,
    );
    return { ok: false, code: 1 };
  }
  if (!interactive()) {
    log.error(
      `${repo.alias}: declared in oms.yaml but not registered in the root repository. No topology was changed. Run "oms sync ${repo.alias}", then retry "oms branch list ${repo.alias}".`,
    );
    return { ok: false, code: 1 };
  }

  const choice = await guardedSelect<string>({
    message: `${repo.alias} is not registered; sync creates root submodule topology`,
    options: [
      { value: "sync", label: "sync and continue", hint: `run oms sync ${repo.alias}, then list branches` },
      { value: "cancel", label: "cancel", hint: "leave root topology unchanged" },
    ],
  });
  if (isCancel(choice) || choice === "cancel") {
    cancel(`Cancelled. No topology was changed. Run "oms sync ${repo.alias}" when ready.`);
    return { ok: false, code: 1 };
  }
  const topology = assertRootTopologySafe(repoRoot, repo.alias);
  if (!topology.safe) {
    log.error(
      `${repo.alias}: sync cannot start because ${topology.reason} Root state was preserved. Repair it, then run "oms sync ${repo.alias}".`,
    );
    return { ok: false, code: 1 };
  }
  const code = await syncAndContinue(repo);
  if (code !== 0) {
    log.error(`${repo.alias}: sync and continue failed. Sync's partial state and exit code were preserved.`);
    return { ok: false, code };
  }
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: sync completed but the submodule is not initialized. Run "oms sync ${repo.alias}" to repair it.`);
    return { ok: false, code: 2 };
  }
  return { ok: true };
}

async function resolveAlias(repos: Repo[], repoRoot: string, aliasArg: string | undefined): Promise<AliasResult> {
  if (aliasArg) {
    const repo = repos.find(({ alias }) => alias === aliasArg);
    if (!repo) {
      log.error(`Unknown alias "${aliasArg}". Use "oms sync --list" to list aliases declared in oms.yaml.`);
      return { kind: "error", code: 1 };
    }
    const prepared = await prepareAlias(repoRoot, repo);
    return prepared.ok ? { kind: "repo", repo } : { kind: "error", code: prepared.code };
  }
  if (repos.length === 0) {
    log.error("No aliases are declared in oms.yaml. Add one before listing branches.");
    return { kind: "error", code: 1 };
  }
  if (repos.length === 1) {
    const repo = repos[0];
    const prepared = await prepareAlias(repoRoot, repo);
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
  const prepared = await prepareAlias(repoRoot, repo);
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
