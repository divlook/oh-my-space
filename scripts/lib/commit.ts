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
import { resolveCommandAlias } from "./prompts.js";
import { recoveryPreflight } from "./root-tx.js";
import { stagedRootPaths } from "./root-index.js";
import {
  assertRootTopologySafe,
  changeCounts,
  gitOperationInProgress,
  gitlinkState,
  isDirtyCounts,
  pendingAddTopology,
  printRootFollowup,
} from "./status.js";
import type { CommitOptions } from "./types.js";

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
export async function runRecord(alias: string | undefined): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  // Complete or safely block any interrupted OMS finalization before recording a root pointer.
  const recovered = recoveryPreflight(repoRoot);
  if (!recovered.ok) {
    log.error(recovered.reason);
    return 2;
  }

  const resolution = await resolveCommandAlias(repos, repoRoot, alias, "record");
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selected = resolution.alias;
  const path = submodulePath(selected);

  const state = gitlinkState(repoRoot, selected);

  // Delegate the conflict / in-progress-op portion to the shared preflight. The fixed
  // conflict → inProgressOp order preserves record's original reporting order; occupiedPath does
  // not apply because record neither creates nor occupies oms/<alias>.
  //
  // Note: assertRootTopologySafe re-invokes gitlinkState internally for its conflict check,
  // duplicating the call above. The extra subprocess cost is accepted to keep the preflight a
  // self-contained, single-source-of-truth safety API rather than threading a pre-computed state
  // (and its staleness/alias-mismatch footgun) through the signature.
  const safety = assertRootTopologySafe(repoRoot, selected, ["conflict", "inProgressOp"]);
  if (!safety.safe) {
    log.error(`${selected}: ${safety.reason}`);
    return 1;
  }
  if (currentBranch(repoRoot) === null) {
    log.error(`Root repository is in detached HEAD. Switch the root repository to a branch before recording.`);
    return 1;
  }

  if (state.headOid === null) {
    const topology = pendingAddTopology(state)
      ? ` Create the initial topology commit with "oms sync ${selected} --commit".`
      : "";
    log.error(
      `${selected}: the root HEAD has no recorded gitlink. "oms record" only updates existing root gitlinks.${topology}`,
    );
    return 1;
  }
  if (!state.pathExists) {
    log.error(`${selected}: pending submodule removal. Record the removal with "oms unsync ${selected} --commit".`);
    return 1;
  }
  if (state.split) {
    log.error(
      `${selected}: the staged oms/${selected} pointer differs from the working tree. Unstage or restage oms/${selected}, then retry.`,
    );
    return 1;
  }

  // Index safety: only the selected gitlink may be staged (NUL-delimited, child paths count as unrelated).
  const unrelated = stagedRootPaths(repoRoot).filter((p) => p !== path);
  if (unrelated.length > 0) {
    log.error(
      `Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before recording.`,
    );
    return 1;
  }

  // Record the current working tree HEAD pointer; no movement is a clean no-op.
  if (state.worktreeOid === null || state.worktreeOid === state.headOid) {
    log.info(`Nothing to record for ${selected}.`);
    return 0;
  }

  if (isDirty(aliasDir(repoRoot, selected))) {
    log.warn(`${selected}: submodule has uncommitted source changes; only the current HEAD pointer will be recorded.`);
  }

  const message = `chore(oms): update ${selected} submodule to ${shortSha(aliasDir(repoRoot, selected))}`;
  if (!runGit(repoRoot, ["add", "--", path]).success) {
    log.error(`${selected}: failed to stage oms/${selected}.`);
    return 2;
  }
  const commit = runGit(repoRoot, ["commit", "-m", message, "--", path], true);
  if (!commit.success) {
    log.error(`${selected}: root commit failed; the staged oms/${selected} pointer was left in place.`);
    return 2;
  }
  log.success(`${selected}: recorded ${shortSha(repoRoot)}  ${message}`);
  return 0;
}
