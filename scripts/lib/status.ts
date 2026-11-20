import { log } from "@clack/prompts";
import { dim, pad, readPackageVersion, uniqueAliases } from "./env.js";
import { aliasDir, currentBranch, isDirty, registeredSubmodulePaths, runGit, shortSha, submodulePath } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { listManagedTrees, type ManagedTree } from "./tree-inventory.js";
import type { Repo, StatusOptions } from "./types.js";
import { changeCounts, inferAliasFromCwd, isDirtyCounts, observeGitlinks, type ChangeCounts, type GitlinkObservation, type PinValue } from "./workspace-state.js";

type StatusRow = {
  alias: string;
  branch: string;
  pin: string;
  dirty: string;
  ahead: string;
  behind: string;
};

function readDivergence(dir: string): string[] {
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  return r.success ? r.stdout.trim().split(/\s+/, 2) : [];
}

function aheadBehind(dir: string): { ahead: string; behind: string } {
  const [behind, ahead] = readDivergence(dir);
  return { ahead: ahead && ahead !== "0" ? ahead : "", behind: behind && behind !== "0" ? behind : "" };
}


function headShortSha(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"]);
  return r.success ? r.stdout.trim() || null : null;
}

type HeadState = { branch: string | null; head: string | null; detached: boolean };

function headState(dir: string): HeadState {
  const branch = currentBranch(dir);
  const head = headShortSha(dir);
  return { branch, head, detached: branch === null && head !== null };
}

type TrackingState = { trackingBranch: string | null; ahead: number | null; behind: number | null };

function trackingState(dir: string): TrackingState {
  const up = runGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const trackingBranch = up.success ? up.stdout.trim() || null : null;
  if (!trackingBranch) return { trackingBranch: null, ahead: null, behind: null };
  const [rawBehind = "", rawAhead = ""] = readDivergence(dir);
  const behind = Number.parseInt(rawBehind, 10);
  const ahead = Number.parseInt(rawAhead, 10);
  return {
    trackingBranch,
    ahead: Number.isNaN(ahead) ? null : ahead,
    behind: Number.isNaN(behind) ? null : behind,
  };
}


/** Machine-readable per-repo status entry. The stable schemaVersion 1 contract is specified by the ai-submodule-workflow capability and summarized by oms status --help. */
type JsonRepoStatus = {
  alias: string;
  path: string;
  absolutePath: string;
  configured: boolean;
  initialized: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  pin: PinValue;
  dirty: boolean;
  changes: ChangeCounts;
  ahead: number | null;
  behind: number | null;
  error: string | null;
};

type JsonRootStatus = {
  branch: string | null;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  changes: ChangeCounts;
  submodulePointers: {
    moved: string[];
    staged: string[];
    split: string[];
    conflict: string[];
  };
};

type JsonStatus = {
  schemaVersion: 1;
  toolVersion: string;
  workspaceRoot: string;
  currentAlias: string | null;
  root: JsonRootStatus;
  repos: JsonRepoStatus[];
  trees: JsonTreeStatus[];
  errors: string[];
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

function buildRepoStatus(repoRoot: string, state: GitlinkObservation): JsonRepoStatus {
  const common = {
    alias: state.alias,
    path: submodulePath(state.alias),
    absolutePath: aliasDir(repoRoot, state.alias),
    configured: true,
    pin: state.pin,
  };
  const safeDefaults = {
    branch: null,
    head: null,
    detached: false,
    trackingBranch: null,
    dirty: false,
    changes: { staged: 0, unstaged: 0, untracked: 0 },
    ahead: null,
    behind: null,
  };
  if (!state.initialized) {
    return { ...common, initialized: false, ...safeDefaults, error: null };
  }
  const dir = common.absolutePath;
  const head = headShortSha(dir);
  if (head === null) {
    return {
      ...common,
      initialized: true,
      ...safeDefaults,
      error: `${state.alias}: could not read submodule HEAD`,
    };
  }
  const branch = currentBranch(dir);
  const { trackingBranch, ahead, behind } = trackingState(dir);
  const changes = changeCounts(dir, new Set());
  return {
    ...common,
    initialized: true,
    branch,
    head,
    detached: branch === null,
    trackingBranch,
    dirty: isDirtyCounts(changes),
    changes,
    ahead,
    behind,
    error: null,
  };
}

/**
 * Build the root JSON status. root.changes always excludes every configured submodule gitlink path so
 * pointer movement is reported only through submodulePointers, whose arrays cover the selected repos.
 */
function buildRootStatus(repoRoot: string, configuredRepos: Repo[], states: GitlinkObservation[]): JsonRootStatus {
  const { branch, head, detached } = headState(repoRoot);
  const excludePaths = new Set<string>([
    ...registeredSubmodulePaths(repoRoot),
    ...configuredRepos.map((r) => submodulePath(r.alias)),
  ]);
  const changes = changeCounts(repoRoot, excludePaths);
  const pointers = { moved: [] as string[], staged: [] as string[], split: [] as string[], conflict: [] as string[] };
  for (const s of states) {
    if (s.conflict) pointers.conflict.push(s.alias);
    if (s.moved) pointers.moved.push(s.alias);
    if (s.staged) pointers.staged.push(s.alias);
    if (s.split) pointers.split.push(s.alias);
  }
  return { branch, head, detached, dirty: isDirtyCounts(changes), changes, submodulePointers: pointers };
}

function collectStatusTrees(repoRoot: string, configuredRepos: Repo[], selectedAliases: string[] | null): ManagedTree[] {
  const trees = listManagedTrees(repoRoot, configuredRepos, { dirtyAliases: selectedAliases ?? "all" });
  if (selectedAliases === null) return trees;
  const selected = new Set(selectedAliases);
  return trees.filter((tree) => selected.has(tree.alias));
}

function buildTreeStatuses(trees: ManagedTree[]): JsonTreeStatus[] {
  return trees.map((tree) => ({
    alias: tree.alias,
    task: tree.task,
    path: tree.path,
    absolutePath: tree.absolutePath,
    branch: tree.branch,
    head: tree.head,
    dirty: tree.dirty,
    error: tree.error,
  }));
}

function printStatusJson(
  repoRoot: string,
  configuredRepos: Repo[],
  states: GitlinkObservation[],
  treeAliases: string[] | null,
): number {
  const repos = states.map((state) => buildRepoStatus(repoRoot, state));
  const errors = repos.filter((r) => r.error !== null).map((r) => r.error as string);
  const payload: JsonStatus = {
    schemaVersion: 1,
    toolVersion: readPackageVersion(),
    workspaceRoot: repoRoot,
    currentAlias: inferAliasFromCwd(repoRoot, configuredRepos),
    root: buildRootStatus(repoRoot, configuredRepos, states),
    repos,
    trees: buildTreeStatuses(collectStatusTrees(repoRoot, configuredRepos, treeAliases)),
    errors,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return errors.length > 0 ? 2 : 0;
}

export async function runStatus(aliases: string[], options: StatusOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  let selectedAliases: string[];
  // Null means "no alias filter was given": the tree inventory is then reported whole, including
  // entries whose alias is no longer declared in the manifest.
  let treeAliases: string[] | null = null;
  if (options.all || aliases.length === 0) {
    selectedAliases = repos.map((repo) => repo.alias);
  } else {
    const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
    if (unknown.length > 0) {
      const msg = `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`;
      if (options.json) process.stderr.write(`${msg}\n`);
      else log.error(msg);
      return 1;
    }
    selectedAliases = uniqueAliases(aliases);
    treeAliases = selectedAliases;
  }

  const states = observeGitlinks(repoRoot, selectedAliases);
  if (options.json) return printStatusJson(repoRoot, repos, states, treeAliases);
  printStatusText(repoRoot, repos, states, treeAliases);
  return 0;
}

function printStatusText(
  repoRoot: string,
  configuredRepos: Repo[],
  states: GitlinkObservation[],
  treeAliases: string[] | null,
): void {
  const rows: StatusRow[] = [];
  for (const state of states) {
    const { alias } = state;
    if (!state.initialized) {
      rows.push({ alias, branch: "(not synced)", pin: state.pin, dirty: "", ahead: "", behind: "" });
      continue;
    }
    const dir = aliasDir(repoRoot, alias);
    const branch = currentBranch(dir) ?? `(detached ${shortSha(dir)})`;
    const { ahead, behind } = aheadBehind(dir);
    rows.push({
      alias,
      branch,
      pin: state.pin,
      dirty: isDirty(dir) ? "yes" : "",
      ahead,
      behind,
    });
  }

  const col = (key: keyof StatusRow, header: string) =>
    Math.max(header.length, ...rows.map((r) => r[key].length));
  const aW = col("alias", "ALIAS");
  const bW = col("branch", "BRANCH");
  const pW = col("pin", "PIN");
  const dW = Math.max("DIRTY".length, ...rows.map((r) => r.dirty.length));
  console.log(
    dim(
      `${pad("ALIAS", aW)}  ${pad("BRANCH", bW)}  ${pad("PIN", pW)}  ${pad("DIRTY", dW)}  AHEAD  BEHIND`,
    ),
  );
  for (const r of rows) {
    console.log(
      `${pad(r.alias, aW)}  ${pad(r.branch, bW)}  ${pad(r.pin, pW)}  ${pad(r.dirty, dW)}  ${pad(r.ahead, 5)}  ${r.behind}`,
    );
  }

  const trees = collectStatusTrees(repoRoot, configuredRepos, treeAliases);
  if (trees.length > 0) {
    console.log("");
    console.log("Managed trees (.oms-tree/):");
    for (const tree of trees) {
      const state = tree.state === "healthy" ? (tree.dirty ? "dirty" : "clean") : tree.error;
      const branch = tree.state === "healthy" ? (tree.branch ?? "(detached)") : "-";
      console.log(`  ${tree.path}  ${branch}  ${state}`);
    }
  }
}
