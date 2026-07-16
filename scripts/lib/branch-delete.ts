import { cancel, log } from "@clack/prompts";
import type { Command } from "commander";
import {
  aliasDir,
  currentBranch,
  listLocalBranches,
  localBranchExists,
  localBranchOid,
  remoteBranchExists,
  runGit,
  runSub,
  shortOid,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { gitlinkState, submoduleOperationInProgress } from "./status.js";
import { resolveBaselines, type ProtectedReason } from "./branch-baseline.js";
import { guardedConfirm, guardedSelect, isCancel, promptQueueActive } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import { runBranchList } from "./branch-list.js";

type BranchDeleteOptions = { force?: boolean };

/** True when prompts may run: a real TTY, or an active guarded test-response queue. */
function interactive(): boolean {
  return Boolean(process.stdin.isTTY) || promptQueueActive();
}

/** Quote a dynamic argument for safe reuse in a POSIX shell command line. */
function shq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Bare `oms branch`: present the branch action selector interactively, or print help and exit 1 in
 * a non-interactive shell (the `oms agent` group pattern).
 */
export async function runBranch(command: Command): Promise<number> {
  if (!interactive()) {
    command.outputHelp();
    return 1;
  }
  const action = await guardedSelect<string>({
    message: "Select a branch action",
    options: [
      { value: "list", label: "list branches in a submodule" },
      { value: "delete", label: "delete a local branch in a submodule" },
    ],
  });
  if (isCancel(action)) {
    cancel("Cancelled.");
    return 1;
  }
  if (action === "list") return runBranchList(undefined);
  if (action === "delete") return runBranchDelete(undefined, undefined, {});
  return 1;
}

type AliasResult = { kind: "repo"; repo: Repo } | { kind: "error"; code: number };

/** Initialize an explicitly named registered-but-uninitialized alias, or classify why it cannot delete. */
function prepareRegisteredAlias(repoRoot: string, repo: Repo): { ok: true } | { ok: false; code: number } {
  const alias = repo.alias;
  if (submoduleInitialized(repoRoot, alias)) return { ok: true };

  const state = gitlinkState(repoRoot, alias);
  const registered = state.headOid !== null && state.gitmodulesEntry;
  if (!registered) {
    log.error(
      `${alias}: not registered as a submodule (no root gitlink or .gitmodules entry). Run "oms sync ${alias}" first.`,
    );
    return { ok: false, code: 1 };
  }

  log.step(`${alias}: git submodule update --init ${submodulePath(alias)}`);
  const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", submodulePath(alias)], true);
  if (!upd.success) {
    log.error(
      `${alias}: git submodule update --init failed (exit ${upd.exitCode}). Resolve it and retry; Git's partial state was preserved.`,
    );
    return { ok: false, code: 2 };
  }
  return { ok: true };
}

/** Resolve the single alias to operate on: explicit (with auto-init), or an interactive picker. */
async function resolveDeleteAlias(repos: Repo[], repoRoot: string, aliasArg: string | undefined): Promise<AliasResult> {
  if (aliasArg) {
    const repo = repos.find((r) => r.alias === aliasArg);
    if (!repo) {
      log.error(`Unknown alias "${aliasArg}". Use "oms sync --list" to see registered aliases.`);
      return { kind: "error", code: 1 };
    }
    const prep = prepareRegisteredAlias(repoRoot, repo);
    if (!prep.ok) return { kind: "error", code: prep.code };
    return { kind: "repo", repo };
  }

  const initialized = repos.filter((r) => submoduleInitialized(repoRoot, r.alias));
  if (initialized.length === 0) {
    log.error(`No initialized submodules to delete a branch from. Run "oms sync" first.`);
    return { kind: "error", code: 1 };
  }
  if (!interactive()) {
    log.error(`No alias given and stdin is not a TTY. Pass an alias: "oms branch delete <alias> <branch>".`);
    return { kind: "error", code: 1 };
  }
  const choice = await guardedSelect<string>({
    message: "Select a submodule to delete a local branch from",
    options: initialized.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return { kind: "error", code: 1 };
  }
  const repo = initialized.find((r) => r.alias === (choice as string));
  return repo ? { kind: "repo", repo } : { kind: "error", code: 1 };
}

/** Reject an in-progress submodule Git operation or an unanchored detached HEAD before any deletion. */
function checkSubmodulePreconditions(repoRoot: string, repo: Repo): { ok: true } | { ok: false; reason: string } {
  const dir = aliasDir(repoRoot, repo.alias);
  const op = submoduleOperationInProgress(dir);
  if (op) {
    return { ok: false, reason: `${repo.alias}: a ${op} is in progress inside oms/${repo.alias}. Resolve, continue, or abort it first.` };
  }
  if (currentBranch(dir) === null) {
    const state = gitlinkState(repoRoot, repo.alias);
    const anchored = state.headOid !== null && state.worktreeOid !== null && state.worktreeOid === state.headOid;
    if (!anchored) {
      return {
        ok: false,
        reason: `${repo.alias}: submodule HEAD is detached and not anchored to the recorded gitlink. Attach it with "oms switch ${repo.alias} <branch>" first.`,
      };
    }
  }
  return { ok: true };
}

/** Collapse per-branch protection reasons; a branch that is both current and baseline shows both. */
function buildProtectedMap(reasons: ProtectedReason[]): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const { branch, reason } of reasons) {
    const list = grouped.get(branch) ?? [];
    if (!list.includes(reason)) list.push(reason);
    grouped.set(branch, list);
  }
  return new Map([...grouped.entries()].map(([branch, list]) => [branch, list.join(", ")]));
}

type TargetResult = { kind: "branch"; branch: string } | { kind: "error"; code: number } | { kind: "noop" };

/** Resolve the target local branch: explicit (validated), or an interactive selector over local branches. */
async function resolveTargetBranch(
  repo: Repo,
  dir: string,
  branchArg: string | undefined,
  localBranches: string[],
  protectedMap: Map<string, string>,
): Promise<TargetResult> {
  if (branchArg) {
    if (!localBranchExists(dir, branchArg)) {
      let message = `${repo.alias}: local branch "${branchArg}" not found.`;
      if (remoteBranchExists(dir, branchArg)) {
        message += ` A remote branch origin/${branchArg} exists, but "oms branch delete" removes local branches only.`;
      }
      log.error(message);
      return { kind: "error", code: 1 };
    }
    const reason = protectedMap.get(branchArg);
    if (reason) {
      const hint = reason.includes("current branch") ? " Switch to another branch first." : "";
      log.error(`${repo.alias}: "${branchArg}" is protected (${reason}) and cannot be deleted.${hint}`);
      return { kind: "error", code: 1 };
    }
    return { kind: "branch", branch: branchArg };
  }

  const deletable = localBranches.filter((b) => !protectedMap.has(b));
  if (deletable.length === 0) {
    const summary = [...protectedMap.entries()].map(([b, r]) => `${b} (${r})`).join(", ");
    log.info(`${repo.alias}: no deletable local branches. Protected: ${summary || "none"}.`);
    return { kind: "noop" };
  }
  if (!interactive()) {
    log.error(`No branch given and stdin is not a TTY. Pass a branch: "oms branch delete ${repo.alias} <branch>".`);
    return { kind: "error", code: 1 };
  }
  const choice = await guardedSelect<string>({
    message: `${repo.alias}: select a local branch to delete`,
    options: localBranches.map((b) => {
      const reason = protectedMap.get(b);
      return reason ? { value: b, label: b, hint: reason, disabled: true } : { value: b, label: b };
    }),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return { kind: "error", code: 1 };
  }
  const picked = choice as string;
  if (protectedMap.has(picked)) {
    log.error(`${repo.alias}: "${picked}" is protected (${protectedMap.get(picked)}) and cannot be deleted.`);
    return { kind: "error", code: 1 };
  }
  return { kind: "branch", branch: picked };
}

/** Re-resolve protected baselines and Git-operation markers (and optionally the OID) just before deletion. */
function revalidateSafety(
  repoRoot: string,
  repo: Repo,
  branch: string,
  expectedOid: string,
  checkOid: boolean,
): { ok: true } | { ok: false; reason: string } {
  const dir = aliasDir(repoRoot, repo.alias);
  const op = submoduleOperationInProgress(dir);
  if (op) {
    return { ok: false, reason: `${repo.alias}: a ${op} started inside oms/${repo.alias} after selection; aborting. Retry once it completes.` };
  }
  const baseline = resolveBaselines(repoRoot, repo);
  if (!baseline.ok) return { ok: false, reason: `${repo.alias}: ${baseline.reason}` };
  const protectedSet = new Set(baseline.protectedReasons.map((p) => p.branch));
  const cur = currentBranch(dir);
  if (cur) protectedSet.add(cur);
  if (protectedSet.has(branch)) {
    return { ok: false, reason: `${repo.alias}: "${branch}" became protected concurrently; aborting.` };
  }
  if (checkOid) {
    const now = localBranchOid(dir, branch);
    if (now !== expectedOid) {
      return { ok: false, reason: `${repo.alias}: "${branch}" changed concurrently (expected ${expectedOid}); aborting, retry.` };
    }
  }
  return { ok: true };
}

/** Print the full OID and a POSIX-shell-safe recreation command before a force deletion. */
function printForceRecovery(alias: string, branch: string, fullOid: string): void {
  log.warn(`${alias}: force-deleting "${branch}" at ${fullOid}; unmerged local commits may be lost.`);
  log.info(`Recreate it with: git -C ${shq(submodulePath(alias))} branch ${shq(branch)} ${fullOid}`);
}

/** Run the safe or forced Git deletion, offering one force retry after a safe-deletion failure. */
async function deleteBranch(repoRoot: string, repo: Repo, dir: string, branch: string, force: boolean): Promise<number> {
  const alias = repo.alias;
  const fullOid = localBranchOid(dir, branch);
  if (fullOid === null) {
    log.error(`${alias}: local branch "${branch}" not found.`);
    return 1;
  }
  const priorShort = shortOid(dir, fullOid);

  // Explicit force: revalidate safety + OID, disclose recovery, then delete directly with -D.
  if (force) {
    const safety = revalidateSafety(repoRoot, repo, branch, fullOid, true);
    if (!safety.ok) {
      log.error(safety.reason);
      return 2;
    }
    printForceRecovery(alias, branch, fullOid);
    const r = runSub(repoRoot, alias, ["branch", "-D", "--", branch], true);
    if (!r.success) {
      log.error(`${alias}: git branch -D "${branch}" failed (exit ${r.exitCode}).`);
      return 2;
    }
    log.success(`${alias}: force-deleted local branch ${branch} (was ${priorShort}).`);
    return 0;
  }

  // Safe delete: revalidate protected baselines + markers (no OID check), then -d.
  const safety = revalidateSafety(repoRoot, repo, branch, fullOid, false);
  if (!safety.ok) {
    log.error(safety.reason);
    return 2;
  }
  const safe = runSub(repoRoot, alias, ["branch", "-d", "--", branch], true);
  if (safe.success) {
    log.success(`${alias}: deleted local branch ${branch} (was ${priorShort}).`);
    return 0;
  }

  // Safe delete failed. A branch that vanished concurrently is the requested end state (success no-op).
  if (!localBranchExists(dir, branch)) {
    log.success(`${alias}: local branch "${branch}" no longer exists (deleted concurrently).`);
    return 0;
  }

  // Offer one force retry (default No); non-interactive prints an exact, shell-safe retry command.
  if (!interactive()) {
    log.error(
      `${alias}: safe deletion failed (see the Git error above). To force-delete (discarding unmerged commits), run: oms branch delete ${shq(alias)} ${shq(branch)} --force`,
    );
    return 2;
  }
  const accepted = await guardedConfirm({
    message: `${alias}: force-delete "${branch}" (${fullOid})? Unmerged local commits may be lost.`,
    initialValue: false,
  });
  if (isCancel(accepted) || accepted !== true) {
    log.info(`${alias}: kept local branch ${branch}.`);
    return 2;
  }

  const safety2 = revalidateSafety(repoRoot, repo, branch, fullOid, true);
  if (!safety2.ok) {
    log.error(safety2.reason);
    return 2;
  }
  printForceRecovery(alias, branch, fullOid);
  const forced = runSub(repoRoot, alias, ["branch", "-D", "--", branch], true);
  if (!forced.success) {
    log.error(`${alias}: git branch -D "${branch}" failed (exit ${forced.exitCode}).`);
    return 2;
  }
  log.success(`${alias}: force-deleted local branch ${branch} (was ${priorShort}).`);
  return 0;
}

/**
 * Delete one LOCAL branch inside one initialized (or auto-initializable registered) submodule. Never
 * touches a remote ref or the root gitlink. Protects the current branch and every resolved baseline.
 */
export async function runBranchDelete(
  aliasArg: string | undefined,
  branchArg: string | undefined,
  options: BranchDeleteOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const resolved = await resolveDeleteAlias(repos, repoRoot, aliasArg);
  if (resolved.kind === "error") return resolved.code;
  const repo = resolved.repo;
  const dir = aliasDir(repoRoot, repo.alias);

  const pre = checkSubmodulePreconditions(repoRoot, repo);
  if (!pre.ok) {
    log.error(pre.reason);
    return 1;
  }

  const baseline = resolveBaselines(repoRoot, repo);
  if (!baseline.ok) {
    log.error(`${repo.alias}: ${baseline.reason}`);
    return 1;
  }
  if (baseline.driftWarning) log.warn(baseline.driftWarning);

  const protectedReasons: ProtectedReason[] = [];
  const cur = currentBranch(dir);
  if (cur) protectedReasons.push({ branch: cur, reason: "current branch" });
  protectedReasons.push(...baseline.protectedReasons);
  const protectedMap = buildProtectedMap(protectedReasons);

  const localBranches = [...listLocalBranches(dir)].sort();
  const target = await resolveTargetBranch(repo, dir, branchArg, localBranches, protectedMap);
  if (target.kind === "error") return target.code;
  if (target.kind === "noop") return 0;

  return deleteBranch(repoRoot, repo, dir, target.branch, options.force ?? false);
}
