import { cancel, log } from "@clack/prompts";
import { aliasDir } from "./git.js";
import { executeSourceBranchClean, planSourceBranchClean, type SourceBranchCleanPlan } from "./branch-clean-plan.js";
import { canPrompt, guardedConfirm, isCancel } from "./prompt-adapter.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import { shellQuote as shq } from "./shell.js";
import { requireSource, selectSource } from "./source-preparation.js";
import { loadForSources } from "./source-workspace.js";

export async function runSourceBranchClean(aliasArg: string | undefined, options: { base?: string }): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repos, repoRoot } = loaded;
  const selected = await selectSource(workspace, repos, aliasArg, "branch clean", "destructive");
  if (!selected || selected === "noop") return 1;
  const { repo } = selected;
  const checkout = requireSource(workspace, repo);
  if (!checkout) return 1;
  let plan: SourceBranchCleanPlan;
  try { plan = planSourceBranchClean(workspace, repo, checkout, options.base); }
  catch (error) { log.error(error instanceof Error ? error.message : String(error)); return 1; }
  const { alias } = plan;
  const candidates = plan.branches.filter((branch) => !branch.reasons.length);
  if (!candidates.length) {
    log.info(`${plan.alias}: no eligible merged local branches to clean.`);
    if (plan.limitedHistory) log.warn("Ancestry could not be proven with limited shallow history; deepen or repair history explicitly, then rerun.");
    return 0;
  }
  log.info(`Cleanup ${plan.alias}: comparison base ${plan.base.ref} ${plan.base.oid} (local/cached refs; not refreshed).`);
  log.warn("Do not mutate source branches, worktrees, or configuration through other Git or IDE operations from confirmation waiting through completion. Commit-value transactions do not atomically protect ref type, generation, occupancy, metadata, or configuration; same-name recreation and movement away and back to the same OID are not distinguished.");
  for (const branch of plan.branches) log.info(`${branch.reasons.length ? "Excluded" : "Candidate"}: ${branch.name} ${branch.oid}${branch.reasons.length ? ` — ${branch.reasons.join(", ")}` : ""}`);
  const rerun = `oms branch clean ${shq(alias)}${options.base !== undefined ? ` --base ${shq(options.base)}` : ""}`;
  if (!canPrompt()) { log.error(`No branches deleted. Rerun in an interactive terminal: ${rerun}`); return 1; }
  const confirmed = await guardedConfirm({ message: `Delete these ${candidates.length} merged local branches in ${alias}?`, initialValue: false });
  if (isCancel(confirmed) || !confirmed) { cancel("Cleanup declined or cancelled; no branches deleted."); return 1; }
  const outcomes = executeSourceBranchClean(workspace, repo, plan);
  for (const outcome of outcomes) {
    log.info(`${outcome.kind}: ${outcome.branch.name} ${outcome.branch.oid}${outcome.reason ? ` — ${outcome.reason}` : ""}`);
    if (outcome.kind === "deleted") {
      log.info(`Recreate while the commit remains available: git -C ${shq(aliasDir(repoRoot, alias))} branch -- ${shq(outcome.branch.name)} ${shq(outcome.branch.oid)}`);
      if (outcome.configFailed) log.warn(`Ref deletion completed; configuration cleanup is incomplete. Repair: git -C ${shq(aliasDir(repoRoot, alias))} config --local --remove-section ${shq(`branch.${outcome.branch.name}`)}`);
    }
  }
  const incomplete = outcomes.some((outcome) => !["deleted", "already absent"].includes(outcome.kind) || outcome.configFailed);
  log.info(`Cleanup summary: ${["deleted", "already absent", "preserved", "failed", "not run"].map((kind) => `${kind} ${outcomes.filter((outcome) => outcome.kind === kind).length}`).join(", ")}.`);
  if (incomplete) log.warn(`Completed deletions remain; no rollback or force retry. Resolve the reported issue, then rerun: ${rerun}`);
  return incomplete ? 2 : 0;
}
