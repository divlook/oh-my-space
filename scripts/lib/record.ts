import { log } from "@clack/prompts";
import { aliasDir, currentBranch, isDirty, runGit, shortSha, stagedRootPaths, submodulePath } from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { resolveRecordAliases } from "./prompts.js";
import { recoveryPreflight } from "./root-tx.js";
import { assertRootWriteSafe, gitlinkState, recordVerdict } from "./workspace-state.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import type { OperationResult, SourcesOptions } from "./types.js";

function recordCommitMessage(repoRoot: string, aliases: string[]): string {
  if (aliases.length === 1) {
    return `chore(oms): update ${aliases[0]} submodule to ${shortSha(aliasDir(repoRoot, aliases[0]))}`;
  }
  return "chore(oms): update submodules";
}

function unrelatedStagedRecordPaths(repoRoot: string, aliases: string[]): string[] {
  const selected = new Set(aliases.map(submodulePath));
  return stagedRootPaths(repoRoot).filter((p) => !selected.has(p));
}
/**
 * Record an existing root gitlink pointer update for the selected submodule with a path-limited root
 * commit. Strict index safety keeps the commit scoped to exactly oms/<alias>; it never adds or removes
 * a submodule registration (that is sync/unsync topology) and never includes unrelated staged paths.
 */
export async function runRecord(aliases: string[], options: SourcesOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  if (refuseInsideManagedTree(repoRoot)) return 1;

  const recovered = recoveryPreflight(repoRoot);
  if (!recovered.ok) {
    log.error(recovered.reason);
    return 2;
  }

  const resolution = await resolveRecordAliases(repos, repoRoot, aliases, options);
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selectedAliases = resolution.aliases;
  // A selection the user named must fail loudly; one OMS widened for them may skip unrecordable aliases.
  const explicit = resolution.explicit;

  for (const alias of selectedAliases) {
    const safety = assertRootWriteSafe(repoRoot, alias);
    if (!safety.safe) {
      log.error(`${alias}: ${safety.reason}`);
      return 1;
    }
  }
  if (currentBranch(repoRoot) === null) {
    log.error(`Root repository is in detached HEAD. Switch the root repository to a branch before recording.`);
    return 1;
  }

  const verdicts = selectedAliases.map((alias) => ({
    alias,
    verdict: recordVerdict(gitlinkState(repoRoot, alias), alias),
  }));

  // A named alias that cannot be recorded is an error, reported in record's original order — before
  // the index-safety check — so single-alias behavior is unchanged.
  if (explicit) {
    const named = verdicts.find((v) => v.verdict.kind === "problem");
    if (named && named.verdict.kind === "problem") {
      log.error(named.verdict.message);
      return 1;
    }
  }

  // Index safety, judged against everything selected rather than only what will be committed: a
  // staged gitlink for a skipped alias is inside the user's selection, so it must not abort the run.
  const unrelated = unrelatedStagedRecordPaths(repoRoot, selectedAliases);
  if (unrelated.length > 0) {
    log.error(
      `Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before recording.`,
    );
    return 1;
  }

  const recordable = verdicts.filter((v) => v.verdict.kind === "recordable").map((v) => v.alias);
  const problems = verdicts.flatMap((v) => (v.verdict.kind === "problem" ? [v.verdict.message] : []));
  const benign = verdicts.flatMap((v) => (v.verdict.kind === "benign" ? [v.verdict.message] : []));

  const results: OperationResult[] = [];
  for (const message of problems) {
    log.error(message);
    results.push("failed");
  }

  if (recordable.length === 0) {
    if (problems.length === 0) {
      log.info(explicit && benign.length === 1 ? benign[0] : "Nothing to record for any submodule.");
    }
    if (results.length > 1) printSummary(results);
    return exitFromResults(results);
  }

  for (const alias of recordable) {
    if (isDirty(aliasDir(repoRoot, alias))) {
      log.warn(`${alias}: submodule has uncommitted source changes; only the current HEAD pointer will be recorded.`);
    }
  }

  const paths = recordable.map(submodulePath);
  const scope = recordable.length === 1 ? `oms/${recordable[0]}` : paths.join(", ");
  const prefix = recordable.length === 1 ? `${recordable[0]}: ` : "";
  const message = recordCommitMessage(repoRoot, recordable);
  if (!runGit(repoRoot, ["add", "--", ...paths]).success) {
    log.error(`${prefix}failed to stage ${scope}.`);
    return 2;
  }
  const commit = runGit(repoRoot, ["commit", "-m", message, "--", ...paths], true);
  if (!commit.success) {
    log.error(`${prefix}root commit failed; the staged ${scope} pointer was left in place.`);
    return 2;
  }
  log.success(`${prefix}recorded ${shortSha(repoRoot)}  ${message}`);
  results.push(...recordable.map((): OperationResult => "recorded"));

  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}
