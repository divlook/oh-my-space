import { createHash } from "node:crypto";
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
import { productionGitRunner, runGit, submodulePath, type RawGitRunner } from "./git.js";
import { isTestMode } from "./env.js";
import type { AliasMetadataPlan } from "./gitmodules-reconcile.js";
import { transformManagedGitmodules } from "./managed-gitmodules.js";
import type { GitResult } from "./types.js";

/**
 * Root finalization preserves a durable intent marker and recovery index after HEAD advances.
 * Every root-mutating command runs recoveryPreflight before starting new mutation.
 */

function gitDir(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
}

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

function hashFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

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

/** Group NUL-delimited records by exact path; keep every index stage for each path. */
function collectPathEntries(result: GitResult, requested: ReadonlySet<string>, entries: Map<string, string>): boolean {
  if (!result.success || (result.stdout && !result.stdout.endsWith("\0"))) return false;
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) return false;
    const path = record.slice(tab + 1);
    if (!requested.has(path)) continue;
    const metadata = record.slice(0, tab);
    const previous = entries.get(path);
    entries.set(path, previous === undefined ? metadata : `${previous}\n${metadata}`);
  }
  return true;
}

function readPathEntries(
  repoRoot: string,
  args: string[],
  paths: readonly string[],
  env?: NodeJS.ProcessEnv,
  runner?: RawGitRunner,
): Map<string, string> | null {
  const entries = new Map<string, string>();
  for (let offset = 0; offset < paths.length;) {
    const command = [...args];
    const requested = new Set<string>();
    let bytes = 0;
    while (offset < paths.length) {
      const path = paths[offset];
      // Leave room for inherited environment data under the OS subprocess argument limit.
      const cost = Buffer.byteLength(path) + 16;
      if (bytes > 0 && bytes + cost > 32 * 1024) break;
      bytes += cost;
      offset++;
      command.push(path);
      requested.add(path);
    }
    if (!collectPathEntries(runGit(repoRoot, command, false, env, runner), requested, entries)) return null;
  }
  return entries;
}

function readIndexEntries(repoRoot: string, paths: readonly string[], env?: NodeJS.ProcessEnv, runner?: RawGitRunner): Map<string, string> | null {
  return readPathEntries(repoRoot, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--"], paths, env, runner);
}

type RootTreeEntry = { mode: string; type: string; oid: string };

function readTreeEntries(repoRoot: string, ref: string, paths: readonly string[], runner?: RawGitRunner): Map<string, RootTreeEntry> | null {
  const entries = new Map<string, RootTreeEntry>();
  if (paths.length === 0) return entries;
  const records = readPathEntries(repoRoot, ["--literal-pathspecs", "ls-tree", "-t", "-z", ref, "--"], paths, undefined, runner);
  if (!records) return null;
  for (const [path, metadata] of records) {
    const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40})$/.exec(metadata);
    if (!match) return null;
    entries.set(path, { mode: match[1], type: match[2], oid: match[3] });
  }
  return entries;
}

/** Synthesize `.gitmodules` from HEAD, applying only the given aliases' managed fields / removals. */
function synthesizeGitmodules(
  repoRoot: string,
  gitmodulesOid: string | undefined,
  addPlans: AliasMetadataPlan[],
  removeAliases: string[],
): string | null {
  const metadata = gitmodulesOid === undefined ? null : runGit(repoRoot, ["show", gitmodulesOid]);
  if (metadata && !metadata.success) return null;
  const seed = metadata?.stdout ?? "";
  const tmp = join(omsStateDir(repoRoot), `synth-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, seed, { mode: 0o600 });
  try {
    if (!transformManagedGitmodules(repoRoot, tmp, addPlans, { writePaths: true, removeAliases })) return null;
    return readFileSync(tmp, "utf8");
  } finally {
    removeIfPresent(tmp);
  }
}

export function checkSyncStaging(
  repoRoot: string,
  plans: AliasMetadataPlan[],
  runner: RawGitRunner,
): ReadonlyMap<string, string> | string {
  const paths = [".gitmodules", ...plans.map(({ alias }) => submodulePath(alias))];
  const changed = runGit(repoRoot, ["--literal-pathspecs", "diff", "--cached", "--name-only", "-z", "--no-renames", "--", ...paths], false, undefined, runner);
  if (!changed.success) return "Could not inspect staged root paths. Retry once Git is idle.";
  const staged = new Map<string, string>();
  const changedPaths = changed.stdout.split("\0").filter(Boolean);
  if (changedPaths.length === 0) return staged;
  const index = readIndexEntries(repoRoot, changedPaths, undefined, runner);
  if (!index) return "Could not inspect staged root paths. Retry once Git is idle.";
  const head = readTreeEntries(repoRoot, "HEAD", changedPaths, runner);
  for (const path of changedPaths) {
    const entry = index.get(path);
    let expected: string | undefined;
    if (path === ".gitmodules") {
      const text = head && synthesizeGitmodules(repoRoot, head.get(path)?.oid, plans, []);
      if (text === null) return "Could not validate the planned .gitmodules content. No registration changes were made.";
      const blob = runner(repoRoot, ["hash-object", "--stdin"], Buffer.from(text));
      if (blob.success) expected = `100644 ${blob.stdout.trim()} 0`;
    } else {
      // Existing gitlink pointer updates belong to record, not sync.
      const headEntry = head?.get(path);
      if (headEntry?.mode === "160000" && headEntry.type === "commit" && entry?.startsWith("160000 ")) continue;
      const source = runGit(join(repoRoot, path), ["rev-parse", "--verify", "HEAD^{commit}"], false, undefined, runner);
      if (head !== null && !headEntry && source.success) expected = `160000 ${source.stdout.trim()} 0`;
    }
    if (entry === undefined || entry !== expected) return `Staged ${path} does not match the planned sync commit. Commit or unstage it before syncing, or run sync with --no-commit.`;
    staged.set(path, entry);
  }
  return staged;
}

function hashObject(repoRoot: string, content: Buffer, runner: RawGitRunner = productionGitRunner): string | null {
  const proc = runner(repoRoot, ["hash-object", "-w", "--stdin"], content);
  const oid = proc.stdout.trim();
  return proc.success && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

function runGitEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): GitResult {
  return runGit(cwd, args, false, env);
}

type FinalizeInput = {
  repoRoot: string;
  /** Aliases finalized as pending-add topology (gitlink staged from the submodule worktree HEAD). */
  addAliases: string[];
  /** Aliases finalized as pending-removal topology (gitlink and section removed). */
  removeAliases: string[];
  /** Managed metadata to synthesize into the committed `.gitmodules` for add aliases. */
  metadataPlans: AliasMetadataPlan[];
  message: string;
  /** Exact working-tree oms.yaml bytes to stage, or null to keep HEAD's version. */
  omsYamlBytes: Buffer | null;
  /** Existing staged entries that sync is authorized to consume only if the planned commit matches. */
  staged?: ReadonlyMap<string, string>;
  /** Controls only object-format inspection and blob writes, not transaction/recovery execution. */
  objectGitRunner?: RawGitRunner;
};

type FinalizeResult =
  | { ok: true; commitOid: string }
  | { ok: false; exitCode: number; reason: string; headAdvanced?: boolean };

/**
 * Create one path-limited OMS root commit through an owner-only temp index, then durably install a
 * refreshed real index. On temp-commit failure before HEAD advances the real index is byte-for-byte
 * preserved; on install failure after HEAD advances the recovery index and marker are retained.
 */
export function finalizeRootCommit(input: FinalizeInput): FinalizeResult {
  const { repoRoot } = input;
  const objectGitRunner = input.objectGitRunner ?? productionGitRunner;
  const objectFormat = runGit(repoRoot, ["rev-parse", "--show-object-format"], false, undefined, objectGitRunner);
  if (!objectFormat.success || objectFormat.stdout.trim() !== "sha1") {
    return { ok: false, exitCode: 2, reason: "OMS root finalization currently requires Git SHA-1 object format" };
  }
  const stateDir = omsStateDir(repoRoot);
  const tempIndex = join(stateDir, `index.tmp.${process.pid}`);
  const recoveryIndex = join(stateDir, "index.recovery");
  const realIndex = realIndexPath(repoRoot);

  const head = currentHead(repoRoot);
  if (!head) return { ok: false, exitCode: 2, reason: "could not resolve root HEAD" };
  const originalIndexHash = hashFile(realIndex);
  if (!originalIndexHash) return { ok: false, exitCode: 2, reason: "could not hash the real index" };

  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  removeIfPresent(tempIndex);
  if (!runGitEnv(repoRoot, ["read-tree", head], env).success) {
    removeIfPresent(tempIndex);
    return { ok: false, exitCode: 2, reason: "could not seed the temporary index from HEAD" };
  }

  const addPaths = input.addAliases.map(submodulePath);
  const headEntries = readTreeEntries(repoRoot, head, [".gitmodules", ...addPaths]);
  const synthesized = headEntries && synthesizeGitmodules(repoRoot, headEntries.get(".gitmodules")?.oid, input.metadataPlans, input.removeAliases);
  if (headEntries === null || synthesized === null) {
    removeIfPresent(tempIndex);
    return { ok: false, exitCode: 2, reason: "could not synthesize .gitmodules" };
  }

  const fail = (reason: string): FinalizeResult => {
    removeIfPresent(tempIndex);
    return { ok: false, exitCode: 2, reason };
  };

  if (synthesized.trim().length > 0 || input.addAliases.length > 0) {
    const blob = hashObject(repoRoot, Buffer.from(synthesized), objectGitRunner);
    if (!blob) return fail("could not write synthesized .gitmodules");
    if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `100644,${blob},.gitmodules`], env).success) {
      return fail("could not stage synthesized .gitmodules");
    }
  } else {
    if (!runGitEnv(repoRoot, ["update-index", "--force-remove", ".gitmodules"], env).success) {
      return fail("could not remove .gitmodules from the temporary index");
    }
  }

  for (let i = 0; i < addPaths.length; i++) {
    const path = addPaths[i];
    const alias = input.addAliases[i];
    const pinned = runGit(join(repoRoot, path), ["rev-parse", "HEAD"]).stdout.trim();
    const oid = /^[0-9a-f]{40}$/.test(pinned) ? pinned : headEntries.get(path)?.oid ?? "";
    if (!/^[0-9a-f]{40}$/.test(oid)) return fail(`could not resolve gitlink for ${alias}`);
    if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${oid},${path}`], env).success) {
      return fail(`could not stage gitlink for ${alias}`);
    }
  }
  for (const alias of input.removeAliases) {
    if (!runGitEnv(repoRoot, ["update-index", "--force-remove", submodulePath(alias)], env).success) {
      return fail(`could not remove gitlink for ${alias} from the temporary index`);
    }
  }

  if (input.omsYamlBytes !== null) {
    const blob = hashObject(repoRoot, input.omsYamlBytes, objectGitRunner);
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
  const changed = runGit(repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", head, commitOid]);
  if (!changed.success) return fail("could not resolve the commit's changed paths");
  const committedPaths = changed.stdout.split("\0").filter(Boolean);

  if (input.staged?.size) {
    const staged = input.staged;
    const stagedPaths = committedPaths.filter((path) => staged.has(path));
    const plannedIndex = readIndexEntries(repoRoot, stagedPaths, env);
    for (const path of stagedPaths) {
      if (!plannedIndex || plannedIndex.get(path) !== staged.get(path)) {
        return fail(`staged ${path} does not match the validated sync commit`);
      }
    }
  }

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
  const entries = readTreeEntries(repoRoot, newHead, committedPaths);
  if (!entries) return false;
  for (const path of committedPaths) {
    const entry = entries.get(path);
    if (entry) {
      if (!runGitEnv(repoRoot, ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.oid},${path}`], env).success) return false;
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
    "-z",
    "-r",
    marker.parent,
    marker.commitOid,
  ]);
  const changedPaths = changed.stdout.split("\0").filter(Boolean).sort();
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
  const tree = readTreeEntries(repoRoot, marker.commitOid, marker.committedPaths);
  const index = readIndexEntries(repoRoot, marker.committedPaths, env);
  if (!tree || !index) return false;
  return marker.committedPaths.every((path) => {
    const entry = tree.get(path);
    const expected = entry ? `${entry.mode} ${entry.oid} 0` : undefined;
    return index.get(path) === expected;
  });
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

