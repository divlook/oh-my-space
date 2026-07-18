import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runGit, submodulePath } from "./git.js";
import { isTestMode } from "./env.js";
import { reconcileGitmodules, type AliasMetadataPlan } from "./gitmodules-reconcile.js";
import type { GitResult } from "./types.js";

/**
 * Durable, crash-safe finalization of OMS root changes (topology + reconciled metadata) through an
 * owner-only temporary index, an fsynced intent marker, and an atomically installed replacement real
 * index. Every root-mutating command runs {@link recoveryPreflight} first so an interrupted commit is
 * completed or safely blocked before new mutation.
 */

/** Absolute Git directory of the root repository. */
export function gitDir(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
}

/** OMS finalization state directory (owner-only) inside the Git directory. */
function omsStateDir(repoRoot: string): string {
  const dir = join(gitDir(repoRoot), "oms");
  if (pathExists(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe OMS state directory: ${dir}`);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function markerPath(repoRoot: string): string {
  return join(omsStateDir(repoRoot), "finalize.json");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Git ref used as an atomic, compare-and-swap finalization lock. */
const FINALIZE_LOCK_REF = "refs/oms/finalize-lock";

type FinalizationLock = { oid: string };

function lockOwnerIsAlive(owner: string): boolean {
  const pidText = owner.split(":", 1)[0];
  if (!/^\d+$/.test(pidText)) return true;
  try {
    process.kill(Number(pidText), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireLock(repoRoot: string): FinalizationLock | null {
  const owner = `${process.pid}:${Date.now()}`;
  const ownerOid = hashObject(repoRoot, Buffer.from(owner));
  if (!ownerOid) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = runGit(repoRoot, ["rev-parse", "--verify", FINALIZE_LOCK_REF]);
    if (!current.success) {
      if (runGit(repoRoot, ["update-ref", FINALIZE_LOCK_REF, ownerOid, "0000000000000000000000000000000000000000"]).success) {
        return { oid: ownerOid };
      }
      continue;
    }
    const currentOid = current.stdout.trim();
    const existingOwner = runGit(repoRoot, ["cat-file", "blob", currentOid]);
    if (!existingOwner.success || lockOwnerIsAlive(existingOwner.stdout.trim())) return null;
    if (runGit(repoRoot, ["update-ref", FINALIZE_LOCK_REF, ownerOid, currentOid]).success) return { oid: ownerOid };
  }
  return null;
}

function releaseLock(repoRoot: string, held: FinalizationLock): void {
  runGit(repoRoot, ["update-ref", "-d", FINALIZE_LOCK_REF, held.oid]);
}

function realIndexPath(repoRoot: string): string {
  const r = runGit(repoRoot, ["rev-parse", "--git-path", "index"]);
  const rel = r.stdout.trim();
  return rel.startsWith("/") ? rel : join(repoRoot, rel);
}

/** SHA-256 of a file's bytes, or null when the file is absent. */
export function hashFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Write content owner-only and fsync both the file and its directory. */
function writeFsync(path: string, content: string | Buffer): void {
  const tempPath = `${path}.tmp`;
  try {
    if (pathExists(tempPath)) {
      if (pathIsSymlink(tempPath) || !removeIfPresent(tempPath)) throw new Error(`unsafe temporary state path: ${tempPath}`);
    }
    const fd = openSync(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, typeof content === "string" ? Buffer.from(content) : content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, path);
  } catch (error) {
    removeIfPresent(tempPath);
    throw error;
  }
  try {
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // directory fsync is best-effort on platforms that reject it
  }
}

function removeIfPresent(path: string): boolean {
  try {
    if (pathExists(path)) rmSync(path, { recursive: true, force: true });
    return !pathExists(path);
  } catch {
    return false;
  }
}

function cleanupFinalizationArtifacts(repoRoot: string, marker: FinalizeMarker): boolean {
  if (!removeIfPresent(`${marker.recoveryIndexPath}.staged`)) return false;
  if (!removeIfPresent(marker.recoveryIndexPath)) return false;
  if (!removeIfPresent(marker.tempIndexPath)) return false;
  return removeIfPresent(markerPath(repoRoot));
}

/** The persisted intent marker for an in-flight or completed finalization. */
type FinalizeMarker = {
  state: "prepared" | "committed";
  originalHead: string;
  originalIndexHash: string;
  plannedTree: string;
  parent: string;
  recoveryIndexPath: string;
  recoveryIndexHash: string;
  tempIndexPath: string;
  commitOid: string;
  committedPaths: string[];
};

function readMarker(repoRoot: string): { ok: true; marker: FinalizeMarker } | { ok: false } | null {
  const path = markerPath(repoRoot);
  if (!pathExists(path)) return null;
  if (pathIsSymlink(path)) return { ok: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const stateDir = omsStateDir(repoRoot);
    const validTempPath =
      typeof parsed.tempIndexPath === "string" &&
      dirname(parsed.tempIndexPath) === stateDir &&
      /^index\.tmp\.\d+$/.test(parsed.tempIndexPath.slice(stateDir.length + 1));
    const validCommittedPaths =
      Array.isArray(parsed.committedPaths) &&
      new Set(parsed.committedPaths).size === parsed.committedPaths.length &&
      parsed.committedPaths.every(
        (entry) =>
          entry === ".gitmodules" ||
          entry === "oms.yaml" ||
          (typeof entry === "string" && /^oms\/[^/]+$/.test(entry) && !entry.includes("..")),
      );
    if (
      parsed &&
      (parsed.state === "prepared" || parsed.state === "committed") &&
      typeof parsed.originalHead === "string" && /^[0-9a-f]{40}$/.test(parsed.originalHead) &&
      typeof parsed.originalIndexHash === "string" && /^[0-9a-f]{64}$/.test(parsed.originalIndexHash) &&
      typeof parsed.plannedTree === "string" && /^[0-9a-f]{40}$/.test(parsed.plannedTree) &&
      parsed.parent === parsed.originalHead &&
      parsed.recoveryIndexPath === join(stateDir, "index.recovery") &&
      typeof parsed.recoveryIndexHash === "string" && /^[0-9a-f]{64}$/.test(parsed.recoveryIndexHash) &&
      validTempPath &&
      typeof parsed.commitOid === "string" && /^[0-9a-f]{40}$/.test(parsed.commitOid) &&
      validCommittedPaths
    ) {
      return { ok: true, marker: parsed as FinalizeMarker };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Simulated crash points for recovery tests; only honored under OMS_TEST_MODE. */
function crashHook(point: string): void {
  if (isTestMode() && process.env.OMS_TEST_CRASH_AT === point) {
    process.exit(137);
  }
}

function currentHead(repoRoot: string): string | null {
  const r = runGit(repoRoot, ["rev-parse", "HEAD"]);
  return r.success ? r.stdout.trim() || null : null;
}

/** Synthesize `.gitmodules` from HEAD, applying only the given aliases' managed fields / removals. */
function synthesizeGitmodules(
  repoRoot: string,
  addPlans: AliasMetadataPlan[],
  removeAliases: string[],
): string | null {
  const listed = runGit(repoRoot, ["ls-tree", "HEAD", "--", ".gitmodules"]);
  if (!listed.success) return null;
  const head = listed.stdout.trim().length > 0 ? runGit(repoRoot, ["show", "HEAD:.gitmodules"]) : null;
  if (head && !head.success) return null;
  const seed = head?.stdout ?? "";
  const tmp = join(omsStateDir(repoRoot), `synth-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, seed, { mode: 0o600 });
  try {
    for (const plan of addPlans) {
      if (!runGit(repoRoot, ["config", "--file", tmp, `submodule.${plan.path}.path`, plan.path]).success) return null;
      if (!runGit(repoRoot, ["config", "--file", tmp, `submodule.${plan.path}.url`, plan.url]).success) return null;
      if (plan.branch !== null) {
        if (!runGit(repoRoot, ["config", "--file", tmp, `submodule.${plan.path}.branch`, plan.branch]).success) return null;
      } else if (runGit(repoRoot, ["config", "--file", tmp, "--get", `submodule.${plan.path}.branch`]).success) {
        if (!runGit(repoRoot, ["config", "--file", tmp, "--unset", `submodule.${plan.path}.branch`]).success) return null;
      }
    }
    for (const alias of removeAliases) {
      const removed = runGit(repoRoot, ["config", "--file", tmp, "--remove-section", `submodule.${submodulePath(alias)}`]);
      if (!removed.success && removed.exitCode !== 5) return null;
    }
    return readFileSync(tmp, "utf8");
  } finally {
    removeIfPresent(tmp);
  }
}

/** Hash-object a buffer into the object store and return its OID. */
function hashObject(repoRoot: string, content: Buffer): string | null {
  const proc = runGitWithInput(repoRoot, ["hash-object", "-w", "--stdin"], content);
  const oid = proc.stdout.trim();
  return proc.success && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

/** Run git with buffered stdin (for hash-object --stdin); mirrors runGit's result shape. */
function runGitWithInput(cwd: string, args: string[], input: Buffer): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "buffer",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    exitCode: result.status,
    success: result.status === 0,
    stdout: result.stdout ? result.stdout.toString("utf8") : "",
    stderr: result.stderr ? result.stderr.toString("utf8") : "",
  };
}

function runGitEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): GitResult {
  return runGit(cwd, args, false, env);
}

export type FinalizeInput = {
  repoRoot: string;
  kind: "add" | "remove";
  /** Aliases finalized as pending-add topology (gitlink staged from the submodule worktree HEAD). */
  addAliases: string[];
  /** Aliases finalized as pending-removal topology (gitlink and section removed). */
  removeAliases: string[];
  /** Managed metadata to synthesize into the committed `.gitmodules` for add aliases. */
  metadataPlans: AliasMetadataPlan[];
  message: string;
  /** Exact working-tree oms.yaml bytes to stage, or null to keep HEAD's version. */
  omsYamlBytes: Buffer | null;
};

export type FinalizeResult =
  | { ok: true; commitOid: string }
  | { ok: false; exitCode: number; reason: string; headAdvanced?: boolean };

/**
 * Create one path-limited OMS root commit through an owner-only temp index, then durably install a
 * refreshed real index. On temp-commit failure before HEAD advances the real index is byte-for-byte
 * preserved; on install failure after HEAD advances the recovery index and marker are retained.
 */
export function finalizeRootCommit(input: FinalizeInput): FinalizeResult {
  const { repoRoot } = input;
  const objectFormat = runGit(repoRoot, ["rev-parse", "--show-object-format"]);
  if (!objectFormat.success || objectFormat.stdout.trim() !== "sha1") {
    return { ok: false, exitCode: 2, reason: "OMS root finalization currently requires Git SHA-1 object format" };
  }
  const stateDir = omsStateDir(repoRoot);
  const tempIndex = join(stateDir, `index.tmp.${process.pid}`);
  const recoveryIndex = join(stateDir, "index.recovery");
  const realIndex = realIndexPath(repoRoot);

  const head = currentHead(repoRoot);
  if (!head) return { ok: false, exitCode: 2, reason: "could not resolve root HEAD" };

  // Build the commit tree in an owner-only temp index seeded from HEAD.
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  removeIfPresent(tempIndex);
  if (!runGitEnv(repoRoot, ["read-tree", head], env).success) {
    removeIfPresent(tempIndex);
    return { ok: false, exitCode: 2, reason: "could not seed the temporary index from HEAD" };
  }

  const synthesized = synthesizeGitmodules(repoRoot, input.metadataPlans, input.removeAliases);
  if (synthesized === null) {
    removeIfPresent(tempIndex);
    return { ok: false, exitCode: 2, reason: "could not synthesize .gitmodules" };
  }
  let committedPaths = [".gitmodules", "oms.yaml", ...input.addAliases.map(submodulePath), ...input.removeAliases.map(submodulePath)];

  const fail = (reason: string): FinalizeResult => {
    removeIfPresent(tempIndex);
    return { ok: false, exitCode: 2, reason };
  };

  if (synthesized.trim().length > 0 || input.addAliases.length > 0) {
    const blob = hashObject(repoRoot, Buffer.from(synthesized));
    if (!blob) return fail("could not write synthesized .gitmodules");
    if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},.gitmodules`], env).success) {
      return fail("could not stage synthesized .gitmodules");
    }
  } else {
    if (!runGitEnv(repoRoot, ["update-index", "--force-remove", ".gitmodules"], env).success) {
      return fail("could not remove .gitmodules from the temporary index");
    }
  }

  for (const alias of input.addAliases) {
    const worktreeOid = runGit(repoRoot, ["rev-parse", `HEAD:${submodulePath(alias)}`]).stdout.trim();
    const pinned = runGit(join(repoRoot, submodulePath(alias)), ["rev-parse", "HEAD"]).stdout.trim();
    const oid = /^[0-9a-f]{40}$/.test(pinned) ? pinned : worktreeOid;
    if (!/^[0-9a-f]{40}$/.test(oid)) return fail(`could not resolve gitlink for ${alias}`);
    if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${oid},${submodulePath(alias)}`], env).success) {
      return fail(`could not stage gitlink for ${alias}`);
    }
  }
  for (const alias of input.removeAliases) {
    if (!runGitEnv(repoRoot, ["update-index", "--force-remove", submodulePath(alias)], env).success) {
      return fail(`could not remove gitlink for ${alias} from the temporary index`);
    }
  }

  if (input.omsYamlBytes !== null) {
    const blob = hashObject(repoRoot, input.omsYamlBytes);
    if (!blob) return fail("could not write oms.yaml blob");
    if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},oms.yaml`], env).success) {
      return fail("could not stage oms.yaml");
    }
  }

  const treeResult = runGitEnv(repoRoot, ["write-tree"], env);
  const plannedTree = treeResult.stdout.trim();
  if (!treeResult.success || !/^[0-9a-f]{40}$/.test(plannedTree)) return fail("could not write the commit tree");

  const failCommitForTest = isTestMode() && process.env.OMS_TEST_FAIL_AT === "commit-tree";
  const commitResult = failCommitForTest
    ? { success: false, exitCode: 1, stdout: "" }
    : runGitEnv(repoRoot, ["commit-tree", plannedTree, "-p", head, "-m", input.message], env);
  const commitOid = commitResult.stdout.trim();
  if (!commitResult.success || !/^[0-9a-f]{40}$/.test(commitOid)) return fail("could not create the commit object");
  const changed = runGit(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", head, commitOid]);
  if (!changed.success) return fail("could not resolve the commit's changed paths");
  committedPaths = changed.stdout.split("\n").map((path) => path.trim()).filter(Boolean);

  // The commit object exists but HEAD has not moved; the real index is still byte-for-byte intact.
  const originalIndexHash = hashFile(realIndex);
  if (!originalIndexHash) return fail("could not hash the real index");

  const heldLock = acquireLock(repoRoot);
  if (heldLock === null) return fail("the OMS finalization lock is held by another process; retry");

  const marker: FinalizeMarker = {
    state: "prepared",
    originalHead: head,
    originalIndexHash,
    plannedTree,
    parent: head,
    recoveryIndexPath: recoveryIndex,
    recoveryIndexHash: "0".repeat(64),
    tempIndexPath: tempIndex,
    commitOid,
    committedPaths,
  };
  const failAfterMarker = (reason: string): FinalizeResult => ({
    ok: false,
    exitCode: 2,
    reason: cleanupFinalizationArtifacts(repoRoot, marker)
      ? reason
      : `${reason} and finalization cleanup is pending; retry`,
  });
  try {
    if (hashFile(realIndex) !== originalIndexHash) {
      removeIfPresent(tempIndex);
      removeIfPresent(recoveryIndex);
      removeIfPresent(markerPath(repoRoot));
      return { ok: false, exitCode: 2, reason: "the root index changed concurrently; retry" };
    }
    try {
      writeFsync(markerPath(repoRoot), JSON.stringify(marker));
    } catch {
      removeIfPresent(tempIndex);
      removeIfPresent(markerPath(repoRoot));
      return { ok: false, exitCode: 2, reason: "could not persist the finalization marker" };
    }
    crashHook("after-marker-prepared");

    // Build the replacement real index only while the shared finalization state is locked.
    if (!buildRecoveryIndex(repoRoot, realIndex, recoveryIndex, commitOid, committedPaths)) {
      return failAfterMarker("could not build the replacement index");
    }
    const recoveryIndexHash = hashFile(recoveryIndex);
    if (!recoveryIndexHash) {
      return failAfterMarker("could not hash the replacement index");
    }
    marker.recoveryIndexHash = recoveryIndexHash;
    try {
      writeFsync(markerPath(repoRoot), JSON.stringify(marker));
    } catch {
      return failAfterMarker("could not persist the replacement index hash");
    }

    if (!runGit(repoRoot, ["update-ref", "HEAD", commitOid, head]).success) {
      return failAfterMarker("could not advance HEAD");
    }
    crashHook("after-head-advance");
    marker.state = "committed";
    try {
      writeFsync(markerPath(repoRoot), JSON.stringify(marker));
    } catch {
      return {
        ok: false,
        exitCode: 2,
        reason: "HEAD advanced but the committed recovery marker could not be persisted; recovery will verify the prepared marker",
        headAdvanced: true,
      };
    }
    crashHook("after-marker-committed");
    const failInstallForTest = isTestMode() && process.env.OMS_TEST_FAIL_AT === "install-recovery-index";
    if (failInstallForTest || !installRecoveryIndex(realIndex, recoveryIndex, marker.recoveryIndexHash)) {
      return {
        ok: false,
        exitCode: 2,
        reason: "HEAD advanced but the root index could not be refreshed; recovery will retry on the next command",
        headAdvanced: true,
      };
    }
    crashHook("after-index-install");
    if (!cleanupFinalizationArtifacts(repoRoot, marker)) {
      return {
        ok: false,
        exitCode: 2,
        reason: "the root index was refreshed but finalization cleanup is pending; recovery will retry on the next command",
        headAdvanced: true,
      };
    }
    return { ok: true, commitOid };
  } finally {
    releaseLock(repoRoot, heldLock);
  }
}

/** Build a replacement real index: the current real index with committed paths advanced to newHead. */
function buildRecoveryIndex(
  repoRoot: string,
  realIndex: string,
  recoveryIndex: string,
  newHead: string,
  committedPaths: string[],
): boolean {
  if (pathExists(recoveryIndex)) return false;
  try {
    copyFileSync(realIndex, recoveryIndex);
  } catch {
    return false;
  }
  const env = { ...process.env, GIT_INDEX_FILE: recoveryIndex };
  for (const path of committedPaths) {
    const entry = runGit(repoRoot, ["ls-tree", newHead, "--", path]);
    if (!entry.success) return false;
    const m = entry.stdout.match(/^(\d+) \w+ ([0-9a-f]{40})\t/);
    if (m) {
      if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `${m[1]},${m[2]},${path}`], env).success) return false;
    } else {
      if (!runGitEnv(repoRoot, ["update-index", "--force-remove", path], env).success) return false;
    }
  }
  return true;
}

/** Atomically install the verified recovery index over the real index, retrying the rename once. */
function installRecoveryIndex(realIndex: string, recoveryIndex: string, expectedHash: string): boolean {
  try {
    if (!lstatSync(recoveryIndex).isFile() || lstatSync(recoveryIndex).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  if (hashFile(recoveryIndex) !== expectedHash) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const staged = `${recoveryIndex}.staged`;
      if (pathExists(staged)) {
        if (pathIsSymlink(staged) || !removeIfPresent(staged)) return false;
      }
      copyFileSync(recoveryIndex, staged, fsConstants.COPYFILE_EXCL);
      renameSync(staged, realIndex);
      crashHook("after-index-rename");
      if (!removeIfPresent(recoveryIndex)) return false;
      return true;
    } catch {
      removeIfPresent(`${recoveryIndex}.staged`);
      // retry once
    }
  }
  return false;
}

function markerCommitMatches(repoRoot: string, marker: FinalizeMarker): boolean {
  const parent = runGit(repoRoot, ["rev-parse", `${marker.commitOid}^`]);
  const tree = runGit(repoRoot, ["rev-parse", `${marker.commitOid}^{tree}`]);
  const changed = runGit(repoRoot, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    marker.parent,
    marker.commitOid,
  ]);
  const changedPaths = changed.stdout.split("\n").map((path) => path.trim()).filter(Boolean).sort();
  const recordedPaths = [...marker.committedPaths].sort();
  return (
    parent.success &&
    tree.success &&
    changed.success &&
    parent.stdout.trim() === marker.parent &&
    tree.stdout.trim() === marker.plannedTree &&
    changedPaths.length === recordedPaths.length &&
    changedPaths.every((path, index) => path === recordedPaths[index])
  );
}

function recoveryEntriesMatchCommit(repoRoot: string, marker: FinalizeMarker): boolean {
  const env = { ...process.env, GIT_INDEX_FILE: marker.recoveryIndexPath };
  for (const path of marker.committedPaths) {
    const treeEntry = runGit(repoRoot, ["ls-tree", marker.commitOid, "--", path]);
    const indexEntry = runGitEnv(repoRoot, ["ls-files", "--stage", "--", path], env);
    if (!treeEntry.success || !indexEntry.success) return false;
    const treeMatch = treeEntry.stdout.match(/^(\d+) \w+ ([0-9a-f]{40})\t/);
    const indexMatch = indexEntry.stdout.match(/^(\d+) ([0-9a-f]{40}) 0\t/);
    if (!treeMatch && !indexMatch) continue;
    if (!treeMatch || !indexMatch || treeMatch[1] !== indexMatch[1] || treeMatch[2] !== indexMatch[2]) {
      return false;
    }
  }
  return true;
}

/**
 * Recovery preflight run before any root-mutating command. Cleans an uncommitted prepared attempt,
 * promotes an advanced-HEAD prepared marker to committed only when the recorded parent/tree match,
 * installs a committed recovery index when the locked HEAD and index hash still match, and preserves
 * (blocks on) mismatched state, malformed markers, or owner-namespaced orphan artifacts.
 */
export function recoveryPreflight(repoRoot: string): { ok: true } | { ok: false; reason: string } {
  const objectFormat = runGit(repoRoot, ["rev-parse", "--show-object-format"]);
  if (!objectFormat.success || objectFormat.stdout.trim() !== "sha1") {
    return { ok: false, reason: "OMS root mutation currently requires Git SHA-1 object format" };
  }
  const stateDir = join(gitDir(repoRoot), "oms");
  let stateExists = false;
  try {
    const stat = lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, reason: `unsafe OMS state directory: ${stateDir}` };
    }
    stateExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `the OMS state directory could not be inspected: ${stateDir}` };
    }
  }

  const heldLock = acquireLock(repoRoot);
  if (heldLock === null) return { ok: false, reason: "the OMS finalization lock is held; retry" };
  try {
    if (!stateExists) return { ok: true };
    const marker = readMarker(repoRoot);
    if (marker === null) {
      // No marker: block on any owner-namespaced orphan artifact rather than deleting it.
      const orphans = readdirSync(stateDir).filter(
        (n) => n === "index.recovery" || n === "index.recovery.staged" || n.startsWith("index.tmp."),
      );
      if (orphans.length > 0) {
        return { ok: false, reason: `orphaned OMS finalization artifact(s) in ${stateDir}: ${orphans.join(", ")}. Inspect and remove them, then retry.` };
      }
      return { ok: true };
    }
    if (!marker.ok) {
      return { ok: false, reason: `the OMS finalization marker in ${stateDir} is malformed. Inspect it, then retry.` };
    }

    const m = marker.marker;
    const realIndex = realIndexPath(repoRoot);
    const head = currentHead(repoRoot);

    if (m.state === "prepared") {
      if (head === m.originalHead && hashFile(realIndex) === m.originalIndexHash) {
        // Uncommitted attempt: clean and continue.
        return cleanupFinalizationArtifacts(repoRoot, m)
          ? { ok: true }
          : { ok: false, reason: "the uncommitted finalization artifacts could not be cleaned; retry" };
      }
      if (head && head !== m.originalHead) {
        const parent = runGit(repoRoot, ["rev-parse", `${head}^`]).stdout.trim();
        const tree = runGit(repoRoot, ["rev-parse", `${head}^{tree}`]).stdout.trim();
        if (parent === m.parent && tree === m.plannedTree) {
          m.state = "committed";
          m.commitOid = head;
          try {
            writeFsync(markerPath(repoRoot), JSON.stringify(m));
          } catch {
            return { ok: false, reason: "the committed recovery marker could not be persisted; retry" };
          }
          return installCommitted(repoRoot, m, realIndex, head);
        }
      }
      return { ok: false, reason: `an interrupted OMS finalization was detected but could not be verified (state in ${stateDir}). Inspect it, then retry.` };
    }

    return installCommitted(repoRoot, m, realIndex, head);
  } finally {
    releaseLock(repoRoot, heldLock);
  }
}

function installCommitted(
  repoRoot: string,
  m: FinalizeMarker,
  realIndex: string,
  head: string | null,
): { ok: true } | { ok: false; reason: string } {
  const stateDir = join(gitDir(repoRoot), "oms");
  if (!m.commitOid || head !== m.commitOid || !markerCommitMatches(repoRoot, m)) {
    return {
      ok: false,
      reason: `a committed OMS finalization recovery in ${stateDir} does not match HEAD or its recorded commit; inspect it, then retry.`,
    };
  }

  const currentIndexHash = hashFile(realIndex);
  if (currentIndexHash === m.recoveryIndexHash) {
    if (cleanupFinalizationArtifacts(repoRoot, m)) return { ok: true };
    return { ok: false, reason: "the recovery index is already installed but finalization cleanup failed; retry" };
  }
  if (currentIndexHash !== m.originalIndexHash) {
    return { ok: false, reason: "the root index changed during recovery; inspect state and retry" };
  }
  if (
    pathExists(m.recoveryIndexPath) &&
    hashFile(m.recoveryIndexPath) === m.recoveryIndexHash &&
    recoveryEntriesMatchCommit(repoRoot, m) &&
    installRecoveryIndex(realIndex, m.recoveryIndexPath, m.recoveryIndexHash)
  ) {
    if (cleanupFinalizationArtifacts(repoRoot, m)) return { ok: true };
    return { ok: false, reason: "the recovery index was installed but finalization cleanup failed; retry" };
  }
  return { ok: false, reason: "could not verify and install the recovery index; inspect state and retry" };
}

export { reconcileGitmodules };
export type { AliasMetadataPlan };
