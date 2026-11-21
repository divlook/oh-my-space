import { log } from "@clack/prompts";
import {
  aliasDir,
  currentBranch,
  inspectLocalBranches,
  type LocalBranchInfo,
  inspectRemoteBranches,
  redactSensitiveUrls,
  runSub,
  shortOid,
  sourcePath,
} from "./git.js";
import { ensureSourceRemotes, type RemoteReconciliation } from "./source-remotes.js";
import type { Repo } from "./types.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import { sourceBaseline } from "./source-branch-context.js";
import { prepareBranchSource } from "./source-preparation.js";
import { loadForSources } from "./source-workspace.js";

type RemoteState = "fresh" | "stale" | "unavailable";
type RemoteInventory = { name: string; state: RemoteState; branches: string[]; warning: string | null };
function diagnosticOrFallback(diagnostic: string, fallback: string): string {
  return diagnostic.trim().length > 0 ? diagnostic.trim() : fallback;
}

/** Reconcile and refresh declared remotes sequentially, retrying each failed fetch exactly once. */
function refreshRemotes(repoRoot: string, repo: Repo, configuredRemotes: RemoteReconciliation[]): { remotes: RemoteInventory[]; originHeadReliable: boolean } {
  const reconciled = new Map(configuredRemotes.map((result) => [result.name, result]));
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
        warning: diagnosticOrFallback(refs.diagnostic, `${name}: remote ref inspection failed; inspect refs with git -C ${sourcePath(repo.alias)} for-each-ref`),
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
  local: LocalBranchInfo[],
  remotes: RemoteInventory[],
  baseline: string | null,
  originHeadReliable: boolean,
): void {
  const lines = [`Branch inventory: ${repo.alias}`, `HEAD: ${current ?? `detached ${detachedOid}`}`];
  lines.push(`BASELINE [${baseline ? "known" : "unknown"}]: ${baseline ?? "(none)"}`);
  if (baseline && !local.some(({ name }) => name === baseline)) lines.push(`Unmatched reliable baselines: ${baseline}`);
  lines.push("", "LOCAL", "NAME\tFLAGS\tUPSTREAM\tAHEAD\tBEHIND");
  if (local.length === 0) lines.push("(empty)");
  for (const branch of local) {
    const flags = [branch.name === current ? "current" : null, branch.name === baseline ? "baseline" : null]
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
  if (baseline === null) log.warn(`${repo.alias}: ${originHeadReliable
    ? "origin/HEAD could not be resolved after refreshing origin"
    : "origin/HEAD is not reliable because origin could not be refreshed successfully"}`);
  for (const { warning } of remotes) {
    if (warning) log.warn(`${repo.alias}: ${redactSensitiveUrls(warning)}`);
  }
}

export async function runSourceBranchList(alias: string | undefined): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repoRoot, repos } = loaded;
  const prepared = await prepareBranchSource(workspace, repos, alias, "branch list");
  if ("code" in prepared) return prepared.code;
  const { repo, checkout: { path: dir } } = prepared;
  const configured = ensureSourceRemotes(repoRoot, repo.alias, repo.remotes, Object.keys(repo.remotes));
  const refreshed = refreshRemotes(repoRoot, repo, configured);
  const local = inspectLocalBranches(dir);
  if (!local.ok) {
    if (local.diagnostic) log.error(local.diagnostic);
    log.error(
      `${repo.alias}: local branch ref inspection failed. Branches, checkout state, and root state were preserved. Retry "git -C ${sourcePath(repo.alias)} for-each-ref refs/heads", then "oms branch list ${repo.alias}".`,
    );
    return 2;
  }
  const current = currentBranch(dir);
  const detachedOid = current === null ? shortOid(dir, "HEAD") : null;
  const baseline = sourceBaseline(dir, repo, refreshed.originHeadReliable);
  renderInventory(repo, current, detachedOid, local.branches, refreshed.remotes, baseline, refreshed.originHeadReliable);
  return 0;
}
