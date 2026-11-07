import { cancel, log } from "@clack/prompts";
import { aliasDir, submoduleInitialized } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { prepareAlias } from "./alias-preparation.js";
import { executeBranchClean, planBranchClean, type BranchCleanPlan } from "./branch-clean-plan.js";
import { canPrompt, guardedConfirm, guardedSelect, isCancel } from "./prompt-adapter.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import { shellQuote as shq } from "./shell.js";

export async function runBranchClean(aliasArg: string | undefined, options: { base?: string }): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;
  let alias = aliasArg;
  if (alias === undefined) {
    if (!canPrompt()) { log.error('Pass an alias and rerun interactively: "oms branch clean <alias>".'); return 1; }
    const initialized = repos.filter((repo) => submoduleInitialized(repoRoot, repo.alias));
    if (!initialized.length) { log.error('No initialized declared source repositories. Run "oms sync" first.'); return 1; }
    const selected = await guardedSelect<string>({ message: "Select a source repository to clean merged local branches", options: initialized.map((repo) => ({ value: repo.alias, label: repo.alias })) });
    if (isCancel(selected)) { cancel("Cancelled."); return 1; }
    alias = selected;
  }
  const repo = repos.find((entry) => entry.alias === alias);
  if (!repo) { log.error(`Unknown alias ${JSON.stringify(alias)}. Use "oms sync --list" to see declared aliases.`); return 1; }
  const wasInitialized = submoduleInitialized(repoRoot, repo.alias);
  const preparation = await prepareAlias(repoRoot, repo, { command: "branch clean", topologyOffer: false });
  if (!preparation.ok) return preparation.code;
  const effects = wasInitialized ? undefined : "Preparation initialized the registered source; fetched data, baseline branch creation or attachment, and tracking configuration remain even if cleanup is declined.";
  let plan: BranchCleanPlan;
  try { plan = planBranchClean(repoRoot, repo, options.base); }
  catch (error) { log.error(error instanceof Error ? error.message : String(error)); if (effects) log.info(effects); return 1; }
  const candidates = plan.branches.filter((branch) => !branch.reasons.length);
  if (!candidates.length) {
    log.info(`${plan.alias}: no eligible merged local branches to clean.`);
    if (effects) log.info(effects);
    if (plan.limitedHistory) log.warn("Ancestry could not be proven with limited shallow history; deepen or repair history explicitly, then rerun.");
    return 0;
  }
  log.info(`Cleanup ${plan.alias}: comparison base ${plan.base.ref} ${plan.base.oid} (local/cached refs; not refreshed).`);
  if (effects) log.info(effects);
  log.warn("Do not mutate source branches, worktrees, or configuration through other Git or IDE operations from confirmation waiting through completion. Commit-value transactions do not atomically protect ref type, generation, occupancy, metadata, or configuration; same-name recreation and movement away and back to the same OID are not distinguished.");
  for (const branch of plan.branches) log.info(`${branch.reasons.length ? "Excluded" : "Candidate"}: ${branch.name} ${branch.oid}${branch.reasons.length ? ` — ${branch.reasons.join(", ")}` : ""}`);
  const rerun = `oms branch clean ${shq(repo.alias)}${options.base !== undefined ? ` --base ${shq(options.base)}` : ""}`;
  if (!canPrompt()) { log.error(`No branches deleted. Rerun in an interactive terminal: ${rerun}`); return 1; }
  const confirmed = await guardedConfirm({ message: `Delete these ${candidates.length} merged local branches in ${repo.alias}?`, initialValue: false });
  if (isCancel(confirmed) || !confirmed) { cancel("Cleanup declined or cancelled; no branches deleted."); if (effects) log.info(effects); return 1; }
  const outcomes = executeBranchClean(repoRoot, repo, plan);
  for (const outcome of outcomes) {
    log.info(`${outcome.kind}: ${outcome.branch.name} ${outcome.branch.oid}${outcome.reason ? ` — ${outcome.reason}` : ""}`);
    if (outcome.kind === "deleted") {
      log.info(`Recreate while the commit remains available: git -C ${shq(aliasDir(repoRoot, repo.alias))} branch -- ${shq(outcome.branch.name)} ${shq(outcome.branch.oid)}`);
      if (outcome.configFailed) log.warn(`Ref deletion completed; configuration cleanup is incomplete. Repair: git -C ${shq(aliasDir(repoRoot, repo.alias))} config --local --remove-section ${shq(`branch.${outcome.branch.name}`)}`);
    }
  }
  const incomplete = outcomes.some((outcome) => !["deleted", "already absent"].includes(outcome.kind) || outcome.configFailed);
  log.info(`Cleanup summary: ${["deleted", "already absent", "preserved", "failed", "not run"].map((kind) => `${kind} ${outcomes.filter((outcome) => outcome.kind === kind).length}`).join(", ")}.`);
  if (incomplete) log.warn(`Completed deletions remain; no rollback or force retry. Resolve the reported issue, then rerun: ${rerun}`);
  return incomplete ? 2 : 0;
}
