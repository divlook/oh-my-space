import { log } from "@clack/prompts";
import { dim, pad, readPackageVersion, uniqueAliases } from "./env.js";
import { aliasDir, currentBranch, isDirty, registeredSubmodulePaths, runGit, shortSha, submodulePath } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { listManagedTrees, type ManagedTree } from "./tree-inventory.js";
import type { Repo, StatusOptions } from "./types.js";
import { changeCounts, isDirtyCounts, gitlinkState, inferAliasFromCwd, rootFollowupHint, type GitlinkState, type ChangeCounts, type PinValue } from "./workspace-state.js";

type StatusRow = {
  alias: string;
  branch: string;
  pin: string;
  dirty: string;
  ahead: string;
  behind: string;
};


function aheadBehind(dir: string): { ahead: string; behind: string } {
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!r.success) return { ahead: "", behind: "" };
  const [behind, ahead] = r.stdout.trim().split(/\s+/);
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
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!r.success) return { trackingBranch, ahead: null, behind: null };
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
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

/**
 * Build one repo's JSON status. Never throws: an initialized repo whose HEAD cannot be read keeps the
 * normal entry shape with null scalars, safe-default structured fields, and a concise `error` message.
 */
function buildRepoStatus(repoRoot: string, repo: Repo, state: GitlinkState): JsonRepoStatus {
  const common = {
    alias: repo.alias,
    path: submodulePath(repo.alias),
    absolutePath: aliasDir(repoRoot, repo.alias),
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
  const dir = aliasDir(repoRoot, repo.alias);
  const head = headShortSha(dir);
  if (head === null) {
    return {
      ...common,
      initialized: true,
      ...safeDefaults,
      error: `${repo.alias}: could not read submodule HEAD`,
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
function buildRootStatus(repoRoot: string, configuredRepos: Repo[], states: GitlinkState[]): JsonRootStatus {
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

function buildTreeStatuses(repoRoot: string, configuredRepos: Repo[], selectedAliases: string[] | null): JsonTreeStatus[] {
  const trees = listManagedTrees(repoRoot, configuredRepos, { dirtyAliases: selectedAliases ?? "all" });
  const narrowed = selectedAliases === null ? trees : trees.filter((tree) => selectedAliases.includes(tree.alias));
  return narrowed.map((tree: ManagedTree) => ({
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

/** Emit exactly one two-space pretty JSON object on stdout. Exits non-zero if any repo read failed. */
function printStatusJson(
  repoRoot: string,
  configuredRepos: Repo[],
  selectedRepos: Repo[],
  treeAliases: string[] | null,
): number {
  const states = new Map(selectedRepos.map((repo) => [repo.alias, gitlinkState(repoRoot, repo.alias)]));
  const repos = selectedRepos.map((repo) => buildRepoStatus(repoRoot, repo, states.get(repo.alias)!));
  const errors = repos.filter((r) => r.error !== null).map((r) => r.error as string);
  const payload: JsonStatus = {
    schemaVersion: 1,
    toolVersion: readPackageVersion(),
    workspaceRoot: repoRoot,
    currentAlias: inferAliasFromCwd(repoRoot, configuredRepos),
    root: buildRootStatus(repoRoot, configuredRepos, [...states.values()]),
    repos,
    trees: buildTreeStatuses(repoRoot, configuredRepos, treeAliases),
    errors,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return errors.length > 0 ? 2 : 0;
}

export async function runStatus(aliases: string[], options: StatusOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  let selected: Repo[];
  // Null means "no alias filter was given": the tree inventory is then reported whole, including
  // entries whose alias is no longer declared in the manifest.
  let treeAliases: string[] | null = null;
  if (options.all || aliases.length === 0) {
    selected = repos;
  } else {
    const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
    if (unknown.length > 0) {
      const msg = `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`;
      if (options.json) process.stderr.write(`${msg}\n`);
      else log.error(msg);
      return 1;
    }
    const byAlias = new Map(repos.map((r) => [r.alias, r]));
    selected = uniqueAliases(aliases).map((a) => byAlias.get(a)!);
    treeAliases = selected.map((repo) => repo.alias);
  }

  if (options.json) {
    return printStatusJson(repoRoot, repos, selected, treeAliases);
  }

  const rows: StatusRow[] = [];
  for (const repo of selected) {
    const state = gitlinkState(repoRoot, repo.alias);
    if (!state.initialized) {
      rows.push({ alias: repo.alias, branch: "(not synced)", pin: state.pin, dirty: "", ahead: "", behind: "" });
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir) ?? `(detached ${shortSha(dir)})`;
    const { ahead, behind } = aheadBehind(dir);
    rows.push({
      alias: repo.alias,
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

  const trees = listManagedTrees(repoRoot, repos, { dirtyAliases: treeAliases ?? "all" }).filter(
    (tree) => treeAliases === null || treeAliases.includes(tree.alias),
  );
  if (trees.length > 0) {
    console.log("");
    console.log("Managed trees (.oms-tree/):");
    for (const tree of trees) {
      const state = tree.state === "healthy" ? (tree.dirty ? "dirty" : "clean") : tree.error;
      const branch = tree.state === "healthy" ? (tree.branch ?? "(detached)") : "-";
      console.log(`  ${tree.path}  ${branch}  ${state}`);
    }
  }
  return 0;
}

export function printRootFollowup(repoRoot: string, alias: string): void {
  const hint = rootFollowupHint(alias, gitlinkState(repoRoot, alias));
  if (hint) log.info(hint);
}

export function printRootFollowups(repoRoot: string, aliases: string[]): void {
  const moved: string[] = [];
  const others: string[] = [];
  for (const alias of aliases) {
    const state = gitlinkState(repoRoot, alias);
    if (state.headOid !== null && state.pathExists && !state.conflict && state.moved) {
      moved.push(alias);
      continue;
    }
    const hint = rootFollowupHint(alias, state);
    if (hint) others.push(hint);
  }

  if (moved.length === 1) {
    others.unshift(`Run "oms record ${moved[0]}" to record the root pointer update.`);
  } else if (moved.length > 1) {
    others.unshift(`Run "oms record --all" to record ${moved.length} root pointer updates.`);
  }
  for (const hint of others) log.info(hint);
}
