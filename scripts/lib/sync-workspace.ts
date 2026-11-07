import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { DATA_DIRNAME } from "./constants.js";
import { reconcileGitmodules, type AliasMetadataPlan } from "./gitmodules-reconcile.js";
import { aliasDir, currentBranch, isRegisteredSubmodule, redactSensitiveUrls, remoteBranchExists, resolveOriginHead, runGit as executeGit, productionGitRunner, submoduleInitialized, submodulePath, type RawGitRunner } from "./git.js";
import { gitOperationInProgress } from "./git-operation-state.js";
import { gitlinkState, partialRemovalTopology, pendingRemovalTopology, readAliasDirEntries, unreadablePathReason } from "./workspace-state.js";
import { finalizeTopology } from "./topology-commit.js";
import { attachBranch, ensureRemotes, gitmodulesBranch } from "./submodule-config.js";
import { ensureOmsNotIgnored } from "./workspace-ignore.js";
import { prepareTopologyMutation } from "./topology-preflight.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import type { OperationResult, Repo, SyncCommitOptions } from "./types.js";

export async function syncWorkspace(repoRoot: string, picked: Repo[], options: SyncCommitOptions, runner: RawGitRunner = productionGitRunner): Promise<number> {
  const runGit: typeof executeGit = (cwd, args, inherit = false, env, override = runner) => executeGit(cwd, args, inherit, env, override);
  const runSub = (root: string, alias: string, args: string[], inherit = false) => runGit(aliasDir(root, alias), args, inherit);
  function cleanupFailedAdd(repoRoot: string, alias: string): void {
    const path = submodulePath(alias);
    runGit(repoRoot, ["submodule", "deinit", "-f", "--", path]);
    runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
    runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
    if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
    try {
      rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
    } catch {}
    try {
      if (existsSync(aliasDir(repoRoot, alias))) rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
    } catch {}
  }

  function headGitmodulesSection(repoRoot: string, alias: string): string | null {
    const path = submodulePath(alias);
    const r = runGit(repoRoot, ["show", "HEAD:.gitmodules"]);
    if (!r.success) return null;
    const lines = r.stdout.split("\n");
    const start = lines.findIndex((line) => line.trim() === `[submodule "${path}"]`);
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[submodule ".+"\]\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return `${lines.slice(start, end).join("\n").replace(/\n*$/, "\n")}`;
  }

  function headFollowingGitmodulesHeaders(repoRoot: string, alias: string): string[] {
    const path = submodulePath(alias);
    const r = runGit(repoRoot, ["show", "HEAD:.gitmodules"]);
    if (!r.success) return [];
    const lines = r.stdout.split("\n");
    const start = lines.findIndex((line) => line.trim() === `[submodule "${path}"]`);
    if (start === -1) return [];
    const headers: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const match = lines[i].trim().match(/^\[submodule "(.+)"\]$/);
      if (match) headers.push(`[submodule "${match[1]}"]`);
    }
    return headers;
  }

  function currentGitmodulesHasSameAliasSection(repoRoot: string, alias: string): boolean {
    const gitmodules = join(repoRoot, ".gitmodules");
    if (!existsSync(gitmodules)) return false;
    return readFileSync(gitmodules, "utf8").split("\n").some((line) => line.trim() === `[submodule "${submodulePath(alias)}"]`);
  }

  function insertGitmodulesSection(repoRoot: string, alias: string, section: string): void {
    const gitmodules = join(repoRoot, ".gitmodules");
    const existing = existsSync(gitmodules) ? readFileSync(gitmodules, "utf8") : "";
    const followingHeaders = headFollowingGitmodulesHeaders(repoRoot, alias);
    const lines = existing.split("\n");
    for (const followingHeader of followingHeaders) {
      const insertAt = lines.findIndex((line) => line.trim() === followingHeader);
      if (insertAt !== -1) {
        lines.splice(insertAt, 0, ...section.replace(/\n$/, "").split("\n"));
        writeFileSync(gitmodules, lines.join("\n"));
        return;
      }
    }
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(gitmodules, `${existing}${separator}${section}`);
  }

  type RestorableCleanup = "ok" | "occupied" | "unreadable" | "unremovable";

  function cleanupRestorableAliasDir(repoRoot: string, alias: string): RestorableCleanup {
    if (submoduleInitialized(repoRoot, alias)) return "ok";
    const dirState = readAliasDirEntries(repoRoot, alias);
    if (!dirState.exists) return "ok";
    if (dirState.kind === "unreadable") return "unreadable";
    if (dirState.kind === "file") return "occupied";
    const entries = dirState.entries;
    if (entries.length > 0 && entries.some((entry) => entry !== ".DS_Store")) return "occupied";
    try {
      rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
    } catch {
      // The directory was readable and empty, so a removal failure is a delete-time access/IO problem,
      // not occupancy; report it distinctly so the message does not falsely claim non-submodule content.
      return "unremovable";
    }
    return "ok";
  }

  type SyncAttachment = { ok: false } | { ok: true; branch: string | null };

  function attachSyncBaseline(repoRoot: string, alias: string, branch: string | null | undefined): SyncAttachment {
    if (!branch) return { ok: true, branch: null };
    const result = attachBranch(repoRoot, alias, branch, runner);
    if (result.kind === "failed") {
      if (result.diagnostic) log.error(result.diagnostic);
      log.error(`${alias}: could not attach detached HEAD to "${result.branch}". Repository state was preserved.`);
      return { ok: false };
    }
    if (result.kind === "diverged") {
      // Only the checkout and the gitlink are provably untouched here; whether the detached commit is
      // the recorded pointer depends on the caller's situation, which this wrapper cannot see.
      log.warn(
        `${alias}: kept detached HEAD at ${result.headOid.slice(0, 7)} because baseline "${result.branch}" points at ${result.branchOid.slice(0, 7)}. The checked-out commit and the root gitlink were left unchanged. To move deliberately, run "oms branch switch ${alias} ${result.branch}", then run "oms pull ${alias}" to advance from its remote.`,
      );
      return { ok: true, branch: null };
    }
    return { ok: true, branch: result.branch };
  }

  function restorePendingRemoval(repo: Repo, repoRoot: string): { result: OperationResult; restored: boolean } {
    const alias = repo.alias;
    const path = submodulePath(alias);
    const state = gitlinkState(repoRoot, alias);
    const shouldRestore = state.headOid !== null && (pendingRemovalTopology(state) || partialRemovalTopology(state));
    if (!shouldRestore) return { result: "failed", restored: false };

    const unsafe = (detail: string): { result: OperationResult; restored: boolean } => {
      log.error(`${alias}: cannot restore pending removal safely (${detail}). Resolve or commit the pending removal before syncing.`);
      return { result: "failed", restored: true };
    };

    if (state.conflict) return unsafe("root gitlink is conflicted");
    const rootOp = gitOperationInProgress(repoRoot);
    if (rootOp) return unsafe(`root repository has a ${rootOp} in progress`);
    if (currentGitmodulesHasSameAliasSection(repoRoot, alias) && !state.gitmodulesEntry) {
      return unsafe("current .gitmodules has an incomplete same-alias section");
    }
    const section = headGitmodulesSection(repoRoot, alias);
    if (!section) return unsafe(".gitmodules metadata is not recoverable from HEAD");
    const cleanup = cleanupRestorableAliasDir(repoRoot, alias);
    if (cleanup === "unreadable") return unsafe(`${path} could not be read (permission or I/O error)`);
    if (cleanup === "unremovable") return unsafe(`${path} could not be removed (permission or I/O error)`);
    if (cleanup === "occupied") return unsafe(`${path} is occupied by a non-submodule path`);

    runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--", ".gitmodules"]);
    if (!state.gitmodulesEntry) insertGitmodulesSection(repoRoot, alias, section);
    // Managed metadata (url/branch) is reconciled from oms.yaml through the unified sync finalization,
    // not inline here, so a restore's metadata edits follow the same commit-or-unstage decision.

    const restorePath = runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path], true);
    if (!restorePath.success) return unsafe(`failed to restore ${path} from HEAD`);
    runGit(repoRoot, ["submodule", "sync", "--", path]);

    log.step(`${alias}: git submodule update --init ${path}`);
    const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", path]);
    if (!upd.success) {
      const diagnostic = redactSensitiveUrls(upd.stderr.trim());
      if (diagnostic) log.error(diagnostic);
      log.error(`${alias}: git submodule update --init failed (exit ${upd.exitCode})`);
      return { result: "failed", restored: true };
    }
    ensureRemotes(repoRoot, alias, repo.remotes, runner);
    const branch = gitmodulesBranch(repoRoot, alias, runner) ?? repo.branch;
    if (!attachSyncBaseline(repoRoot, alias, branch).ok) return { result: "failed", restored: true };
    log.success(`${alias}: restored pending removal`);
    return { result: "added", restored: true };
  }

  function syncRepo(repo: Repo, repoRoot: string): OperationResult {
    const alias = repo.alias;
    const path = submodulePath(alias);
    const registered = isRegisteredSubmodule(repoRoot, path);
    const state = gitlinkState(repoRoot, alias);

    if (!registered && state.headOid !== null) {
      const restore = restorePendingRemoval(repo, repoRoot);
      if (restore.restored) return restore.result;
    }

    if (!registered) {
      const dirState = readAliasDirEntries(repoRoot, alias);
      if (dirState.exists && dirState.kind === "unreadable") {
        log.error(`${alias}: ${unreadablePathReason(alias)}`);
        return "failed";
      }
      if (dirState.exists && (dirState.kind === "file" || dirState.entries.length > 0)) {
        log.error(
          `${alias}: ${path}/ already exists but is not a registered submodule. Move or remove it manually, then retry.`,
        );
        return "failed";
      }

      if (repo.branch) {
        const lsRemote = runGit(repoRoot, [
          "ls-remote",
          "--exit-code",
          "--heads",
          repo.remotes.origin,
          repo.branch,
        ]);
        if (lsRemote.exitCode === 2) {
          log.error(
            `${alias}: branch "${repo.branch}" not found on origin. Push the branch upstream or fix the alias, then retry.`,
          );
          return "failed";
        }
        if (!lsRemote.success && lsRemote.exitCode !== 2) {
          log.warn(`${alias}: branch existence check failed (exit ${lsRemote.exitCode}); proceeding.`);
        }
      }

      // `git submodule add` refuses when .gitmodules is tracked in HEAD but missing from the
      // working tree — the state left by an uncommitted unsync. Restore an empty one so it can append.
      const gitmodules = join(repoRoot, ".gitmodules");
      if (!existsSync(gitmodules) && runGit(repoRoot, ["cat-file", "-e", "HEAD:.gitmodules"]).success) {
        writeFileSync(gitmodules, "");
      }

      log.step(`${alias}: git submodule add${repo.branch ? ` -b ${repo.branch}` : ""} <origin> ${path}`);
      const args = ["submodule", "add", ...(repo.branch ? ["-b", repo.branch] : []), "--", repo.remotes.origin, path];
      const add = runGit(repoRoot, args, true);
      if (!add.success) {
        log.error(`${alias}: git submodule add failed (exit ${add.exitCode})`);
        cleanupFailedAdd(repoRoot, alias);
        return "failed";
      }
      ensureRemotes(repoRoot, alias, repo.remotes, runner);
      const branch = repo.branch ?? currentBranch(aliasDir(repoRoot, alias));
      const attachment = attachSyncBaseline(repoRoot, alias, branch);
      if (!attachment.ok) return "failed";
      log.success(`${alias}: added${attachment.branch ? ` (branch=${attachment.branch})` : ""}`);
      return "added";
    }

    if (!submoduleInitialized(repoRoot, alias)) {
      log.step(`${alias}: git submodule update --init ${path}`);
      const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", path]);
      if (!upd.success) {
        const diagnostic = redactSensitiveUrls(upd.stderr.trim());
        if (diagnostic) log.error(diagnostic);
        log.error(`${alias}: git submodule update --init failed (exit ${upd.exitCode})`);
        return "failed";
      }
      ensureRemotes(repoRoot, alias, repo.remotes, runner);
      const branch = gitmodulesBranch(repoRoot, alias, runner) ?? repo.branch;
      const attachment = attachSyncBaseline(repoRoot, alias, branch);
      if (!attachment.ok) return "failed";
      log.success(`${alias}: initialized${attachment.branch ? ` (branch=${attachment.branch})` : ""}`);
      return "added";
    }

    // The manifest's origin URL is authoritative for both the fetch URL and the reconciled .gitmodules.
    ensureRemotes(repoRoot, alias, repo.remotes, runner);
    log.step(`${alias}: git fetch origin --prune`);
    const fetch = runSub(repoRoot, alias, ["fetch", "origin", "--prune"], true);
    if (!fetch.success) {
      log.error(`${alias}: fetch failed (exit ${fetch.exitCode})`);
      return "failed";
    }
    const dir = aliasDir(repoRoot, alias);
    let originHead: string | null = null;
    if (repo.branch) {
      if (!remoteBranchExists(dir, repo.branch)) {
        log.error(`${alias}: baseline branch "${repo.branch}" not found on origin after fetch. Push it or fix the alias, then retry.`);
        return "failed";
      }
    } else {
      if (!runSub(repoRoot, alias, ["remote", "set-head", "origin", "-a"]).success) {
        log.error(`${alias}: origin/HEAD could not be refreshed. Declare "branch" in oms.yaml or repair origin HEAD, then retry.`);
        return "failed";
      }
      originHead = resolveOriginHead(dir);
      if (originHead === null) {
        log.error(`${alias}: origin/HEAD could not be resolved. Declare "branch" in oms.yaml or repair origin HEAD, then retry.`);
        return "failed";
      }
    }
    const branch = repo.branch ?? originHead;
    if (!attachSyncBaseline(repoRoot, alias, branch).ok) return "failed";
    log.success(`${alias}: updated`);
    return "updated";
  }

  const manifest = prepareTopologyMutation(repoRoot, "syncing", runner);
  if (!manifest.ok) return manifest.code;
  const omsYamlBytes = manifest.bytes;
  ensureOmsNotIgnored(repoRoot);

  const outcomes = new Map(picked.map((repo) => [repo.alias, syncRepo(repo, repoRoot)]));
  const results = [...outcomes.values()];
  const metadataPlans: AliasMetadataPlan[] = picked
    .filter((repo) => outcomes.get(repo.alias) !== "failed")
    .map((repo) => ({
      alias: repo.alias,
      url: repo.remotes.origin,
      branch: repo.branch ?? null,
    }));
  // Reconcile OMS-managed .gitmodules metadata for successful aliases from the manifest, atomically and
  // against the post-topology snapshot. Only drifted fields are rewritten; a failure leaves the
  // completed topology as an unstaged, resumable working-tree result rather than committing.
  const gitmodulesPath = join(repoRoot, ".gitmodules");
  const snapshot = existsSync(gitmodulesPath) ? readFileSync(gitmodulesPath, "utf8") : "";
  const reconcile = reconcileGitmodules(repoRoot, metadataPlans, snapshot);
  let metadataAliases: string[] = [];
  if (!reconcile.ok) {
    log.error(
      `.gitmodules metadata reconciliation failed: ${reconcile.reason}.${reconcile.chmodCommand ? ` Run: ${reconcile.chmodCommand}` : ""}`,
    );
    if (results.length > 1 || options.all) printSummary(results);
    return 2;
  }
  metadataAliases = [...reconcile.changedFields.keys()];
  for (const [alias, fields] of reconcile.changedFields) {
    log.info(`${alias}: reconciled .gitmodules ${fields.join(", ")} from oms.yaml`);
  }

  const topoExit = await finalizeTopology({ repoRoot, requested: picked.map((r) => r.alias), kind: "add", commit: options.commit, allSucceeded: !results.includes("failed"), metadataPlans, omsYamlBytes, metadataAliases });
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results) || topoExit;
}
