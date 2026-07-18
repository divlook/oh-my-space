import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { log } from "@clack/prompts";
import { aliasDir, runGit, submodulePath } from "./git.js";
import type { ModeSwitchJournal, StagedModeSwitchRepository } from "./mode-switch-journal.js";
import type { Repo } from "./types.js";
import { commonRepoPath, managedWorktreePath, normalizeWorktreeName } from "./worktree-paths.js";
import { inspectWorktreeInventory, inspectWorktreeState, parseWorktreeRegistrations, verifyCommonRepository } from "./worktree-inspection.js";
import { fetchWorktreeRemotes, reconcileWorktreeRemotes, resolveWorktreeBaseline } from "./worktree-sync.js";
import { isTestMode } from "./env.js";

const RAW_OBJECT_ENV = { GIT_NO_REPLACE_OBJECTS: "1" };
const OID_PATTERN = /^[0-9a-f]{40,64}$/;

export type SourceStateItem = {
  kind: "root-head" | "index-stage" | "checkout" | "branch" | "tag" | "stash" | "notes" | "replace" | "custom-ref" | "reflog-only" | "dangling";
  refname: string | null;
  oid: string;
  objectType: string;
  role: string;
  available: boolean;
  reconstructible: boolean;
  replaceSourceOid?: string;
};

export type SubmoduleSourceInventory = {
  alias: string;
  source: string;
  items: SourceStateItem[];
  fetchFailed: boolean;
};

export type WorktreePointerSource = {
  alias: string;
  target: string | null;
  oid: string | null;
  branch: string | null;
  upstream: string | null;
  sourceRepo: string;
};

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function objectType(repo: string, oid: string): string {
  const result = runGit(repo, ["cat-file", "-t", oid], false, RAW_OBJECT_ENV);
  return result.success ? result.stdout.trim() : "unknown";
}

function objectAvailable(repo: string, oid: string): boolean {
  return OID_PATTERN.test(oid) && runGit(repo, ["cat-file", "-e", oid], false, RAW_OBJECT_ENV).success;
}

function completeClosure(repo: string, oid: string): boolean {
  if (!objectAvailable(repo, oid)) return false;
  const closure = runGit(repo, ["rev-list", "--objects", "--no-object-names", oid], false, RAW_OBJECT_ENV);
  if (!closure.success) return false;
  return lines(closure.stdout).every((candidate) => objectAvailable(repo, candidate));
}

function remoteRefs(repo: string, remotes: string[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const remote of remotes) {
    const result = runGit(repo, ["ls-remote", remote], false, RAW_OBJECT_ENV);
    if (!result.success) throw new Error(`could not inspect freshly fetched remote ${remote}`);
    for (const line of lines(result.stdout)) {
      const [oid, refname] = line.split(/\s+/);
      if (OID_PATTERN.test(oid ?? "") && refname) refs.set(refname, oid);
    }
  }
  return refs;
}

function reachableFromRemote(repo: string, oid: string, refs: Map<string, string>): boolean {
  if (objectType(repo, oid) !== "commit") return false;
  return [...refs.values()].some((remoteOid) =>
    objectType(repo, remoteOid) === "commit"
    && runGit(repo, ["merge-base", "--is-ancestor", oid, remoteOid], false, RAW_OBJECT_ENV).success);
}

function rootPointerItems(workspaceRoot: string, repo: Repo): SourceStateItem[] {
  const path = submodulePath(repo.alias);
  const items: SourceStateItem[] = [];
  const committed = runGit(workspaceRoot, ["ls-tree", "HEAD", "--", path]);
  const committedMatch = committed.stdout.match(/^160000 commit ([0-9a-f]{40,64})\t/);
  if (committed.success && committedMatch) {
    items.push({ kind: "root-head", refname: null, oid: committedMatch[1], objectType: "commit", role: "committed", available: false, reconstructible: false });
  }
  const stages = runGit(workspaceRoot, ["ls-files", "--stage", "--", path]);
  if (!stages.success) throw new Error(`${repo.alias}: could not inspect root index stages`);
  for (const line of lines(stages.stdout)) {
    const match = line.match(/^160000 ([0-9a-f]{40,64}) ([0-3])\t/);
    if (match) items.push({ kind: "index-stage", refname: null, oid: match[1], objectType: "commit", role: `index-stage-${match[2]}`, available: false, reconstructible: false });
  }
  return items;
}

function localRefItems(source: string): SourceStateItem[] {
  const result = runGit(source, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)", "refs"], false, RAW_OBJECT_ENV);
  if (!result.success) throw new Error("could not inspect local refs");
  return lines(result.stdout).flatMap((line): SourceStateItem[] => {
    const [refname, oid, type] = line.split("\0");
    if (!refname || !OID_PATTERN.test(oid ?? "") || refname.startsWith("refs/remotes/") || refname.startsWith("refs/oms/")) return [];
    const kind = refname.startsWith("refs/heads/") ? "branch"
      : refname.startsWith("refs/tags/") ? "tag"
        : refname === "refs/stash" ? "stash"
          : refname.startsWith("refs/notes/") ? "notes"
            : refname.startsWith("refs/replace/") ? "replace"
              : "custom-ref";
    const replaceSourceOid = kind === "replace" ? refname.slice("refs/replace/".length) : undefined;
    return [{ kind, refname, oid, objectType: type || "unknown", role: refname, available: false, reconstructible: false, replaceSourceOid }];
  });
}

function recoverableItems(source: string): SourceStateItem[] {
  const result: SourceStateItem[] = [];
  const reflog = runGit(source, ["reflog", "show", "--all", "--format=%H"], false, RAW_OBJECT_ENV);
  if (!reflog.success && reflog.exitCode !== 1) throw new Error("could not inspect reflogs");
  for (const oid of new Set(lines(reflog.stdout).filter((value) => OID_PATTERN.test(value)))) {
    const refs = runGit(source, ["for-each-ref", "--contains", oid, "--format=%(refname)", "refs"], false, RAW_OBJECT_ENV);
    if (objectType(source, oid) === "commit" && refs.success && !refs.stdout.trim()) {
      result.push({ kind: "reflog-only", refname: null, oid, objectType: "commit", role: "reflog-only", available: true, reconstructible: false });
    }
  }
  const fsck = runGit(source, ["fsck", "--full", "--unreachable", "--no-reflogs", "--no-progress"], false, RAW_OBJECT_ENV);
  if (!fsck.success && fsck.exitCode !== 1) throw new Error("could not inspect dangling objects");
  for (const line of lines(`${fsck.stdout}\n${fsck.stderr}`)) {
    const match = line.match(/^(?:unreachable|dangling) ([a-z]+) ([0-9a-f]{40,64})$/);
    if (match && !result.some(({ oid }) => oid === match[2])) {
      result.push({ kind: "dangling", refname: null, oid: match[2], objectType: match[1], role: `dangling-${match[1]}`, available: true, reconstructible: false });
    }
  }
  return result;
}

/** Inventories all submodule pointer, ref, reflog, and dangling source state after fresh fetches. */
export function inventorySubmoduleSources(workspaceRoot: string, repos: Repo[]): SubmoduleSourceInventory[] {
  return repos.map((repo) => {
    const source = aliasDir(workspaceRoot, repo.alias);
    const pointerItems = rootPointerItems(workspaceRoot, repo);
    if (!existsSync(source)) return { alias: repo.alias, source, items: pointerItems, fetchFailed: false };
    let fetchFailed = false;
    for (const remote of Object.keys(repo.remotes)) {
      if (!runGit(source, ["fetch", remote, "--prune"], true).success) fetchFailed = true;
    }
    const refs = fetchFailed ? new Map<string, string>() : remoteRefs(source, Object.keys(repo.remotes));
    const checkoutItems = parseWorktreeRegistrations(source).flatMap((worktree): SourceStateItem[] =>
      !worktree.bare && worktree.head && OID_PATTERN.test(worktree.head)
        ? [{ kind: "checkout", refname: null, oid: worktree.head, objectType: "commit", role: `checkout:${worktree.path}`, available: false, reconstructible: false }]
        : []);
    const items = [...pointerItems, ...checkoutItems, ...localRefItems(source), ...recoverableItems(source)];
    for (const item of items) {
      item.available = objectAvailable(source, item.oid) && completeClosure(source, item.oid)
        && (!item.replaceSourceOid || completeClosure(source, item.replaceSourceOid));
      if (fetchFailed) continue;
      if (item.kind === "branch") {
        const branch = item.refname!.slice("refs/heads/".length);
        item.reconstructible = item.available && refs.get(`refs/heads/${branch}`) === item.oid;
      } else if (["tag", "stash", "notes", "replace", "custom-ref"].includes(item.kind)) {
        item.reconstructible = item.available && refs.get(item.refname!) === item.oid;
      } else if (item.kind !== "reflog-only" && item.kind !== "dangling") {
        item.reconstructible = item.available && reachableFromRemote(source, item.oid, refs);
      }
    }
    return { alias: repo.alias, source, items, fetchFailed };
  });
}

export function nonReconstructibleItems(inventories: SubmoduleSourceInventory[]): SourceStateItem[] {
  return inventories.flatMap(({ items }) => items.filter(({ reconstructible }) => !reconstructible));
}

function stagingRoot(workspaceRoot: string, transitionId: string): string {
  const gitDir = runGit(workspaceRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.success) throw new Error("could not resolve root Git directory for mode-switch staging");
  return join(gitDir.stdout.trim(), "oms", "mode-switch", transitionId);
}

function stagedPath(workspaceRoot: string, transitionId: string, alias: string): string {
  return join(stagingRoot(workspaceRoot, transitionId), `${alias}.git`);
}

function initializeStagedRepo(workspaceRoot: string, transitionId: string, alias: string): string {
  const path = stagedPath(workspaceRoot, transitionId, alias);
  if (existsSync(path)) {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${alias}: staged mode-switch repository path is unsafe`);
    const owner = runGit(path, ["config", "--get", "oms.transitionId"]);
    const configuredAlias = runGit(path, ["config", "--get", "oms.alias"]);
    if (!owner.success || owner.stdout.trim() !== transitionId || configuredAlias.stdout.trim() !== alias) {
      throw new Error(`${alias}: staged mode-switch repository has foreign ownership`);
    }
    return path;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!runGit(workspaceRoot, ["init", "--bare", path]).success
    || !runGit(path, ["config", "oms.transitionId", transitionId]).success
    || !runGit(path, ["config", "oms.alias", alias]).success) {
    throw new Error(`${alias}: could not initialize staged mode-switch repository`);
  }
  return path;
}

function copyRawClosure(source: string, target: string, oids: string[]): void {
  if (isTestMode() && process.env.OMS_TEST_FAIL_AT === "mode-switch-object-copy") {
    throw new Error("injected mode-switch object-copy failure");
  }
  const unique = [...new Set(oids.filter((oid) => OID_PATTERN.test(oid)))];
  if (unique.length === 0) return;
  const packed = spawnSync("git", ["pack-objects", "--stdout", "--revs"], {
    cwd: source,
    input: `${unique.join("\n")}\n`,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (packed.status !== 0 || !packed.stdout) throw new Error("could not read complete raw object closure from source repository");
  const indexed = spawnSync("git", ["index-pack", "--stdin", "--fix-thin"], {
    cwd: target,
    input: packed.stdout,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (indexed.status !== 0) throw new Error("could not import complete raw object closure into staged repository");
  for (const oid of unique) {
    if (!completeClosure(target, oid)) throw new Error(`staged repository has incomplete object closure for ${oid}`);
  }
}

function anchorRef(transitionId: string, item: SourceStateItem, index: number): string {
  const digest = createHash("sha256").update(`${item.kind}\0${item.role}\0${item.oid}`).digest("hex").slice(0, 16);
  return `refs/oms/mode-switch/${transitionId}/${item.kind}/${index}-${digest}`;
}

function updateVerifiedRef(target: string, refname: string, oid: string): void {
  if (!runGit(target, ["check-ref-format", refname]).success) throw new Error(`invalid preservation refname ${refname}`);
  const existing = runGit(target, ["rev-parse", "--verify", refname]);
  if (existing.success && existing.stdout.trim() !== oid) throw new Error(`preservation ref collision at ${refname}`);
  if (!existing.success && !runGit(target, ["update-ref", refname, oid, "0".repeat(oid.length)]).success) {
    throw new Error(`could not create preservation ref ${refname}`);
  }
  if (runGit(target, ["rev-parse", "--verify", refname]).stdout.trim() !== oid) throw new Error(`preservation ref ${refname} did not verify`);
}

function verifyConnectivity(target: string, expected: string[]): void {
  if (isTestMode() && process.env.OMS_TEST_FAIL_AT === "mode-switch-connectivity") {
    throw new Error("injected mode-switch connectivity failure");
  }
  for (const oid of expected) {
    if (!completeClosure(target, oid)) throw new Error(`connectivity verification failed for ${oid}`);
  }
  const fsck = runGit(target, ["fsck", "--full", "--no-reflogs", "--no-progress"], false, RAW_OBJECT_ENV);
  if (!fsck.success) throw new Error("staged repository connectivity check failed");
}

/** Creates verified staged worktree common repositories for all non-reconstructible submodule state. */
export function stageSubmodulePreservation(
  workspaceRoot: string,
  repos: Repo[],
  inventories: SubmoduleSourceInventory[],
  journal: ModeSwitchJournal,
): StagedModeSwitchRepository[] {
  return repos.map((repo) => {
    const inventory = inventories.find(({ alias }) => alias === repo.alias)!;
    const retained = inventory.items.filter(({ reconstructible }) => !reconstructible);
    const unavailable = retained.filter(({ available }) => !available);
    if (unavailable.length > 0) {
      throw new Error(`${repo.alias}: unavailable object closure cannot be preserved: ${unavailable.map(({ role, oid }) => `${role} ${oid}`).join(", ")}`);
    }
    const target = initializeStagedRepo(workspaceRoot, journal.transitionId, repo.alias);
    const closure = retained.flatMap((item) => [item.oid, ...(item.replaceSourceOid ? [item.replaceSourceOid] : [])]);
    copyRawClosure(inventory.source, target, closure);
    const refs: Array<{ refname: string; oid: string }> = [];
    retained.forEach((item, index) => {
      const direct = item.refname && !item.refname.startsWith("refs/remotes/") ? item.refname : null;
      let refname = direct ?? anchorRef(journal.transitionId, item, index);
      const collision = runGit(target, ["rev-parse", "--verify", refname]);
      if (collision.success && collision.stdout.trim() !== item.oid) refname = anchorRef(journal.transitionId, item, index);
      updateVerifiedRef(target, refname, item.oid);
      refs.push({ refname, oid: item.oid });
      if (item.replaceSourceOid) {
        const sourceAnchor = `${anchorRef(journal.transitionId, item, index)}-replaced`;
        updateVerifiedRef(target, sourceAnchor, item.replaceSourceOid);
        refs.push({ refname: sourceAnchor, oid: item.replaceSourceOid });
      }
    });
    verifyConnectivity(target, closure);
    const baselineRef = repo.branch ? `refs/heads/${repo.branch}` : null;
    const baseline = baselineRef ? retained.find((item) => item.refname === baselineRef) : undefined;
    const upstream = baselineRef
      ? runGit(inventory.source, ["for-each-ref", "--format=%(upstream:short)", baselineRef]).stdout.trim() || null
      : null;
    return {
      alias: repo.alias,
      path: target,
      selectedOid: baseline?.oid ?? null,
      selectedBranch: baseline ? repo.branch! : null,
      selectedUpstream: baseline ? upstream : null,
      refs,
    };
  });
}

/** Resolves ownership-verified viable worktree pointer candidates without hiding destructive state. */
export function worktreePointerCandidates(workspaceRoot: string, repos: Repo[], workspaceId: string): Map<string, WorktreePointerSource[]> {
  const result = new Map<string, WorktreePointerSource[]>();
  for (const repo of repos) {
    const candidates: WorktreePointerSource[] = [];
    if (!existsSync(commonRepoPath(workspaceRoot, repo.alias))) {
      result.set(repo.alias, candidates);
      continue;
    }
    const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
    for (const worktree of inventory.worktrees) {
      if (!worktree.managed || worktree.stale || !worktree.canonicalPath || !worktree.target || !worktree.head) continue;
      try {
        const state = inspectWorktreeState(worktree.path);
        if (!state.head || !completeClosure(inventory.commonDir, state.head)) continue;
        candidates.push({
          alias: repo.alias,
          target: worktree.target,
          oid: state.head,
          branch: state.branch,
          upstream: state.trackingBranch,
          sourceRepo: inventory.commonDir,
        });
      } catch {}
    }
    result.set(repo.alias, candidates);
  }
  return result;
}

function configureStagedRemotes(staged: string, repo: Repo): void {
  for (const [name, url] of Object.entries(repo.remotes)) {
    const existing = runGit(staged, ["remote", "get-url", name]);
    if (!existing.success && !runGit(staged, ["remote", "add", name, url]).success) throw new Error(`${repo.alias}: could not configure staged remote ${name}`);
    if (existing.success && existing.stdout.trim() !== url && !runGit(staged, ["remote", "set-url", name, url]).success) throw new Error(`${repo.alias}: could not reconcile staged remote ${name}`);
    if (!runGit(staged, ["config", "--replace-all", `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`]).success) {
      throw new Error(`${repo.alias}: could not configure staged fetch refspec`);
    }
    if (!runGit(staged, ["fetch", "--atomic", "--prune", name]).success) throw new Error(`${repo.alias}: staged target fetch ${name} failed`);
  }
}

/** Stages selected worktree OIDs or fresh baselines in target submodule repositories. */
export function stageSubmoduleTargets(
  workspaceRoot: string,
  repos: Repo[],
  selections: WorktreePointerSource[],
  journal: ModeSwitchJournal,
): StagedModeSwitchRepository[] {
  return repos.map((repo) => {
    const selected = selections.find(({ alias }) => alias === repo.alias)!;
    const target = initializeStagedRepo(workspaceRoot, journal.transitionId, repo.alias);
    configureStagedRemotes(target, repo);
    let oid = selected.oid;
    let branch = selected.branch;
    let upstream = selected.upstream;
    if (oid && !objectAvailable(target, oid)) copyRawClosure(selected.sourceRepo, target, [oid]);
    if (!oid) {
      if (!repo.branch) {
        const remoteHead = runGit(target, ["ls-remote", "--symref", "origin", "HEAD"]);
        const match = remoteHead.stdout.match(/^ref:\s+refs\/heads\/([^\t\n]+)\s+HEAD$/m);
        if (remoteHead.success && match) runGit(target, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${match[1]}`]);
      }
      const baseline = repo.branch ?? (() => {
        const symbolic = runGit(target, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        return symbolic.success && symbolic.stdout.trim().startsWith("origin/") ? symbolic.stdout.trim().slice(7) : null;
      })();
      if (!baseline) throw new Error(`${repo.alias}: no viable worktree source and origin baseline could not be resolved after fresh fetch`);
      const resolved = runGit(target, ["rev-parse", "--verify", `refs/remotes/origin/${baseline}^{commit}`]);
      if (!resolved.success) throw new Error(`${repo.alias}: no viable worktree source and fresh baseline origin/${baseline} is unavailable`);
      oid = resolved.stdout.trim();
      branch = baseline;
      upstream = `origin/${baseline}`;
    }
    if (!oid || !completeClosure(target, oid)) throw new Error(`${repo.alias}: selected target OID ${oid ?? "missing"} failed staged closure verification`);
    const refs: Array<{ refname: string; oid: string }> = [];
    if (branch) {
      const branchRef = `refs/heads/${branch}`;
      updateVerifiedRef(target, branchRef, oid);
      refs.push({ refname: branchRef, oid });
    } else {
      const anchor = `refs/oms/mode-switch/${journal.transitionId}/selected/${repo.alias}`;
      updateVerifiedRef(target, anchor, oid);
      refs.push({ refname: anchor, oid });
    }
    verifyConnectivity(target, [oid]);
    return { alias: repo.alias, path: target, selectedOid: oid, selectedBranch: branch, selectedUpstream: upstream, refs };
  });
}

function writeProvisioningComplete(workspaceRoot: string, journal: ModeSwitchJournal, repo: Repo, branch: string, name: string): void {
  const path = join(workspaceRoot, ".oms", "provisioning", `${repo.alias}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ version: 1, workspaceId: journal.workspaceId, alias: repo.alias, phase: "complete", branch, name }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** Installs preserved staged common repositories and creates baseline-precedence worktrees idempotently. */
export function installStagedWorktreeRepositories(workspaceRoot: string, repos: Repo[], journal: ModeSwitchJournal): number {
  for (const staged of journal.stagedRepositories) {
    const repo = repos.find(({ alias }) => alias === staged.alias)!;
    if (staged.path !== stagedPath(workspaceRoot, journal.transitionId, repo.alias)) throw new Error(`${repo.alias}: staged repository path does not match the journal owner`);
    const final = commonRepoPath(workspaceRoot, repo.alias);
    if (!existsSync(final)) {
      mkdirSync(dirname(final), { recursive: true, mode: 0o700 });
      renameSync(staged.path, final);
    } else {
      const entry = lstatSync(final);
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || runGit(final, ["config", "--get", "oms.transitionId"]).stdout.trim() !== journal.transitionId) {
        throw new Error(`${repo.alias}: target common repository exists without transition ownership`);
      }
    }
    if (!runGit(final, ["config", "oms.workspaceId", journal.workspaceId]).success
      || !runGit(final, ["config", "oms.alias", repo.alias]).success
      || !runGit(final, ["config", "worktree.useRelativePaths", "true"]).success) {
      throw new Error(`${repo.alias}: could not finalize target common repository ownership`);
    }
    verifyCommonRepository(workspaceRoot, repo.alias, journal.workspaceId);
    reconcileWorktreeRemotes(workspaceRoot, final, repo);
    const fetched = fetchWorktreeRemotes(workspaceRoot, final, repo);
    if (fetched.code !== 0) return fetched.code;
    const baseline = repo.branch ?? resolveWorktreeBaseline(workspaceRoot, final, repo);
    if (!baseline) throw new Error(`${repo.alias}: target baseline could not be resolved`);
    const local = runGit(final, ["rev-parse", "--verify", `refs/heads/${baseline}^{commit}`]);
    if (!local.success && !runGit(final, ["branch", "--track", baseline, `refs/remotes/origin/${baseline}`]).success) {
      throw new Error(`${repo.alias}: could not create target baseline branch`);
    }
    const upstream = runGit(final, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${baseline}`]).stdout.trim();
    const preservedUpstreamRemote = staged.selectedUpstream?.split("/", 1)[0];
    const preservedUpstreamExists = staged.selectedUpstream
      ? runGit(final, ["rev-parse", "--verify", `refs/remotes/${staged.selectedUpstream}^{commit}`]).success
      : false;
    if (staged.selectedBranch === baseline && staged.selectedUpstream && preservedUpstreamRemote
      && Object.hasOwn(repo.remotes, preservedUpstreamRemote) && preservedUpstreamExists) {
      if (!runGit(final, ["branch", "--set-upstream-to", staged.selectedUpstream, baseline]).success) {
        throw new Error(`${repo.alias}: could not retain the declared preserved baseline upstream`);
      }
    } else if (staged.selectedBranch === baseline && staged.selectedUpstream) {
      runGit(final, ["branch", "--unset-upstream", baseline]);
      log.warn(`${repo.alias}: preserved baseline upstream ${staged.selectedUpstream} is undeclared or unavailable and was left unset; publish or set a declared upstream later.`);
    } else if (upstream && !Object.hasOwn(repo.remotes, upstream.split("/", 1)[0])) {
      runGit(final, ["branch", "--unset-upstream", baseline]);
      log.warn(`${repo.alias}: preserved baseline upstream ${upstream} is undeclared and was left unset; publish or set a declared upstream later.`);
    }
    const name = normalizeWorktreeName(baseline);
    const checkout = managedWorktreePath(workspaceRoot, { alias: repo.alias, name });
    if (!existsSync(checkout)) {
      mkdirSync(dirname(checkout), { recursive: true });
      if (!runGit(final, ["worktree", "add", "--relative-paths", checkout, baseline], true).success) throw new Error(`${repo.alias}: could not create target worktree`);
    }
    writeProvisioningComplete(workspaceRoot, journal, repo, baseline, name);
  }
  return 0;
}

/** Installs verified staged repositories as submodules at their selected OIDs. */
export function installStagedSubmoduleRepositories(workspaceRoot: string, repos: Repo[], journal: ModeSwitchJournal): void {
  for (const staged of journal.stagedRepositories) {
    const repo = repos.find(({ alias }) => alias === staged.alias)!;
    if (staged.path !== stagedPath(workspaceRoot, journal.transitionId, repo.alias)) throw new Error(`${repo.alias}: staged repository path does not match the journal owner`);
    if (!staged.selectedOid) throw new Error(`${repo.alias}: staged submodule target has no selected OID`);
    const moduleResult = runGit(workspaceRoot, ["rev-parse", "--git-path", `modules/oms/${repo.alias}`]);
    if (!moduleResult.success) throw new Error(`${repo.alias}: could not resolve target submodule Git directory`);
    const moduleValue = moduleResult.stdout.trim();
    const module = isAbsolute(moduleValue) ? moduleValue : resolve(workspaceRoot, moduleValue);
    const checkout = aliasDir(workspaceRoot, repo.alias);
    if (!existsSync(module)) {
      mkdirSync(dirname(module), { recursive: true, mode: 0o700 });
      renameSync(staged.path, module);
    } else {
      const entry = lstatSync(module);
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || runGit(module, ["config", "--get", "oms.transitionId"]).stdout.trim() !== journal.transitionId) {
        throw new Error(`${repo.alias}: target submodule repository exists without transition ownership`);
      }
    }
    mkdirSync(checkout, { recursive: true });
    if (!runGit(module, ["config", "core.bare", "false"]).success
      || !runGit(module, ["config", "core.worktree", relative(module, checkout)]).success) {
      throw new Error(`${repo.alias}: could not configure installed submodule worktree`);
    }
    writeFileSync(join(checkout, ".git"), `gitdir: ${relative(checkout, module)}\n`);
    if (staged.selectedBranch && runGit(module, ["rev-parse", "--verify", `refs/heads/${staged.selectedBranch}`]).success) {
      if (!runGit(checkout, ["checkout", "-f", staged.selectedBranch], true).success) throw new Error(`${repo.alias}: could not check out selected branch`);
      const remote = staged.selectedUpstream?.split("/", 1)[0];
      const upstreamExists = staged.selectedUpstream
        ? runGit(checkout, ["rev-parse", "--verify", `refs/remotes/${staged.selectedUpstream}^{commit}`]).success
        : false;
      if (staged.selectedUpstream && remote && Object.hasOwn(repo.remotes, remote) && upstreamExists) {
        if (!runGit(checkout, ["branch", "--set-upstream-to", staged.selectedUpstream, staged.selectedBranch]).success) {
          throw new Error(`${repo.alias}: could not retain selected declared upstream`);
        }
      } else if (staged.selectedUpstream) {
        runGit(checkout, ["branch", "--unset-upstream", staged.selectedBranch]);
        log.warn(`${repo.alias}: selected upstream ${staged.selectedUpstream} is undeclared or unavailable and was left unset.`);
      }
    } else if (!runGit(checkout, ["checkout", "--detach", "-f", staged.selectedOid], true).success) {
      throw new Error(`${repo.alias}: could not check out selected OID ${staged.selectedOid}`);
    }
    if (runGit(checkout, ["rev-parse", "HEAD"]).stdout.trim() !== staged.selectedOid) throw new Error(`${repo.alias}: installed submodule HEAD does not match selected OID`);
    if (!runGit(workspaceRoot, ["update-index", "--add", "--cacheinfo", `160000,${staged.selectedOid},${submodulePath(repo.alias)}`]).success) {
      throw new Error(`${repo.alias}: could not stage the verified selected submodule gitlink`);
    }
    for (const [name, url] of Object.entries(repo.remotes)) {
      const current = runGit(checkout, ["remote", "get-url", name]);
      if (!current.success) runGit(checkout, ["remote", "add", name, url]);
      else if (current.stdout.trim() !== url) runGit(checkout, ["remote", "set-url", name, url]);
    }
    if (!runGit(workspaceRoot, ["config", "--file", ".gitmodules", `submodule.${submodulePath(repo.alias)}.path`, submodulePath(repo.alias)]).success
      || !runGit(workspaceRoot, ["config", "--file", ".gitmodules", `submodule.${submodulePath(repo.alias)}.url`, repo.remotes.origin]).success
      || (repo.branch && !runGit(workspaceRoot, ["config", "--file", ".gitmodules", `submodule.${submodulePath(repo.alias)}.branch`, repo.branch]).success)
      || !runGit(workspaceRoot, ["config", `submodule.${submodulePath(repo.alias)}.url`, repo.remotes.origin]).success
      || !runGit(workspaceRoot, ["config", `submodule.${submodulePath(repo.alias)}.active`, "true"]).success) {
      throw new Error(`${repo.alias}: could not install target submodule metadata`);
    }
  }
}

export function cleanupModeSwitchStaging(workspaceRoot: string, transitionId: string): void {
  const gitDir = runGit(workspaceRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir.success) return;
  rmSync(join(gitDir.stdout.trim(), "oms", "mode-switch", transitionId), { recursive: true, force: true });
}
