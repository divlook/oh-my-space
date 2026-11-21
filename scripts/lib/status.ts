import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import { dim, pad, readPackageVersion, uniqueAliases } from "./env.js";
import { currentBranch, runGit, type RawGitRunner } from "./git.js";
import { isDirtyCounts, parseChangeCounts, type ChangeCounts } from "./git-status.js";
import { inspectSourceCheckout, type SourceWorkspace } from "./source-checkout.js";
import { inferAliasFromCwd, loadForSources } from "./source-workspace.js";
import { listIndependentManagedTrees, type ManagedTree } from "./tree-inventory.js";
import type { Repo, StatusOptions } from "./types.js";

function headShortSha(dir: string, git?: RawGitRunner): string | null {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"], false, undefined, git);
  return r.success ? r.stdout.trim() || null : null;
}

type HeadState = { branch: string | null; head: string | null; detached: boolean };

function headState(dir: string, git?: RawGitRunner): HeadState {
  const branch = currentBranch(dir, git);
  const head = headShortSha(dir, git);
  return { branch, head, detached: branch === null && head !== null };
}

type TrackingState = { trackingBranch: string | null; ahead: number | null; behind: number | null };

type SourceStatus = {
  alias: string;
  path: string;
  absolutePath: string;
  configured: boolean;
  initialized: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  dirty: boolean;
  changes: ChangeCounts;
  ahead: number | null;
  behind: number | null;
  error: string | null;
};

type RootStatus = {
  branch: string | null;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  changes: ChangeCounts;
};

type JsonTreeStatus = {
  alias: string;
  task: string;
  path: string;
  absolutePath: string;
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
  error: string | null;
};

function buildTreeStatuses(trees: ManagedTree[]): JsonTreeStatus[] {
  return trees.map((tree) => ({
    alias: tree.alias,
    task: tree.task,
    path: tree.path,
    absolutePath: tree.absolutePath,
    branch: tree.state === "healthy" ? tree.branch : null,
    head: tree.state === "healthy" ? tree.head : null,
    dirty: tree.state === "healthy" ? tree.dirty : null,
    error: tree.error,
  }));
}

function printStatusTreesText(trees: ManagedTree[]): void {
  if (trees.length > 0) {
    console.log("");
    console.log("Managed trees (.oms-tree/):");
    for (const tree of trees) {
      const state = tree.error ?? (tree.dirty ? "dirty" : "clean");
      const branch = tree.state === "healthy" ? (tree.branch ?? "(detached)") : "-";
      console.log(`  ${tree.path}  ${branch}  ${state}`);
    }
  }
}

type WorkspaceStatus = {
  schemaVersion: 2;
  toolVersion: string;
  workspaceRoot: string;
  currentAlias: string | null;
  root: RootStatus;
  repos: SourceStatus[];
  trees: JsonTreeStatus[];
  errors: string[];
};

const noTracking: TrackingState = { trackingBranch: null, ahead: null, behind: null };

function readSourceTracking(dir: string, branchRef: string, git: RawGitRunner): TrackingState & { error?: string } {
  const refs = git(dir, ["for-each-ref", "--format=%(upstream:short)%09%(upstream)", "--", branchRef]);
  if (!refs.success) return { ...noTracking, error: "could not read the tracking branch" };
  const [trackingBranch, upstream] = refs.stdout.trimEnd().split("\t", 2);
  if (!trackingBranch || !upstream) return noTracking;
  const comparison = git(dir, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const counts = comparison.success ? /^(\d+)\s+(\d+)$/.exec(comparison.stdout.trim()) : null;
  if (!counts) return { ...noTracking, trackingBranch, error: "could not compare HEAD with its tracking branch" };
  return { trackingBranch, ahead: Number(counts[2]), behind: Number(counts[1]) };
}

function readChanges(dir: string, git: RawGitRunner): ChangeCounts | null {
  const result = git(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
  return result.success ? parseChangeCounts(result.stdout) : null;
}

function sourceStatus(workspace: SourceWorkspace, repo: Repo): SourceStatus {
  const checkout = inspectSourceCheckout(workspace, repo);
  const row: SourceStatus = {
    alias: repo.alias,
    path: `${DATA_DIRNAME}/${repo.alias}`,
    absolutePath: checkout.path,
    configured: true,
    initialized: checkout.kind === "ready",
    branch: null,
    head: null,
    detached: false,
    trackingBranch: null,
    dirty: false,
    changes: { staged: 0, unstaged: 0, untracked: 0 },
    ahead: null,
    behind: null,
    error: null,
  };
  if (checkout.kind === "ready") {
    const { git } = workspace;
    const dir = checkout.path;
    const ref = git(dir, ["symbolic-ref", "--quiet", "HEAD"]);
    const branchRef = ref.success ? ref.stdout.trim() : "";
    row.head = headShortSha(dir, git);
    if (!row.head) row.error = "could not read checkout HEAD";
    if (branchRef.startsWith("refs/heads/")) {
      row.branch = branchRef.slice("refs/heads/".length);
      const tracking = readSourceTracking(dir, branchRef, git);
      row.trackingBranch = tracking.trackingBranch;
      row.ahead = tracking.ahead;
      row.behind = tracking.behind;
      row.error ??= tracking.error ?? null;
    } else if (ref.exitCode === 1) {
      row.detached = row.head !== null;
    } else {
      row.error ??= "could not read the current branch";
    }
    const changes = readChanges(dir, git);
    if (changes) {
      row.changes = changes;
      row.dirty = isDirtyCounts(changes);
    } else {
      row.error ??= "could not inspect checkout changes";
    }
  } else if (checkout.kind !== "missing") {
    row.error = checkout.reason;
  }
  if (row.error !== null) row.error = `${repo.alias}: ${row.error}`;
  return row;
}

export async function runIndependentStatus(aliases: string[], options: StatusOptions, git?: RawGitRunner): Promise<number> {
  const loaded = loadForSources({}, git);
  if (!loaded) return 1;
  const { repos, repoRoot, workspace } = loaded;
  let selected = repos;
  let selectedAliases: string[] | null = null;
  if (aliases.length > 0) {
    const byAlias = new Map(repos.map((repo) => [repo.alias, repo]));
    const unknown = aliases.filter((alias) => !byAlias.has(alias));
    if (unknown.length > 0) {
      const msg = `Unknown alias(es): ${unknown.join(", ")}. Use "oms clone --list" to see available aliases.`;
      if (options.json) process.stderr.write(`${msg}\n`);
      else log.error(msg);
      return 1;
    }
    if (!options.all) {
      selectedAliases = uniqueAliases(aliases);
      selected = selectedAliases.map((alias) => byAlias.get(alias)!);
    }
  }

  const sources = selected.map((repo) => sourceStatus(workspace, repo));
  const errors: string[] = [];
  for (const { error } of sources) if (error !== null) errors.push(error);
  let trees: ManagedTree[] = [];
  try {
    trees = listIndependentManagedTrees(workspace, { dirtyAliases: selectedAliases ?? "all" });
    if (selectedAliases !== null) {
      const selectedSet = new Set(selectedAliases);
      trees = trees.filter(({ alias }) => selectedSet.has(alias));
    }
  } catch (error) {
    errors.push(`managed trees: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (options.json) {
    const counts = readChanges(repoRoot, workspace.git);
    if (!counts) errors.unshift("workspace root: could not inspect changes");
    const changes = counts ?? { staged: 0, unstaged: 0, untracked: 0 };
    const payload: WorkspaceStatus = {
      schemaVersion: 2,
      toolVersion: readPackageVersion(),
      workspaceRoot: repoRoot,
      currentAlias: inferAliasFromCwd(repoRoot, repos),
      root: { ...headState(repoRoot, workspace.git), dirty: isDirtyCounts(changes), changes },
      repos: sources,
      trees: buildTreeStatuses(trees),
      errors,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    printSourceStatuses(sources);
    printStatusTreesText(trees);
    for (const error of errors) process.stderr.write(`${error}\n`);
  }
  return errors.length > 0 ? 2 : 0;
}

function printSourceStatuses(sources: SourceStatus[]): void {
  const branches = sources.map((source) => source.branch ?? (source.detached
    ? `(detached ${source.head})`
    : source.error ? "(unavailable)" : "(not cloned)"));
  const aliasWidth = Math.max("ALIAS".length, ...sources.map((source) => source.alias.length));
  const branchWidth = Math.max("BRANCH".length, ...branches.map((branch) => branch.length));
  console.log(dim(`${pad("ALIAS", aliasWidth)}  ${pad("BRANCH", branchWidth)}  DIRTY  AHEAD  BEHIND`));
  for (const [i, source] of sources.entries()) {
    const dirty = source.dirty ? "yes" : "";
    const ahead = source.ahead ? String(source.ahead) : "";
    const behind = source.behind ? String(source.behind) : "";
    console.log(`${pad(source.alias, aliasWidth)}  ${pad(branches[i], branchWidth)}  ${pad(dirty, 5)}  ${pad(ahead, 5)}  ${behind}`);
  }
}
