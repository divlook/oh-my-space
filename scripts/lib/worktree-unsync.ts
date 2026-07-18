import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { ALIAS_PATTERN } from "./constants.js";
import { isTestMode } from "./env.js";
import { runGit } from "./git.js";
import { validateWorktreeRemoteUrl } from "./manifest.js";
import type { Repo, UnsyncOptions } from "./types.js";
import { assertNoSymlinkComponents, commonRepoPath, worktreeAliasPath } from "./worktree-paths.js";
import {
  inspectWorktreeInventory,
  inspectWorktreeState,
  verifyCommonRepository,
  type ClassifiedWorktree,
  type WorktreeState,
} from "./worktree-inspection.js";
import { fetchWorktreeRemotes } from "./worktree-sync.js";
import { readWorkspaceOwnership } from "./workspace-mutation.js";

type ProtectedObject = {
  kind: "branch" | "worktree-head" | "tag" | "stash" | "notes" | "replace" | "custom-ref" | "reflog-only" | "dangling";
  oid: string;
  refname: string | null;
  objectType: string;
  published: boolean;
};

type WorktreeSnapshot = {
  target: string;
  path: string;
  state: WorktreeState;
};

type AliasPreflight = {
  repo: Repo;
  common: string;
  worktrees: WorktreeSnapshot[];
  protectedObjects: ProtectedObject[];
  force: boolean;
  preservedOids: Set<string>;
};

type PreflightResult =
  | { code: 0; plan: AliasPreflight | null }
  | { code: 1 | 2; plan: null };

const RAW_OBJECT_ENV = { GIT_NO_REPLACE_OBJECTS: "1" };

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function objectType(common: string, oid: string): string {
  const result = runGit(common, ["cat-file", "-t", oid], false, RAW_OBJECT_ENV);
  return result.success ? result.stdout.trim() : "unknown";
}

function remoteCommitOids(common: string): string[] {
  const result = runGit(common, ["for-each-ref", "--format=%(objectname)", "refs/remotes"], false, RAW_OBJECT_ENV);
  if (!result.success) throw new Error("could not inspect declared remote-tracking refs");
  return [...new Set(lines(result.stdout).filter((oid) => /^[0-9a-f]{40,64}$/.test(oid)))];
}

function publishedCommit(common: string, oid: string, remoteOids: string[]): boolean {
  if (objectType(common, oid) !== "commit") return false;
  return remoteOids.some((remoteOid) => runGit(common, ["merge-base", "--is-ancestor", oid, remoteOid], false, RAW_OBJECT_ENV).success);
}

function localBranchObjects(common: string, remoteOids: string[]): ProtectedObject[] {
  const result = runGit(common, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)", "refs/heads"], false, RAW_OBJECT_ENV);
  if (!result.success) throw new Error("could not inspect local branches");
  return lines(result.stdout).map((line) => {
    const [refname, oid, type] = line.split("\0");
    if (!refname || !/^[0-9a-f]{40,64}$/.test(oid ?? "")) throw new Error("local branch inventory was malformed");
    return { kind: "branch", refname, oid, objectType: type || "unknown", published: publishedCommit(common, oid, remoteOids) };
  });
}

function metadataObjects(common: string): ProtectedObject[] {
  const result = runGit(common, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)", "refs"], false, RAW_OBJECT_ENV);
  if (!result.success) throw new Error("could not inspect local metadata refs");
  return lines(result.stdout).flatMap((line): ProtectedObject[] => {
    const [refname, oid, type] = line.split("\0");
    if (!refname || !/^[0-9a-f]{40,64}$/.test(oid ?? "")
      || refname.startsWith("refs/heads/") || refname.startsWith("refs/remotes/")) return [];
    const kind = refname.startsWith("refs/tags/") ? "tag"
      : refname === "refs/stash" ? "stash"
        : refname.startsWith("refs/notes/") ? "notes"
          : refname.startsWith("refs/replace/") ? "replace"
            : "custom-ref";
    return [{ kind, refname, oid, objectType: type || "unknown", published: false }];
  });
}

function reflogAndDanglingObjects(common: string): ProtectedObject[] {
  const reflog = runGit(common, ["reflog", "show", "--all", "--format=%H"], false, RAW_OBJECT_ENV);
  if (!reflog.success && reflog.exitCode !== 1) throw new Error("could not inspect reflogs");
  const reflogOids = new Set(lines(reflog.stdout).filter((oid) => /^[0-9a-f]{40,64}$/.test(oid)));
  const reachable = (oid: string): boolean => {
    const refs = runGit(common, ["for-each-ref", "--contains", oid, "--format=%(refname)", "refs"], false, RAW_OBJECT_ENV);
    return refs.success && refs.stdout.trim().length > 0;
  };
  const result: ProtectedObject[] = [...reflogOids]
    .filter((oid) => objectType(common, oid) === "commit" && !reachable(oid))
    .map((oid) => ({ kind: "reflog-only", refname: null, oid, objectType: "commit", published: false }));

  const fsck = runGit(common, ["fsck", "--full", "--unreachable", "--no-reflogs", "--no-progress"], false, RAW_OBJECT_ENV);
  if (!fsck.success && fsck.exitCode !== 1) throw new Error("could not inspect recoverable unreachable objects");
  for (const line of lines(`${fsck.stdout}\n${fsck.stderr}`)) {
    const match = line.match(/^(?:unreachable|dangling) ([a-z]+) ([0-9a-f]{40,64})$/);
    if (!match || result.some(({ oid }) => oid === match[2])) continue;
    result.push({ kind: "dangling", refname: null, oid: match[2], objectType: match[1], published: false });
  }
  return result;
}

function inventoryProtectedObjects(
  common: string,
  worktrees: Array<{ target: string; state: WorktreeState }>,
): ProtectedObject[] {
  const remoteOids = remoteCommitOids(common);
  const branches = localBranchObjects(common, remoteOids);
  const heads: ProtectedObject[] = worktrees.flatMap(({ target, state }) => state.head
    ? [{
        kind: "worktree-head" as const,
        refname: target,
        oid: state.head,
        objectType: "commit",
        published: publishedCommit(common, state.head, remoteOids),
      }]
    : []);
  const unique = new Map<string, ProtectedObject>();
  for (const item of [...branches, ...heads, ...metadataObjects(common), ...reflogAndDanglingObjects(common)]) {
    unique.set(`${item.kind}\0${item.refname ?? ""}\0${item.oid}`, item);
  }
  return [...unique.values()];
}

function unsafeWorktreeState(state: WorktreeState): boolean {
  return state.dirty || state.ignored > 0 || state.nestedRepositories > 0 || state.operation !== null
    || (state.detached && !state.recoverable);
}

function discloseWorktree(target: string, state: WorktreeState): void {
  const parts = [
    state.changes.staged > 0 ? `staged=${state.changes.staged}` : null,
    state.changes.unstaged > 0 ? `unstaged=${state.changes.unstaged}` : null,
    state.changes.untracked > 0 ? `untracked=${state.changes.untracked}` : null,
    state.ignored > 0 ? `ignored=${state.ignored}` : null,
    state.nestedRepositories > 0 ? `nested-repositories=${state.nestedRepositories}` : null,
    state.operation ? `operation=${state.operation}` : null,
    state.detached && state.head ? `detached=${state.head}` : null,
  ].filter(Boolean);
  if (parts.length > 0) log.warn(`${target}: force will discard ${parts.join(", ")}`);
}

function discloseObjects(alias: string, objects: ProtectedObject[]): void {
  for (const item of objects.filter(({ published }) => !published)) {
    log.warn(
      `${alias}: force will discard ${item.kind}${item.refname ? ` ${item.refname}` : ""} ${item.objectType} ${item.oid}`,
    );
  }
}

function blockingRegistration(alias: string, worktree: ClassifiedWorktree): string | null {
  if (worktree.locked) {
    return `${alias}: linked worktree ${worktree.path} is locked. Run "git -C ${commonRepoPath("<workspace>", alias)} worktree unlock ${worktree.path}" and retry.`;
  }
  if (!worktree.managed) {
    return `${alias}: external or ownership-ambiguous worktree ${worktree.path} blocks unsync. Detach it with "git worktree remove ${worktree.path}" from the common repository, then retry.`;
  }
  if (worktree.stale && !worktree.safeToPrune) {
    return `${alias}: stale managed registration ${worktree.path} may have been moved manually. Run "oms doctor" and repair it before retrying.`;
  }
  return null;
}

function configuredOrphanRepo(workspaceRoot: string, alias: string, workspaceId: string): Repo | null {
  if (!ALIAS_PATTERN.test(alias)) return null;
  let common: string;
  try {
    common = verifyCommonRepository(workspaceRoot, alias, workspaceId);
  } catch {
    return null;
  }
  const names = runGit(common, ["remote"]);
  if (!names.success) throw new Error(`${alias}: could not inspect orphan remotes`);
  const remotes: Record<string, string> = {};
  for (const name of lines(names.stdout)) {
    const urls = runGit(common, ["config", "--get-all", `remote.${name}.url`]);
    const pushUrls = runGit(common, ["config", "--get-all", `remote.${name}.pushurl`]);
    const values = urls.success ? lines(urls.stdout) : [];
    if (values.length !== 1 || (pushUrls.success && pushUrls.stdout.trim())) {
      throw new Error(`${alias}: orphan remote ${name} has ambiguous URL configuration`);
    }
    validateWorktreeRemoteUrl(values[0], `orphan repository ${alias} remote ${name}`);
    remotes[name] = values[0];
  }
  if (!remotes.origin) throw new Error(`${alias}: orphan repository has no origin remote`);
  return { alias, remotes };
}

export function discoverWorktreeOrphanAliases(workspaceRoot: string, declared: Repo[]): string[] {
  const root = join(workspaceRoot, ".oms", "repos");
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
  const known = new Set(declared.map(({ alias }) => alias));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".git"))
    .map((entry) => entry.name.slice(0, -4))
    .filter((alias) => ALIAS_PATTERN.test(alias) && !known.has(alias));
}

export function resolveExplicitWorktreeOrphans(workspaceRoot: string, declared: Repo[], aliases: string[]): Repo[] {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) return [];
  const declaredAliases = new Set(declared.map(({ alias }) => alias));
  return aliases.filter((alias) => !declaredAliases.has(alias)).flatMap((alias): Repo[] => {
    const orphan = configuredOrphanRepo(workspaceRoot, alias, ownership.workspaceId);
    return orphan ? [orphan] : [];
  });
}

function cleanMissingAliasState(workspaceRoot: string, alias: string): boolean {
  const aliasPath = worktreeAliasPath(workspaceRoot, alias);
  assertNoSymlinkComponents(workspaceRoot, commonRepoPath(workspaceRoot, alias));
  assertNoSymlinkComponents(workspaceRoot, aliasPath);
  if (existsSync(aliasPath)) {
    const entry = lstatSync(aliasPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || readdirSync(aliasPath).length > 0) return false;
  }
  return true;
}

function preflightAlias(workspaceRoot: string, workspaceId: string, repo: Repo, force: boolean, preservedOids: string[] = []): PreflightResult {
  const expectedCommon = commonRepoPath(workspaceRoot, repo.alias);
  if (!existsSync(expectedCommon)) {
    try {
      if (!cleanMissingAliasState(workspaceRoot, repo.alias)) {
        log.error(`${repo.alias}: common repository is missing while checkout storage remains; run "oms doctor".`);
        return { code: 1, plan: null };
      }
      return { code: 0, plan: null };
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return { code: 1, plan: null };
    }
  }

  try {
    const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
    for (const worktree of inventory.worktrees) {
      const reason = blockingRegistration(repo.alias, worktree);
      if (reason) {
        log.error(reason.replace(commonRepoPath("<workspace>", repo.alias), inventory.commonDir));
        return { code: 1, plan: null };
      }
    }

    const fetched = fetchWorktreeRemotes(workspaceRoot, inventory.commonDir, repo);
    if (fetched.code === 1) return { code: 1, plan: null };
    if (fetched.code === 2 && !force) {
      log.error(`${repo.alias}: fresh publication verification failed. Retry when every remote is available, or use --force to accept stale remote knowledge.`);
      return { code: 2, plan: null };
    }
    if (fetched.code === 2) log.warn(`${repo.alias}: --force is continuing with stale remote knowledge.`);

    const worktrees: WorktreeSnapshot[] = inventory.worktrees.filter(({ managed, stale }) => managed && !stale).map((worktree) => ({
      target: worktree.target!,
      path: worktree.canonicalPath!,
      state: inspectWorktreeState(worktree.path),
    }));
    const preserved = new Set(preservedOids);
    const protectedObjects = inventoryProtectedObjects(inventory.commonDir, worktrees)
      .map((item) => preserved.has(item.oid) ? { ...item, published: true } : item);
    const unsafeTrees = worktrees.filter(({ state }) => unsafeWorktreeState(state));
    const unpublished = protectedObjects.filter(({ published }) => !published);
    if (!force && (unsafeTrees.length > 0 || unpublished.length > 0)) {
      for (const { target, state } of unsafeTrees) discloseWorktree(target, state);
      for (const item of unpublished) {
        log.error(`${repo.alias}: ${item.kind}${item.refname ? ` ${item.refname}` : ""} ${item.objectType} ${item.oid} is not proven reconstructible from declared remotes.`);
      }
      log.error(`${repo.alias}: unsync refused. Publish or preserve local state, clean worktrees, or rerun with --force to discard the disclosed managed state.`);
      return { code: 1, plan: null };
    }
    if (force) {
      unsafeTrees.forEach(({ target, state }) => discloseWorktree(target, state));
      discloseObjects(repo.alias, protectedObjects);
    }
    return { code: 0, plan: { repo, common: inventory.commonDir, worktrees, protectedObjects, force, preservedOids: preserved } };
  } catch (error) {
    log.error(`${repo.alias}: ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1, plan: null };
  }
}

function sameState(left: WorktreeState, right: WorktreeState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function removeEmptyParent(path: string): void {
  try {
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  } catch {}
}

function cleanupAliasState(workspaceRoot: string, alias: string): void {
  const paths = [
    join(workspaceRoot, ".oms", "provisioning", `${alias}.json`),
    join(workspaceRoot, ".oms", "fetch-provenance", alias),
  ];
  for (const path of paths) {
    assertNoSymlinkComponents(workspaceRoot, path);
    rmSync(path, { recursive: true, force: true });
  }
  removeEmptyParent(worktreeAliasPath(workspaceRoot, alias));
  removeEmptyParent(join(workspaceRoot, "oms"));
  removeEmptyParent(join(workspaceRoot, ".oms", "provisioning"));
  removeEmptyParent(join(workspaceRoot, ".oms", "fetch-provenance"));
  removeEmptyParent(join(workspaceRoot, ".oms", "repos"));
}

function executeAlias(workspaceRoot: string, workspaceId: string, plan: AliasPreflight | null, alias: string): 0 | 2 {
  if (!plan) {
    try {
      cleanupAliasState(workspaceRoot, alias);
      log.info(`${alias}: already absent; cleaned remaining owned state`);
      return 0;
    } catch (error) {
      log.error(`${alias}: metadata cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  const removed: string[] = [];
  for (const expected of plan.worktrees) {
    try {
      const current = inspectWorktreeInventory(workspaceRoot, alias, workspaceId);
      const registration = current.worktrees.find(({ target }) => target === expected.target);
      if (!registration || registration.locked || !registration.managed || registration.stale || !registration.canonicalPath) {
        throw new Error(`${expected.target}: registration changed after preflight`);
      }
      if (isTestMode() && process.env.OMS_TEST_MUTATE_AT === `unsync-before-worktree:${expected.target}`) {
        const changed = runGit(registration.path, ["commit", "--allow-empty", "-m", "injected concurrent Git change"]);
        if (!changed.success) throw new Error(`${expected.target}: could not inject concurrent Git change`);
      }
      const state = inspectWorktreeState(registration.path);
      if (!sameState(expected.state, state)) throw new Error(`${expected.target}: Git or working-tree state changed after preflight`);
      const removal = runGit(current.commonDir, ["worktree", "remove", ...(plan.force ? ["--force"] : []), "--", registration.path], true);
      if (!removal.success) throw new Error(`${expected.target}: git worktree remove failed (exit ${removal.exitCode})`);
      removed.push(expected.target);
      log.success(`${expected.target}: worktree removed; local branch retained until common repository removal`);
    } catch (error) {
      log.error(`${alias}: removal stopped after [${removed.join(", ") || "none"}]; ${error instanceof Error ? error.message : String(error)}. Retry "oms unsync ${alias}${plan.force ? " --force" : ""}" or run "oms doctor".`);
      return 2;
    }
  }

  try {
    let inventory = inspectWorktreeInventory(workspaceRoot, alias, workspaceId);
    const staleManaged = inventory.worktrees.filter(({ managed, stale, safeToPrune }) => managed && stale && safeToPrune);
    if (staleManaged.length > 0) {
      const prune = runGit(inventory.commonDir, ["worktree", "prune", "--expire=now"]);
      if (!prune.success) throw new Error("could not prune stale managed registrations");
      inventory = inspectWorktreeInventory(workspaceRoot, alias, workspaceId);
    }
    if (inventory.worktrees.length > 0) throw new Error("linked worktree registrations changed before common-repository deletion");
    verifyCommonRepository(workspaceRoot, alias, workspaceId);
    const remainingObjects = inventoryProtectedObjects(inventory.commonDir, []);
    if (!plan.force && remainingObjects.some(({ published, oid }) => !published && !plan.preservedOids.has(oid))) {
      throw new Error("local refs or recoverable objects changed after preflight");
    }
    if (isTestMode() && process.env.OMS_TEST_FAIL_AT === `unsync-common:${alias}`) {
      throw new Error("injected common-repository deletion failure");
    }
    assertNoSymlinkComponents(workspaceRoot, plan.common);
    rmSync(plan.common, { recursive: true, force: true });
    cleanupAliasState(workspaceRoot, alias);
    log.success(`${alias}: unsynced`);
    return 0;
  } catch (error) {
    log.error(`${alias}: worktrees removed [${removed.join(", ") || "none"}], but common repository was preserved: ${error instanceof Error ? error.message : String(error)}. Retry "oms unsync ${alias}${plan.force ? " --force" : ""}" or run "oms doctor".`);
    return 2;
  }
}

export async function runWorktreeUnsync(
  workspaceRoot: string,
  declared: Repo[],
  aliases: string[],
  options: UnsyncOptions,
): Promise<number> {
  if (options.commit) {
    log.error("--commit is unavailable for worktree-mode unsync because worktree storage has no root gitlink topology.");
    return 1;
  }
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) {
    log.error("Workspace ownership is missing; run a normal sync or doctor before unsync.");
    return 1;
  }
  const byAlias = new Map(declared.map((repo) => [repo.alias, repo]));
  const orphans = resolveExplicitWorktreeOrphans(workspaceRoot, declared, aliases);
  orphans.forEach((repo) => byAlias.set(repo.alias, repo));
  const requested = options.all ? declared.map(({ alias }) => alias) : [...new Set(aliases)];
  const unknown = requested.filter((alias) => !byAlias.has(alias));
  if (unknown.length > 0) {
    log.error(`Unknown or unowned alias(es): ${unknown.join(", ")}. Orphan cleanup requires an explicitly named owned common repository.`);
    return 1;
  }
  if (requested.length === 0) {
    log.error("Worktree-mode unsync requires an explicit alias or --all.");
    return 1;
  }

  const repos = requested.map((alias) => byAlias.get(alias)!);
  const preflights = repos.map((repo) => preflightAlias(
    workspaceRoot,
    ownership.workspaceId,
    repo,
    options.force ?? false,
    options.preservedOids?.[repo.alias] ?? [],
  ));
  const blocked = preflights.map(({ code }) => code);
  if (blocked.some((code) => code !== 0)) {
    log.error("Unsync preflight failed; no alias storage was deleted.");
    return blocked.includes(2) ? 2 : 1;
  }

  const results = repos.map((repo, index) => executeAlias(workspaceRoot, ownership.workspaceId, preflights[index].plan, repo.alias));
  const completed = repos.filter((_, index) => results[index] === 0).map(({ alias }) => alias);
  const incomplete = repos.filter((_, index) => results[index] !== 0).map(({ alias }) => alias);
  if (repos.length > 1 || incomplete.length > 0) {
    log.info(`Unsync completed: ${completed.join(", ") || "none"}; incomplete: ${incomplete.join(", ") || "none"}.`);
  }
  return incomplete.length > 0 ? 2 : 0;
}
