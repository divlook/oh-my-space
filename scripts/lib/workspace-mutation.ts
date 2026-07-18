import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MANIFEST_FILENAME } from "./constants.js";
import { inspectGitVersion, inspectWorkspaceGitIdentity, resolveWorkspaceManifest } from "./git.js";
import { validateManifest } from "./manifest.js";
import { reconcileControlFileExcludes, unexpectedWorktreeExcludeRules } from "./workspace-exclude.js";
import { readModeSwitchJournal } from "./mode-switch-journal.js";
import type { WorkspaceManifest } from "./types.js";

const LOCK_FILENAME = ".oms-mutation.lock";
const OWNERSHIP_PATH = join(".oms", "workspace.json");

type MutationLock = {
  version: 1;
  operation: string;
  operationId: string;
  ownerToken: string;
  targetHash: string;
  workspaceId: string | null;
  transitionId: string | null;
  pid: number;
  processStart: string | null;
  startedAt: string;
};

type WorkspaceOwnership = { version: 1; workspaceId: string };

export type MutationLockInspection =
  | { kind: "absent" }
  | { kind: "active"; operation: string; pid: number; startedAt: string }
  | { kind: "stale"; operation: string; pid: number; startedAt: string }
  | { kind: "malformed"; reason: string };

export type CurrentMutationIdentity = {
  operationId: string;
  ownerToken: string;
  workspaceId: string | null;
  transitionId: string | null;
};

function targetHash(workspaceRoot: string): string {
  return createHash("sha256").update(realpathSync(workspaceRoot)).digest("hex");
}

function processStartIdentity(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || null;
}

/** Inspect the workspace mutation lock without changing or recovering it. */
export function inspectWorkspaceMutationLock(workspaceRoot: string): MutationLockInspection {
  const path = join(workspaceRoot, LOCK_FILENAME);
  if (!existsSync(path)) return { kind: "absent" };
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return { kind: "malformed", reason: `${LOCK_FILENAME} is not a regular file` };
    }
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MutationLock>;
    if (value.version !== 1 || typeof value.operation !== "string" || typeof value.pid !== "number"
      || (value.processStart !== null && typeof value.processStart !== "string") || typeof value.startedAt !== "string") {
      return { kind: "malformed", reason: `${LOCK_FILENAME} does not contain a valid owner record` };
    }
    const currentStart = processStartIdentity(value.pid);
    const details = { operation: value.operation, pid: value.pid, startedAt: value.startedAt };
    return currentStart !== null && currentStart === value.processStart
      ? { kind: "active", ...details }
      : { kind: "stale", ...details };
  } catch (error) {
    return {
      kind: "malformed",
      reason: error instanceof Error ? `${LOCK_FILENAME} could not be inspected: ${error.message}` : `${LOCK_FILENAME} could not be inspected`,
    };
  }
}

export function readWorkspaceOwnership(workspaceRoot: string): WorkspaceOwnership | null {
  const path = join(workspaceRoot, OWNERSHIP_PATH);
  if (!existsSync(path)) return null;
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${OWNERSHIP_PATH} must be a regular file`);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceOwnership>;
  if (value.version !== 1 || typeof value.workspaceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.workspaceId)) {
    throw new Error(`${OWNERSHIP_PATH} is malformed; run "oms doctor" before retrying`);
  }
  return value as WorkspaceOwnership;
}

function ensureWorkspaceOwnership(workspaceRoot: string): WorkspaceOwnership {
  const existing = readWorkspaceOwnership(workspaceRoot);
  if (existing) return existing;

  const stateDir = join(workspaceRoot, ".oms");
  if (existsSync(stateDir)) {
    const entry = lstatSync(stateDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(".oms must be a non-symlink directory before workspace ownership can be created");
    }
  } else {
    mkdirSync(stateDir, { mode: 0o700 });
  }

  const ownership: WorkspaceOwnership = { version: 1, workspaceId: randomUUID() };
  const target = join(workspaceRoot, OWNERSHIP_PATH);
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(ownership, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  return ownership;
}

function acquireMutationLock(
  workspaceRoot: string,
  operation: string,
  workspaceId: string | null,
  transitionId: string | null = null,
): MutationLock {
  const path = join(workspaceRoot, LOCK_FILENAME);
  const lock: MutationLock = {
    version: 1,
    operation,
    operationId: randomUUID(),
    ownerToken: randomUUID(),
    targetHash: targetHash(workspaceRoot),
    workspaceId,
    transitionId,
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    startedAt: new Date().toISOString(),
  };
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Another OMS mutation owns ${LOCK_FILENAME}. No state was changed; run "oms doctor" for stale-lock guidance.`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return lock;
}

/** Returns the identity of the lock held by this process. */
export function currentMutationIdentity(workspaceRoot: string): CurrentMutationIdentity {
  const value = JSON.parse(readFileSync(join(workspaceRoot, LOCK_FILENAME), "utf8")) as Partial<MutationLock>;
  if (value.operationId === undefined || value.ownerToken === undefined || value.pid !== process.pid
    || value.processStart !== processStartIdentity(process.pid)) {
    throw new Error(`The current process does not own ${LOCK_FILENAME}`);
  }
  return {
    operationId: value.operationId,
    ownerToken: value.ownerToken,
    workspaceId: value.workspaceId ?? null,
    transitionId: value.transitionId ?? null,
  };
}

/** Compare-and-swap binds the current mode-switch lock to its durable transition. */
export function bindMutationLockToTransition(workspaceRoot: string, transitionId: string): void {
  const path = join(workspaceRoot, LOCK_FILENAME);
  const value = JSON.parse(readFileSync(path, "utf8")) as MutationLock;
  const identity = currentMutationIdentity(workspaceRoot);
  if (value.operation !== "mode switch" || value.ownerToken !== identity.ownerToken
    || value.operationId !== identity.operationId || value.transitionId !== null) {
    throw new Error(`Refusing to bind ${LOCK_FILENAME} because its mode-switch ownership changed`);
  }
  value.transitionId = transitionId;
  const temporary = `${path}.tmp.${process.pid}.${value.ownerToken}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function recoverModeSwitchLock(workspaceRoot: string): string | null {
  const journal = readModeSwitchJournal(workspaceRoot);
  if (!journal) return null;
  const path = join(workspaceRoot, LOCK_FILENAME);
  if (!existsSync(path)) return journal.transitionId;
  const initial = readFileSync(path, "utf8");
  let lock: Partial<MutationLock>;
  try {
    lock = JSON.parse(initial) as Partial<MutationLock>;
  } catch {
    throw new Error(`${LOCK_FILENAME} is malformed; run "oms doctor" before resuming mode switch`);
  }
  if (lock.version !== 1 || lock.operation !== "mode switch" || lock.operationId !== journal.lockOperationId
    || lock.transitionId !== journal.transitionId || lock.workspaceId !== journal.workspaceId
    || lock.targetHash !== targetHash(workspaceRoot) || typeof lock.pid !== "number" || typeof lock.processStart !== "string") {
    throw new Error(`${LOCK_FILENAME} does not match the mode-switch journal; run "oms doctor" before resuming`);
  }
  const currentStart = processStartIdentity(lock.pid);
  if (currentStart !== null && currentStart === lock.processStart) {
    throw new Error(`Mode switch process ${lock.pid} still owns ${LOCK_FILENAME}; wait for it to finish`);
  }
  if (currentStart === null) {
    try {
      process.kill(lock.pid, 0);
      throw new Error(`Mode switch process identity for PID ${lock.pid} is ambiguous; run "oms doctor" before resuming`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  if (readFileSync(path, "utf8") !== initial) {
    throw new Error(`${LOCK_FILENAME} changed during stale-lock recovery; no state was changed`);
  }
  rmSync(path);
  return journal.transitionId;
}

function bindLockToWorkspace(workspaceRoot: string, held: MutationLock, workspaceId: string): void {
  const path = join(workspaceRoot, LOCK_FILENAME);
  const current = JSON.parse(readFileSync(path, "utf8")) as Partial<MutationLock>;
  if (current.ownerToken !== held.ownerToken || current.operationId !== held.operationId || current.workspaceId !== null) {
    throw new Error(`Refusing to bind ${LOCK_FILENAME} because its ownership changed`);
  }
  held.workspaceId = workspaceId;
  const temporary = `${path}.tmp.${process.pid}.${held.ownerToken}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(held, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function releaseMutationLock(workspaceRoot: string, held: MutationLock): void {
  const path = join(workspaceRoot, LOCK_FILENAME);
  if (!existsSync(path)) return;
  const current = JSON.parse(readFileSync(path, "utf8")) as Partial<MutationLock>;
  if (current.ownerToken !== held.ownerToken || current.operationId !== held.operationId) {
    throw new Error(`Refusing to remove ${LOCK_FILENAME} because its ownership changed`);
  }
  rmSync(path);
}

export async function withWorkspaceMutation(
  operation: string,
  action: () => Promise<number>,
  options: {
    workspaceRoot?: string;
    bootstrapIdentity?: boolean;
    allowBootstrapWithoutSubmoduleRoot?: boolean;
    recoverModeSwitch?: boolean;
  } = {},
): Promise<number> {
  const gitVersion = inspectGitVersion();
  if (!gitVersion.ok) throw new Error(gitVersion.reason);

  let workspaceRoot = options.workspaceRoot;
  let manifest: WorkspaceManifest | undefined;
  if (!workspaceRoot) {
    const resolution = resolveWorkspaceManifest();
    // Let the command emit legacy-manifest and command-specific missing-workspace guidance.
    if (resolution.kind === "missing") return action();
    if (resolution.kind === "invalid") throw new Error(`Found ${MANIFEST_FILENAME} at ${resolution.manifestPath}, but ${resolution.reason}.`);
    manifest = validateManifest(parseYaml(readFileSync(resolution.manifestPath, "utf8")));
    workspaceRoot = resolution.repoRoot;
  }

  const existingOwnership = options.bootstrapIdentity === false ? null : readWorkspaceOwnership(workspaceRoot);
  const recoveredTransitionId = options.recoverModeSwitch ? recoverModeSwitchLock(workspaceRoot) : null;
  const held = acquireMutationLock(
    workspaceRoot,
    operation,
    existingOwnership?.workspaceId ?? null,
    recoveredTransitionId,
  );
  try {
    const submoduleIdentity = manifest?.mode === "submodule" ? inspectWorkspaceGitIdentity(workspaceRoot) : null;
    const mayBootstrap = options.allowBootstrapWithoutSubmoduleRoot === true
      || manifest?.mode !== "submodule" || submoduleIdentity?.kind === "match";
    let deferStaleSyncExclude = false;
    if (operation === "sync" && manifest?.mode === "submodule" && existingOwnership) {
      deferStaleSyncExclude = unexpectedWorktreeExcludeRules(workspaceRoot, existingOwnership.workspaceId) !== null;
    }
    if (options.bootstrapIdentity !== false && !existingOwnership && mayBootstrap) {
      const ownership = ensureWorkspaceOwnership(workspaceRoot);
      bindLockToWorkspace(workspaceRoot, held, ownership.workspaceId);
      reconcileControlFileExcludes(workspaceRoot, ownership.workspaceId, manifest);
    } else if (existingOwnership && manifest && mayBootstrap && !deferStaleSyncExclude) {
      reconcileControlFileExcludes(workspaceRoot, existingOwnership.workspaceId, manifest);
    }
    const result = await action();
    const finalOwnership = options.bootstrapIdentity === false ? null : readWorkspaceOwnership(workspaceRoot);
    if (finalOwnership && manifest && mayBootstrap && !deferStaleSyncExclude) {
      const resolution = resolveWorkspaceManifest({ cwd: workspaceRoot });
      const finalManifest = resolution.kind === "found"
        ? validateManifest(parseYaml(readFileSync(resolution.manifestPath, "utf8")))
        : manifest;
      reconcileControlFileExcludes(workspaceRoot, finalOwnership.workspaceId, finalManifest);
    }
    return result;
  } finally {
    releaseMutationLock(workspaceRoot, held);
  }
}
