import { cancel, log } from "@clack/prompts";
import {
  listLocalBranches,
  localBranchExists,
  localBranchOid,
  remoteBranchExists,
  runSub,
  shortOid,
  sourcePath,
} from "./git.js";
import { canPrompt, guardedConfirm, guardedSelect, isCancel } from "./prompt-adapter.js";
import type { Repo } from "./types.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import { shellQuote as shq } from "./shell.js";
import { captureSourceBranchContext, sourceBaseline } from "./source-branch-context.js";
import { requireSource, selectSource } from "./source-preparation.js";
import { requireAttachedSource } from "./source-safety.js";
import { loadForSources } from "./source-workspace.js";

type BranchDeleteOptions = { force?: boolean };

type BranchProtection = { reason: string; current: boolean };

function buildProtectedMap(reasons: { branch: string; reason: string }[], current: string): Map<string, BranchProtection> {
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

function printForceRecovery(alias: string, branch: string, fullOid: string): void {
  log.warn(`${alias}: force-deleting "${branch}" at ${fullOid}; unmerged local commits may be lost.`);
  log.info(`Recreate it with: git -C ${shq(sourcePath(alias))} branch -- ${shq(branch)} ${fullOid}`);
}

type RevalidateDeletion = (branch: string, oid: string, force: boolean) => { ok: true } | { ok: false; reason: string };

function forceDeleteBranch(repoRoot: string, repo: Repo, branch: string, fullOid: string, priorShort: string, revalidate: RevalidateDeletion): number {
  const safety = revalidate(branch, fullOid, true);
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

async function deleteBranch(repoRoot: string, repo: Repo, dir: string, branch: string, force: boolean, revalidate: RevalidateDeletion): Promise<number> {
  const alias = repo.alias;
  const fullOid = localBranchOid(dir, branch);
  if (fullOid === null) {
    log.error(`${alias}: local branch "${branch}" not found.`);
    return 1;
  }
  const priorShort = shortOid(dir, fullOid);

  if (force) return forceDeleteBranch(repoRoot, repo, branch, fullOid, priorShort, revalidate);

  const safety = revalidate(branch, fullOid, false);
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

  return forceDeleteBranch(repoRoot, repo, branch, fullOid, priorShort, revalidate);
}

export async function runSourceBranchDelete(alias: string | undefined, branchArg: string | undefined, options: BranchDeleteOptions): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repoRoot, repos } = loaded;
  const selected = await selectSource(workspace, repos, alias, "branch delete", "destructive");
  if (!selected || selected === "noop") return 1;
  const { repo } = selected;
  const checkout = requireSource(workspace, repo);
  if (!checkout) return 1;
  const dir = checkout.path;
  const checkAttached = () => requireAttachedSource(dir, repo.alias, "individual-fallback");
  const safety = checkAttached();
  if ("reason" in safety) { log.error(safety.reason); return 1; }
  const baseline = sourceBaseline(dir, repo);
  if (!baseline) {
    log.error(`${repo.alias}: origin/HEAD could not be resolved. Declare "branch" in oms.yaml or repair it with git remote set-head origin -a inside oms/${repo.alias}.`);
    return 1;
  }
  let context;
  try { context = captureSourceBranchContext(workspace, repo.alias, checkout); }
  catch (error) { log.error(error instanceof Error ? error.message : String(error)); return 1; }
  const protectedMap = buildProtectedMap([
    { branch: safety.branch, reason: "current branch" },
    { branch: baseline, reason: repo.branch ? "manifest baseline" : "origin default baseline" },
  ], safety.branch);
  const target = await resolveTargetBranch(repo, dir, branchArg, listLocalBranches(dir).sort(), protectedMap);
  if (target.kind !== "branch") return target.kind === "noop" ? 0 : target.code;

  const revalidate: RevalidateDeletion = (branch, oid, force) => {
    try {
      const current = captureSourceBranchContext(workspace, repo.alias, checkout);
      if (current.declaration !== context.declaration || current.identity !== context.identity) throw new Error("selected declaration or checkout identity changed");
      const state = checkAttached();
      if ("reason" in state) throw new Error(state.reason);
      if (sourceBaseline(dir, repo) !== baseline) throw new Error("the protected baseline changed or cannot be resolved");
      if (branch === state.branch || branch === baseline) throw new Error(`"${branch}" became protected`);
      if (force && localBranchOid(dir, branch) !== oid) throw new Error(`"${branch}" moved from ${oid}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `${repo.alias}: source safety changed concurrently after selection: ${error instanceof Error ? error.message : String(error)}. Check the source, then retry.` };
    }
  };
  return deleteBranch(repoRoot, repo, dir, target.branch, options.force ?? false, revalidate);
}
