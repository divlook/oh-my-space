import { cancel, log } from "@clack/prompts";
import {
  aliasDir,
  currentBranch,
  listLocalBranches,
  localBranchExists,
  localBranchOid,
  remoteBranchExists,
  runSub,
  shortOid,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { submoduleOperationInProgress } from "./git-operation-state.js";
import { checkDeleteSourceSafety as checkSubmodulePreconditions } from "./source-safety.js";
import { resolveBaselines, type ProtectedReason } from "./branch-baseline.js";
import { canPrompt, guardedConfirm, guardedSelect, isCancel } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import { prepareAlias } from "./alias-preparation.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import { shellQuote as shq } from "./shell.js";

type BranchDeleteOptions = { force?: boolean };

type AliasResult = { kind: "repo"; repo: Repo } | { kind: "error"; code: number };

const PREPARE = { command: "branch delete", topologyOffer: false } as const;

async function resolveDeleteAlias(repos: Repo[], repoRoot: string, aliasArg: string | undefined): Promise<AliasResult> {
  if (aliasArg) {
    const repo = repos.find((r) => r.alias === aliasArg);
    if (!repo) {
      log.error(`Unknown alias "${aliasArg}". Use "oms sync --list" to see registered aliases.`);
      return { kind: "error", code: 1 };
    }
    const prep = await prepareAlias(repoRoot, repo, PREPARE);
    if (!prep.ok) return { kind: "error", code: prep.code };
    return { kind: "repo", repo };
  }

  const initialized = repos.filter((r) => submoduleInitialized(repoRoot, r.alias));
  if (initialized.length === 0) {
    log.error(`No initialized submodules to delete a branch from. Run "oms sync" first.`);
    return { kind: "error", code: 1 };
  }
  if (!canPrompt()) {
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

type BranchProtection = { reason: string; current: boolean };

function buildProtectedMap(reasons: ProtectedReason[], current: string | null): Map<string, BranchProtection> {
  const grouped = new Map<string, string[]>();
  for (const { branch, reason } of reasons) {
    const list = grouped.get(branch) ?? [];
    if (!list.includes(reason)) list.push(reason);
    grouped.set(branch, list);
  }
  return new Map([...grouped.entries()].map(([branch, list]) => [branch, { reason: list.join(", "), current: branch === current }]));
}

type TargetResult = { kind: "branch"; branch: string } | { kind: "error"; code: number } | { kind: "noop" };

async function resolveTargetBranch(
  repo: Repo,
  dir: string,
  branchArg: string | undefined,
  localBranches: string[],
  protectedMap: Map<string, BranchProtection>,
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
    const protection = protectedMap.get(branchArg);
    if (protection) {
      const hint = protection.current ? " Switch to another branch first." : "";
      log.error(`${repo.alias}: "${branchArg}" is protected (${protection.reason}) and cannot be deleted.${hint}`);
      return { kind: "error", code: 1 };
    }
    return { kind: "branch", branch: branchArg };
  }

  const deletable = localBranches.filter((b) => !protectedMap.has(b));
  if (deletable.length === 0) {
    const summary = [...protectedMap.entries()].map(([branch, protection]) => `${branch} (${protection.reason})`).join(", ");
    log.info(`${repo.alias}: no deletable local branches. Protected: ${summary || "none"}.`);
    return { kind: "noop" };
  }
  if (!canPrompt()) {
    log.error(`No branch given and stdin is not a TTY. Pass a branch: "oms branch delete ${repo.alias} <branch>".`);
    return { kind: "error", code: 1 };
  }
  const choice = await guardedSelect<string>({
    message: `${repo.alias}: select a local branch to delete`,
    options: localBranches.map((b) => {
      const protection = protectedMap.get(b);
      return protection ? { value: b, label: b, hint: protection.reason, disabled: true } : { value: b, label: b };
    }),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return { kind: "error", code: 1 };
  }
  const picked = choice as string;
  if (protectedMap.has(picked)) {
    log.error(`${repo.alias}: "${picked}" is protected (${protectedMap.get(picked)!.reason}) and cannot be deleted.`);
    return { kind: "error", code: 1 };
  }
  return { kind: "branch", branch: picked };
}

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

function printForceRecovery(alias: string, branch: string, fullOid: string): void {
  log.warn(`${alias}: force-deleting "${branch}" at ${fullOid}; unmerged local commits may be lost.`);
  log.info(`Recreate it with: git -C ${shq(submodulePath(alias))} branch ${shq(branch)} ${fullOid}`);
}

function forceDeleteBranch(repoRoot: string, repo: Repo, branch: string, fullOid: string, priorShort: string): number {
  const safety = revalidateSafety(repoRoot, repo, branch, fullOid, true);
  if (!safety.ok) {
    log.error(safety.reason);
    return 2;
  }
  const alias = repo.alias;
  printForceRecovery(alias, branch, fullOid);
  const result = runSub(repoRoot, alias, ["branch", "-D", "--", branch], true);
  if (!result.success) {
    log.error(`${alias}: git branch -D "${branch}" failed (exit ${result.exitCode}).`);
    return 2;
  }
  log.success(`${alias}: force-deleted local branch ${branch} (was ${priorShort}).`);
  return 0;
}

async function deleteBranch(repoRoot: string, repo: Repo, dir: string, branch: string, force: boolean): Promise<number> {
  const alias = repo.alias;
  const fullOid = localBranchOid(dir, branch);
  if (fullOid === null) {
    log.error(`${alias}: local branch "${branch}" not found.`);
    return 1;
  }
  const priorShort = shortOid(dir, fullOid);

  if (force) return forceDeleteBranch(repoRoot, repo, branch, fullOid, priorShort);

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

  if (!localBranchExists(dir, branch)) {
    log.success(`${alias}: local branch "${branch}" no longer exists (deleted concurrently).`);
    return 0;
  }

  if (!canPrompt()) {
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

  return forceDeleteBranch(repoRoot, repo, branch, fullOid, priorShort);
}

export async function runBranchDelete(
  aliasArg: string | undefined,
  branchArg: string | undefined,
  options: BranchDeleteOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;

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
  const protectedMap = buildProtectedMap(protectedReasons, cur);

  const localBranches = [...listLocalBranches(dir)].sort();
  const target = await resolveTargetBranch(repo, dir, branchArg, localBranches, protectedMap);
  if (target.kind === "error") return target.code;
  if (target.kind === "noop") return 0;

  return deleteBranch(repoRoot, repo, dir, target.branch, options.force ?? false);
}
