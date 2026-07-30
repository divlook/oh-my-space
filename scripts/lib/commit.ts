import { log } from "@clack/prompts";
import {
  aliasDir,
  currentBranch,
  isDirty,
  runGit,
  runSub,
  shortSha,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { loadForSubmodules } from "./manifest.js";
import { exitFromResults, printSummary } from "./operation-results.js";
import { resolveCommandAlias, resolveRecordAliases } from "./prompts.js";
import { recoveryPreflight } from "./root-tx.js";
import { stagedRootPaths } from "./root-index.js";
import {
  assertRootTopologySafe,
  changeCounts,
  gitOperationInProgress,
  gitlinkState,
  isDirtyCounts,
  printRootFollowup,
  recordVerdict,
} from "./status.js";
import type { CommitOptions, OperationResult, SourcesOptions } from "./types.js";

/**
 * Root commit subject for a pointer record, mirroring topologyCommitMessage: a single alias is named
 * with its short SHA, several aliases drop the names because no subject line can carry every SHA.
 * @param repoRoot - the root repository path
 * @param aliases - the aliases being recorded
 * @returns the commit subject
 */
function recordCommitMessage(repoRoot: string, aliases: string[]): string {
  if (aliases.length === 1) {
    return `chore(oms): update ${aliases[0]} submodule to ${shortSha(aliasDir(repoRoot, aliases[0]))}`;
  }
  return "chore(oms): update submodules";
}

/** Root index paths staged outside the selected alias set (child paths count as unrelated). */
function unrelatedStagedRecordPaths(repoRoot: string, aliases: string[]): string[] {
  const selected = new Set(aliases.map(submodulePath));
  return stagedRootPaths(repoRoot).filter((p) => !selected.has(p));
}

/**
 * Commit only inside the selected submodule. Respects an existing submodule index (staged-first): when
 * something is already staged it commits just that and warns about leftovers; otherwise it stages all
 * changes with `git add -A`. Never stages or commits the root gitlink.
 */
export async function runCommit(alias: string | undefined, options: CommitOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const resolution = await resolveCommandAlias(repos, repoRoot, alias, "commit");
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selected = resolution.alias;
  const dir = aliasDir(repoRoot, selected);

  if (!submoduleInitialized(repoRoot, selected)) {
    log.error(`${selected}: not initialized. Run "oms sync ${selected}" to initialize it first.`);
    return 1;
  }
  // Check for an in-progress operation before detached HEAD, since a rebase detaches HEAD and should
  // report "rebase in progress" rather than a generic detached-HEAD message.
  const op = gitOperationInProgress(dir);
  if (op) {
    log.error(
      `${selected}: a ${op} is in progress inside oms/${selected}. Resolve, continue, or abort it first.`,
    );
    return 1;
  }
  if (currentBranch(dir) === null) {
    log.error(`${selected}: detached HEAD. Run "oms branch switch ${selected} <branch>" before committing.`);
    return 1;
  }

  const messages = options.message ?? [];
  const counts = changeCounts(dir, new Set());
  if (!isDirtyCounts(counts)) {
    log.info(`Nothing to commit for ${selected}.`);
    printRootFollowup(repoRoot, selected);
    return 0;
  }
  if (messages.length === 0) {
    log.error(`${selected}: -m is required to create a submodule commit. Re-run with -m "<message>".`);
    return 1;
  }

  const commitArgs = ["commit", ...messages.flatMap((m) => ["-m", m])];
  if (counts.staged > 0) {
    log.step(`${selected}: git commit (staged changes only)`);
    if (!runSub(repoRoot, selected, commitArgs, true).success) return 2;
    if (counts.unstaged > 0 || counts.untracked > 0) {
      log.warn(
        `${selected}: committed staged changes only; unstaged or untracked changes remain uncommitted.`,
      );
    }
  } else {
    log.step(`${selected}: git add -A && git commit`);
    if (!runSub(repoRoot, selected, ["add", "-A"], true).success) return 2;
    if (!runSub(repoRoot, selected, commitArgs, true).success) return 2;
  }

  log.success(`${selected}: committed ${shortSha(dir)}`);
  printRootFollowup(repoRoot, selected);
  return 0;
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

  // Complete or safely block any interrupted OMS finalization before recording a root pointer.
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

  // Delegate the conflict / in-progress-op portion to the shared preflight. The fixed
  // conflict → inProgressOp order preserves record's original reporting order; occupiedPath does
  // not apply because record neither creates nor occupies oms/<alias>. These are root-wide problems,
  // so they abort the whole invocation rather than skipping the offending alias.
  for (const alias of selectedAliases) {
    const safety = assertRootTopologySafe(repoRoot, alias, ["conflict", "inProgressOp"]);
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

  // A problem only reaches here under a widened selection; it fails that alias without stopping the rest.
  const results: OperationResult[] = [];
  for (const message of problems) {
    log.error(message);
    results.push("failed");
  }

  if (recordable.length === 0) {
    // No pointer moved. Name the alias for a selection the user made, summarize for a widened one.
    if (problems.length === 0) {
      log.info(explicit && benign.length === 1 ? benign[0] : "Nothing to record for any submodule.");
    }
    // Nothing was attempted, so an empty "Summary:" line would be noise.
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
