import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cancel, log } from "@clack/prompts";
import { runGit } from "./git.js";
import { validateWorktreeRemoteUrl } from "./manifest.js";
import { NetworkSafetyError, networkFailure, runNetworkGit } from "./network-git.js";
import { guardedSelect, isCancel, promptQueueActive } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import {
  assertGeneratedPathSupported,
  assertNoSymlinkComponents,
  commonRepoPath,
  managedWorktreePath,
  normalizeWorktreeName,
  validateWorktreeName,
} from "./worktree-paths.js";
import { readWorkspaceOwnership } from "./workspace-mutation.js";
import { inspectWorktreeInventory, verifyCommonRepository } from "./worktree-inspection.js";

type ProvisioningPhase = "common-ready" | "branch-ready" | "worktree-created" | "complete";
type ProvisioningState = {
  version: 1;
  workspaceId: string;
  alias: string;
  phase: ProvisioningPhase;
  branch: string | null;
  name: string | null;
};

type FetchProvenance = {
  version: 1;
  workspaceId: string;
  alias: string;
  remote: string;
  fingerprint: string;
  generation: string;
};

export type FetchProvenanceInspection =
  | { kind: "missing" }
  | { kind: "trusted" }
  | { kind: "untrusted"; reason: string };

type FetchDeclaredRemotesResult = {
  code: 0 | 1 | 2;
  succeeded: string[];
  safetyFailures: string[];
  operationalFailures: string[];
};

class ProvisioningSafetyError extends Error {}
type BranchSnapshot = { branch: string; oid: string };

function atomicJson(workspaceRoot: string, path: string, value: unknown): void {
  assertNoSymlinkComponents(workspaceRoot, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function provisioningPath(workspaceRoot: string, alias: string): string {
  return join(workspaceRoot, ".oms", "provisioning", `${alias}.json`);
}

function readProvisioning(workspaceRoot: string, repo: Repo, workspaceId: string): ProvisioningState | null {
  const path = provisioningPath(workspaceRoot, repo.alias);
  try {
    assertNoSymlinkComponents(workspaceRoot, path);
  } catch (error) {
    throw new ProvisioningSafetyError(error instanceof Error ? error.message : String(error));
  }
  if (!existsSync(path)) return null;
  let value: Partial<ProvisioningState>;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProvisioningState>;
  } catch {
    throw new ProvisioningSafetyError(`${repo.alias}: provisioning state is malformed; run "oms doctor"`);
  }
  const allowedKeys = new Set(["version", "workspaceId", "alias", "phase", "branch", "name"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.version !== 1 || value.workspaceId !== workspaceId || value.alias !== repo.alias
    || !["common-ready", "branch-ready", "worktree-created", "complete"].includes(value.phase ?? "")
    || (value.phase === "common-ready" && (value.branch !== null || value.name !== null))
    || ((value.phase === "branch-ready" || value.phase === "worktree-created" || value.phase === "complete")
      && (typeof value.branch !== "string" || value.branch.length === 0
        || typeof value.name !== "string" || value.name.length === 0))) {
    throw new ProvisioningSafetyError(`${repo.alias}: provisioning state is malformed or has foreign ownership; run "oms doctor"`);
  }
  if (typeof value.name === "string") {
    try {
      validateWorktreeName(value.name);
    } catch {
      throw new ProvisioningSafetyError(`${repo.alias}: provisioning state has an invalid worktree name; run "oms doctor"`);
    }
  }
  return value as ProvisioningState;
}

function writeProvisioning(workspaceRoot: string, state: ProvisioningState): void {
  try {
    atomicJson(workspaceRoot, provisioningPath(workspaceRoot, state.alias), state);
  } catch (error) {
    if (error instanceof Error && /symbolic link|outside the workspace/.test(error.message)) {
      throw new ProvisioningSafetyError(error.message);
    }
    throw error;
  }
}

function fetchRefspec(remote: string): string {
  return `+refs/heads/*:refs/remotes/${remote}/*`;
}

function fetchFingerprint(repo: Repo, remote: string): string {
  return createHash("sha256")
    .update(`${repo.remotes[remote]}\0${fetchRefspec(remote)}`)
    .digest("hex");
}

function checkedProvenancePath(workspaceRoot: string, alias: string, remote: string): string {
  const path = provenancePath(workspaceRoot, alias, remote);
  assertNoSymlinkComponents(workspaceRoot, path);
  return path;
}

function verifyOrInitializeCommon(
  workspaceRoot: string,
  repo: Repo,
  workspaceId: string,
): { path: string; created: boolean } {
  const path = commonRepoPath(workspaceRoot, repo.alias);
  try {
    assertNoSymlinkComponents(workspaceRoot, path);
    assertGeneratedPathSupported(path);
  } catch (error) {
    throw new ProvisioningSafetyError(error instanceof Error ? error.message : String(error));
  }
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const initialized = runGit(workspaceRoot, ["init", "--bare", path]);
    if (!initialized.success) throw new Error(`${repo.alias}: could not initialize common repository`);
    if (!runGit(path, ["config", "worktree.useRelativePaths", "true"]).success
      || !runGit(path, ["config", "oms.workspaceId", workspaceId]).success
      || !runGit(path, ["config", "oms.alias", repo.alias]).success) {
      throw new Error(`${repo.alias}: could not record common repository ownership`);
    }
  } else {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProvisioningSafetyError(`${repo.alias}: common repository path is not an owned directory`);
    }
    try {
      verifyCommonRepository(workspaceRoot, repo.alias, workspaceId);
    } catch (error) {
      throw new ProvisioningSafetyError(error instanceof Error ? error.message : String(error));
    }
    return { path, created: false };
  }
  return { path, created: true };
}

export function reconcileWorktreeRemotes(workspaceRoot: string, common: string, repo: Repo): void {
  for (const [name, url] of Object.entries(repo.remotes)) {
    validateWorktreeRemoteUrl(url, `repository ${repo.alias} remote ${name}`);
    const urls = runGit(common, ["config", "--get-all", `remote.${name}.url`]);
    const existing = urls.success ? urls.stdout.split("\n").filter(Boolean) : [];
    const refspecs = runGit(common, ["config", "--get-all", `remote.${name}.fetch`]);
    const configuredRefspecs = refspecs.success ? refspecs.stdout.split("\n").filter(Boolean) : [];
    const drifted = existing.length !== 1 || existing[0] !== url
      || configuredRefspecs.length !== 1 || configuredRefspecs[0] !== fetchRefspec(name);
    if (drifted) {
      try {
        rmSync(checkedProvenancePath(workspaceRoot, repo.alias, name), { force: true });
      } catch (error) {
        if (error instanceof Error && /symbolic link|outside the workspace/.test(error.message)) {
          throw new ProvisioningSafetyError(error.message);
        }
        throw error;
      }
    }
    if (existing.length === 0) {
      if (!runGit(common, ["remote", "add", name, url]).success) throw new Error(`${repo.alias}: could not add remote ${name}`);
    } else if (existing.length !== 1) {
      throw new ProvisioningSafetyError(`${repo.alias}: remote ${name} has additional fetch URLs`);
    } else if (existing[0] !== url && !runGit(common, ["remote", "set-url", name, url]).success) {
      throw new Error(`${repo.alias}: could not reconcile remote ${name}`);
    }
    const pushUrls = runGit(common, ["config", "--get-all", `remote.${name}.pushurl`]);
    const configuredPushUrls = pushUrls.success ? pushUrls.stdout.split("\n").filter(Boolean) : [];
    if (configuredPushUrls.length > 0) throw new ProvisioningSafetyError(`${repo.alias}: remote ${name} has undeclared pushurl configuration`);
    if (!runGit(common, ["config", "--replace-all", `remote.${name}.fetch`, fetchRefspec(name)]).success) {
      throw new Error(`${repo.alias}: could not reconcile ${name} fetch refspec`);
    }
  }
}

function provenancePath(workspaceRoot: string, alias: string, remote: string): string {
  return join(workspaceRoot, ".oms", "fetch-provenance", alias, `${remote}.json`);
}

export function recordFetchProvenance(workspaceRoot: string, repo: Repo, remote: string): void {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) throw new Error(`${repo.alias}: workspace ownership is missing; fetch provenance was not recorded`);
  const value: FetchProvenance = {
    version: 1,
    workspaceId: ownership.workspaceId,
    alias: repo.alias,
    remote,
    fingerprint: fetchFingerprint(repo, remote),
    generation: randomUUID(),
  };
  atomicJson(workspaceRoot, provenancePath(workspaceRoot, repo.alias, remote), value);
}

export function hasTrustedFetchProvenance(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  remote: string,
): boolean {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  let path: string;
  try {
    path = checkedProvenancePath(workspaceRoot, repo.alias, remote);
  } catch {
    return false;
  }
  if (!ownership || !existsSync(path)) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<FetchProvenance>;
    if (value.version !== 1 || value.workspaceId !== ownership.workspaceId || value.alias !== repo.alias
      || value.remote !== remote || value.fingerprint !== fetchFingerprint(repo, remote)
      || typeof value.generation !== "string") return false;
    const urls = runGit(common, ["config", "--get-all", `remote.${remote}.url`]);
    const refspecs = runGit(common, ["config", "--get-all", `remote.${remote}.fetch`]);
    const pushUrls = runGit(common, ["config", "--get-all", `remote.${remote}.pushurl`]);
    return urls.success && urls.stdout.split("\n").filter(Boolean).length === 1
      && urls.stdout.trim() === repo.remotes[remote]
      && refspecs.success && refspecs.stdout.split("\n").filter(Boolean).length === 1
      && refspecs.stdout.trim() === fetchRefspec(remote)
      && (!pushUrls.success || pushUrls.stdout.trim() === "");
  } catch {
    return false;
  }
}

/** Inspect durable fetch provenance without changing remote configuration or local state. */
export function inspectFetchProvenance(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  remote: string,
): FetchProvenanceInspection {
  let path: string;
  try {
    path = checkedProvenancePath(workspaceRoot, repo.alias, remote);
  } catch (error) {
    return { kind: "untrusted", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<FetchProvenance>;
    const ownership = readWorkspaceOwnership(workspaceRoot);
    if (!ownership || value.version !== 1 || value.workspaceId !== ownership.workspaceId
      || value.alias !== repo.alias || value.remote !== remote
      || value.fingerprint !== fetchFingerprint(repo, remote) || typeof value.generation !== "string") {
      return { kind: "untrusted", reason: "ownership, endpoint, or refspec fingerprint does not match" };
    }
    return hasTrustedFetchProvenance(workspaceRoot, common, repo, remote)
      ? { kind: "trusted" }
      : { kind: "untrusted", reason: "common-repository endpoint or refspec configuration drifted" };
  } catch (error) {
    return { kind: "untrusted", reason: error instanceof Error ? error.message : "state is malformed" };
  }
}

export function fetchWorktreeRemotes(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  remotes = Object.keys(repo.remotes),
): FetchDeclaredRemotesResult {
  const succeeded: string[] = [];
  const safetyFailures: string[] = [];
  const operationalFailures: string[] = [];
  for (const remote of remotes) {
    log.step(`${repo.alias}: fetching ${remote}`);
    let result;
    try {
      result = runNetworkGit(
        common,
        repo,
        remote,
        (endpoint) => ["fetch", "--atomic", "--prune", endpoint, fetchRefspec(remote)],
        {
          inheritOutput: true,
          onSuccess: () => recordFetchProvenance(workspaceRoot, repo, remote),
        },
      );
    } catch (error) {
      networkFailure(repo, remote, error);
      if (error instanceof NetworkSafetyError) safetyFailures.push(remote);
      else operationalFailures.push(remote);
      continue;
    }
    if (!result.success) {
      log.error(`${repo.alias}: fetch ${remote} failed`);
      operationalFailures.push(remote);
      continue;
    }
    succeeded.push(remote);
    log.success(`${repo.alias}: fetched ${remote}`);
  }
  return {
    code: operationalFailures.length > 0 ? 2 : safetyFailures.length > 0 ? 1 : 0,
    succeeded,
    safetyFailures,
    operationalFailures,
  };
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

async function acceptDegradedProvisioning(repo: Repo, result: FetchDeclaredRemotesResult): Promise<boolean> {
  const failed = result.operationalFailures.join(", ");
  if (!interactive()) {
    log.error(
      `${repo.alias}: origin fetched, but additional remote(s) ${failed} failed. No worktree was created because degraded initial provisioning requires an interactive choice.`,
    );
    return false;
  }
  const choice = await guardedSelect<string>({
    message: `${repo.alias}: additional remote(s) ${failed} failed; continue with degraded remote state?`,
    options: [
      { value: "continue", label: "continue", hint: "create the first worktree with successful remote data" },
      { value: "cancel", label: "cancel", hint: "preserve fetched data without creating a worktree" },
    ],
  });
  if (isCancel(choice) || choice === "cancel") {
    cancel(`${repo.alias}: cancelled. Fetched objects were preserved; no worktree was created.`);
    return false;
  }
  log.warn(`${repo.alias}: continuing with degraded remote state; failed remote(s): ${failed}`);
  return true;
}

export function resolveWorktreeBaseline(workspaceRoot: string, common: string, repo: Repo): string | null {
  if (repo.branch) {
    return runGit(common, ["rev-parse", "--verify", `refs/remotes/origin/${repo.branch}^{commit}`]).success
      ? repo.branch
      : null;
  }
  try {
    const remoteHead = runNetworkGit(
      common,
      repo,
      "origin",
      (endpoint) => ["ls-remote", "--symref", endpoint, "HEAD"],
    );
    const match = remoteHead.stdout.match(/^ref:\s+refs\/heads\/([^\t\n]+)\s+HEAD$/m);
    if (!remoteHead.success || !match
      || !runGit(common, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${match[1]}`]).success) {
      return null;
    }
  } catch (error) {
    networkFailure(repo, "origin", error);
    return null;
  }
  const result = runGit(common, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const value = result.stdout.trim();
  return result.success && value.startsWith("origin/") ? value.slice("origin/".length) : null;
}

function provisionFirstWorktree(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  workspaceId: string,
  state: ProvisioningState,
  expectedBranch: BranchSnapshot | null,
): void {
  let current = state;
  if (current.phase === "complete") return;
  const branch = current.branch ?? expectedBranch?.branch ?? resolveWorktreeBaseline(workspaceRoot, common, repo);
  if (!branch) throw new ProvisioningSafetyError(`${repo.alias}: origin baseline could not be resolved; declare branch or repair origin/HEAD`);
  const name = current.name ?? normalizeWorktreeName(branch);
  validateWorktreeName(name);
  const target = managedWorktreePath(workspaceRoot, { alias: repo.alias, name });
  try {
    assertNoSymlinkComponents(workspaceRoot, target);
    assertGeneratedPathSupported(target);
  } catch (error) {
    throw new ProvisioningSafetyError(error instanceof Error ? error.message : String(error));
  }
  if (expectedBranch) {
    const currentBranch = runGit(common, ["rev-parse", "--verify", `refs/heads/${expectedBranch.branch}^{commit}`]);
    if (branch !== expectedBranch.branch || !currentBranch.success || currentBranch.stdout.trim() !== expectedBranch.oid) {
      throw new ProvisioningSafetyError(`${repo.alias}: provisioning branch changed during sync; run "oms doctor"`);
    }
  }

  if (current.phase === "common-ready") {
    const localBranch = runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (localBranch.success) {
      const upstream = runGit(common, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
      if (!expectedBranch || localBranch.stdout.trim() !== expectedBranch.oid
        || !upstream.success || upstream.stdout.trim() !== `refs/remotes/origin/${branch}`) {
        throw new ProvisioningSafetyError(`${repo.alias}: provisioning branch ${branch} changed during sync; run "oms doctor"`);
      }
    } else {
      const created = runGit(common, ["branch", "--track", branch, `refs/remotes/origin/${branch}`]);
      if (!created.success) throw new Error(`${repo.alias}: could not create baseline branch ${branch}`);
    }
    current = { ...current, phase: "branch-ready", branch, name };
    writeProvisioning(workspaceRoot, current);
  }
  if (current.phase === "branch-ready") {
    const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
    const existing = inventory.worktrees.find((entry) => entry.path === target);
    if (existing) {
      const branchOid = runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).stdout.trim();
      if (!existing.managed || existing.name !== name || existing.branch !== branch
        || existing.head !== branchOid || existing.stale || existing.ownershipError) {
        throw new ProvisioningSafetyError(`${repo.alias}/${name}: existing worktree conflicts with provisioning state; run "oms doctor"`);
      }
    } else {
      if (inventory.worktrees.length > 0 || existsSync(target)) {
        throw new ProvisioningSafetyError(`${repo.alias}/${name}: checkout topology conflicts with provisioning state; run "oms doctor"`);
      }
      mkdirSync(dirname(target), { recursive: true });
      mkdirSync(target);
      const createdDirectory = lstatSync(target);
      const added = runGit(common, ["worktree", "add", "--relative-paths", target, branch], true);
      if (!added.success) {
        const afterFailure = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId).worktrees
          .find((entry) => entry.path === target);
        const branchOid = runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).stdout.trim();
        if (afterFailure?.managed && afterFailure.name === name && afterFailure.branch === branch
          && afterFailure.head === branchOid && !afterFailure.stale && !afterFailure.ownershipError) {
          current = { ...current, phase: "worktree-created", branch, name };
          writeProvisioning(workspaceRoot, current);
        } else {
          if (existsSync(target)) {
            const currentDirectory = lstatSync(target);
            if (currentDirectory.dev === createdDirectory.dev && currentDirectory.ino === createdDirectory.ino
              && currentDirectory.isDirectory() && readdirSync(target).length === 0) {
              rmdirSync(target);
            }
          }
          throw new Error(`${repo.alias}/${name}: worktree creation failed; local branch ${branch} and any partial checkout were preserved`);
        }
      } else {
        current = { ...current, phase: "worktree-created", branch, name };
        writeProvisioning(workspaceRoot, current);
      }
    }
  }
  if (current.phase === "worktree-created") {
    const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
    const matching = inventory.worktrees.filter((entry) => entry.path === target);
    const branchOid = runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (!branchOid.success || matching.length !== 1 || inventory.worktrees.length !== 1) {
      throw new ProvisioningSafetyError(`${repo.alias}/${name}: recorded worktree is missing or ambiguous; run "oms doctor"`);
    }
    const [entry] = matching;
    if (!entry.managed || entry.name !== name || entry.branch !== branch
      || entry.head !== branchOid.stdout.trim() || entry.stale || entry.ownershipError) {
      throw new ProvisioningSafetyError(`${repo.alias}/${name}: recorded worktree identity conflicts with Git state; run "oms doctor"`);
    }
  }
  writeProvisioning(workspaceRoot, { ...current, phase: "complete", workspaceId, branch, name });
  log.success(`${repo.alias}/${name}: worktree ready on ${branch}`);
}

function validateProvisioningBranch(common: string, repo: Repo, branch: string): BranchSnapshot {
  const local = runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  const remote = runGit(common, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]);
  const upstream = runGit(common, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
  if (!local.success || !remote.success || local.stdout.trim() !== remote.stdout.trim()
    || !upstream.success || upstream.stdout.trim() !== `refs/remotes/origin/${branch}`) {
    throw new ProvisioningSafetyError(
      `${repo.alias}: provisioning branch ${branch} conflicts with origin/${branch}; run "oms doctor"`,
    );
  }
  return { branch, oid: local.stdout.trim() };
}

function validateProvisioningInvariant(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  workspaceId: string,
  state: ProvisioningState,
): BranchSnapshot | null {
  verifyCommonRepository(workspaceRoot, repo.alias, workspaceId);
  if (state.phase === "complete") return null;
  if (state.phase === "common-ready") {
    const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
    if (inventory.worktrees.length > 0) {
      throw new ProvisioningSafetyError(`${repo.alias}: common-ready topology already has a worktree; run "oms doctor"`);
    }
    const branches = runGit(common, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"]);
    if (!branches.success) throw new ProvisioningSafetyError(`${repo.alias}: could not inspect common-ready branches`);
    const names = branches.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
    if (names.length > 1 || (names.length === 1 && repo.branch && names[0] !== repo.branch)) {
      throw new ProvisioningSafetyError(`${repo.alias}: common-ready branch topology is ambiguous; run "oms doctor"`);
    }
    if (names.length === 1) {
      return validateProvisioningBranch(common, repo, names[0]);
    }
    return null;
  }
  const branch = state.branch as string;
  const name = state.name as string;
  const branchOid = runGit(common, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  if (!branchOid.success) {
    throw new ProvisioningSafetyError(`${repo.alias}: ${state.phase} branch ${branch} is missing; run "oms doctor"`);
  }
  const expectedBranch = validateProvisioningBranch(common, repo, branch);
  const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
  if (state.phase === "branch-ready") {
    const target = managedWorktreePath(workspaceRoot, { alias: repo.alias, name });
    if (inventory.worktrees.length === 0) {
      if (existsSync(target)) {
        throw new ProvisioningSafetyError(`${repo.alias}/${name}: checkout path is occupied before provisioning; run "oms doctor"`);
      }
      try {
        assertNoSymlinkComponents(workspaceRoot, target);
      } catch (error) {
        throw new ProvisioningSafetyError(error instanceof Error ? error.message : String(error));
      }
      return expectedBranch;
    }
  }
  const target = managedWorktreePath(workspaceRoot, { alias: repo.alias, name });
  const matching = inventory.worktrees.filter((entry) => entry.path === target);
  if (matching.length !== 1 || inventory.worktrees.length !== 1) {
    throw new ProvisioningSafetyError(`${repo.alias}: ${state.phase} worktree topology is missing or ambiguous; run "oms doctor"`);
  }
  const [entry] = matching;
  if (!entry.managed || entry.name !== name || entry.branch !== branch
    || entry.head !== branchOid.stdout.trim() || entry.stale || entry.ownershipError) {
    throw new ProvisioningSafetyError(`${repo.alias}: ${state.phase} worktree identity conflicts with Git state; run "oms doctor"`);
  }
  return expectedBranch;
}

function pruneSafeManagedStaleRegistrations(
  workspaceRoot: string,
  common: string,
  repo: Repo,
  workspaceId: string,
): void {
  const inventory = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId);
  for (const stale of inventory.worktrees.filter((entry) => entry.managed && entry.stale)) {
    if (stale.repairCandidates.length > 0) {
      throw new ProvisioningSafetyError(
        `${repo.alias}: stale worktree ${stale.path} may have been moved manually to ${stale.repairCandidates.join(", ")}; run "git worktree repair" or "oms doctor" before syncing`,
      );
    }
    if (stale.locked) {
      throw new ProvisioningSafetyError(
        `${repo.alias}: stale managed worktree ${stale.path} is locked; unlock or repair it before syncing`,
      );
    }
    if (!stale.safeToPrune) continue;

    const current = inspectWorktreeInventory(workspaceRoot, repo.alias, workspaceId).worktrees
      .find((entry) => entry.path === stale.path);
    if (!current || !current.managed || !current.stale || !current.safeToPrune
      || current.branch !== stale.branch || current.head !== stale.head) {
      throw new ProvisioningSafetyError(
        `${repo.alias}: stale worktree registration changed before pruning; run "oms doctor"`,
      );
    }
    if (!runGit(common, ["worktree", "remove", "--force", current.path]).success) {
      throw new Error(`${repo.alias}: could not prune stale managed worktree registration ${current.path}`);
    }
    log.success(`${repo.alias}: pruned stale managed worktree registration ${current.path}`);
  }
}

function warnMissingConfiguredBaseline(common: string, repo: Repo): void {
  if (!repo.branch) return;
  const baseline = runGit(common, ["rev-parse", "--verify", `refs/remotes/origin/${repo.branch}^{commit}`]);
  if (!baseline.success) {
    log.warn(
      `${repo.alias}: configured baseline origin/${repo.branch} is unavailable; existing worktrees were preserved, but future default branch creation may fail`,
    );
  }
}

async function syncRepo(workspaceRoot: string, repo: Repo, workspaceId: string): Promise<number> {
  let common = commonRepoPath(workspaceRoot, repo.alias);
  try {
    const commonResult = verifyOrInitializeCommon(workspaceRoot, repo, workspaceId);
    common = commonResult.path;
    let state = readProvisioning(workspaceRoot, repo, workspaceId);
    if (!state) {
      if (!commonResult.created) {
        throw new ProvisioningSafetyError(`${repo.alias}: provisioning state is missing beside an existing common repository; run "oms doctor"`);
      }
      state = { version: 1, workspaceId, alias: repo.alias, phase: "common-ready", branch: null, name: null };
      writeProvisioning(workspaceRoot, state);
    }
    const expectedBranch = validateProvisioningInvariant(workspaceRoot, common, repo, workspaceId, state);
    reconcileWorktreeRemotes(workspaceRoot, common, repo);
    const fetchResult = fetchWorktreeRemotes(workspaceRoot, common, repo);
    if (state.phase === "complete") {
      pruneSafeManagedStaleRegistrations(workspaceRoot, common, repo, workspaceId);
      if (fetchResult.succeeded.includes("origin")) warnMissingConfiguredBaseline(common, repo);
      return fetchResult.code;
    }
    if (fetchResult.code !== 0) {
      const additionalOperationalFailure = fetchResult.safetyFailures.length === 0
        && fetchResult.succeeded.includes("origin")
        && fetchResult.operationalFailures.length > 0
        && fetchResult.operationalFailures.every((remote) => remote !== "origin");
      if (additionalOperationalFailure && await acceptDegradedProvisioning(repo, fetchResult)) {
        provisionFirstWorktree(workspaceRoot, common, repo, workspaceId, state, expectedBranch);
        return 0;
      }
      log.info(`${repo.alias}: preserved common repository at ${common} with provisioning phase ${state.phase}. Retry "oms sync ${repo.alias}".`);
      return additionalOperationalFailure ? 1 : fetchResult.code;
    }
    provisionFirstWorktree(workspaceRoot, common, repo, workspaceId, state, expectedBranch);
    return 0;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    let phase = "missing";
    try {
      phase = readProvisioning(workspaceRoot, repo, workspaceId)?.phase ?? "missing";
    } catch {
      phase = "malformed";
    }
    log.info(`${repo.alias}: preserved common repository at ${common} with provisioning phase ${phase}. Retry "oms sync ${repo.alias}" after resolving the diagnostic.`);
    return error instanceof ProvisioningSafetyError ? 1 : 2;
  }
}

export async function runWorktreeSync(workspaceRoot: string, repos: Repo[]): Promise<number> {
  const ownership = readWorkspaceOwnership(workspaceRoot);
  if (!ownership) {
    log.error("Workspace ownership is missing; retry so OMS can bootstrap it under the mutation lock.");
    return 1;
  }
  const results: number[] = [];
  for (const repo of repos) {
    results.push(await syncRepo(workspaceRoot, repo, ownership.workspaceId));
  }
  return results.includes(2) ? 2 : results.includes(1) ? 1 : 0;
}
