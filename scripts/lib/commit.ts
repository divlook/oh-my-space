import { cancel, isCancel, log, select } from "@clack/prompts";
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
import {
  changeCounts,
  gitOperationInProgress,
  gitlinkState,
  isDirtyCounts,
  partialRemovalTopology,
  pendingAddTopology,
  pendingRemovalTopology,
  printRootFollowup,
} from "./status.js";
import type { CommitOptions, GitResult } from "./types.js";

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
    log.error(`${selected}: detached HEAD. Run "oms switch ${selected} <branch>" before committing.`);
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

/** Root index paths staged relative to HEAD, read NUL-delimited so unusual path names stay intact. */
function stagedRootPaths(repoRoot: string): string[] {
  const r = runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (!r.success) return [];
  return r.stdout.split("\0").filter((p) => p.length > 0);
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

  const resolution = await resolveCommandAlias(repos, repoRoot, alias, "record");
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selected = resolution.alias;
  const path = submodulePath(selected);

  const state = gitlinkState(repoRoot, selected);

  // A conflicted gitlink is the specific blocker, so report it ahead of the generic in-progress merge
  // it implies; an in-progress operation that does not conflict this gitlink is reported next.
  if (state.conflict) {
    log.error(`${selected}: the root gitlink is conflicted. Resolve the root repository conflict first.`);
    return 1;
  }
  const rootOp = gitOperationInProgress(repoRoot);
  if (rootOp) {
    log.error(`Root repository has a ${rootOp} in progress. Resolve, continue, or abort it before recording.`);
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

type TopologyKind = "add" | "remove";

/** Unstage only the topology paths (.gitmodules + selected gitlinks), preserving unrelated staged paths. */
function unstageTopologyPaths(repoRoot: string, aliases: string[]): void {
  runGit(repoRoot, ["reset", "-q", "HEAD", "--", ".gitmodules", ...aliases.map(submodulePath)]);
}

function topologyCommitMessage(kind: TopologyKind, aliases: string[]): string {
  if (kind === "add") {
    return aliases.length === 1 ? `chore(oms): add ${aliases[0]} submodule` : "chore(oms): add submodules";
  }
  return aliases.length === 1 ? `chore(oms): remove ${aliases[0]} submodule` : "chore(oms): remove submodules";
}

/** Root index paths staged outside the given topology path set (.gitmodules + selected gitlinks). */
function unrelatedStagedTopologyPaths(repoRoot: string, aliases: string[]): string[] {
  const topo = new Set([".gitmodules", ...aliases.map(submodulePath)]);
  return stagedRootPaths(repoRoot).filter((p) => !topo.has(p));
}

/** Stage the topology paths (adds and removals) and create a path-limited root commit for them. */
function commitTopologyPaths(repoRoot: string, aliases: string[], message: string): GitResult {
  const paths = [".gitmodules", ...aliases.map(submodulePath)];
  runGit(repoRoot, ["add", "-A", "--", ...paths]);
  return runGit(repoRoot, ["commit", "-m", message, "--", ...paths], true);
}

/** Ask whether to create a root topology commit; defaults to Yes. Returns null on cancellation. */
async function confirmTopologyCommit(message: string): Promise<boolean | null> {
  const choice = await select({
    message: "Create a root topology commit?",
    options: [
      { value: "yes", label: `Yes, commit "${message}"` },
      { value: "no", label: "No, leave the topology changes unstaged" },
    ],
    initialValue: "yes",
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice === "yes";
}

/**
 * Decide what happens to root topology changes after a successful sync/unsync: create a path-limited
 * topology commit (explicit `--commit`, or an interactive accept) or leave the changes unstaged by
 * default. A multi-alias commit happens only when every requested alias succeeded; partial removal
 * topology is rejected rather than committed. Returns a non-zero contribution on topology failure.
 */
export async function finalizeTopology(
  repoRoot: string,
  requested: string[],
  kind: TopologyKind,
  commit: boolean,
  allSucceeded: boolean,
): Promise<number> {
  const pending: string[] = [];
  const partial: string[] = [];
  for (const alias of requested) {
    const s = gitlinkState(repoRoot, alias);
    if (kind === "add") {
      if (pendingAddTopology(s)) pending.push(alias);
    } else if (partialRemovalTopology(s)) {
      partial.push(alias);
    } else if (pendingRemovalTopology(s)) {
      pending.push(alias);
    }
  }
  if (pending.length === 0 && partial.length === 0) return 0;
  const involved = [...pending, ...partial];

  // Decide whether a commit is created: explicit --commit, or an interactive accept (default Yes).
  let createCommit = commit;
  let declined = false;
  if (!commit && process.stdin.isTTY && allSucceeded && partial.length === 0) {
    const confirmed = await confirmTopologyCommit(topologyCommitMessage(kind, pending));
    if (confirmed === null) {
      unstageTopologyPaths(repoRoot, involved);
      return 1;
    }
    createCommit = confirmed;
    declined = !confirmed;
  }

  if (!createCommit) {
    unstageTopologyPaths(repoRoot, involved);
    if (!declined) {
      log.info("Root topology changes left unstaged. Review them, or re-run with --commit to record the topology change.");
    }
    return 0;
  }

  // A commit was requested or accepted; reject states that must not be committed.
  if (partial.length > 0) {
    log.error(
      `Partial removal topology for ${partial.join(", ")} must be cleaned up before committing. Complete the removal (or restore the submodule), then retry.`,
    );
    unstageTopologyPaths(repoRoot, involved);
    return 2;
  }
  if (!allSucceeded) {
    unstageTopologyPaths(repoRoot, involved);
    log.info(`Not all aliases succeeded; topology changes for ${pending.join(", ")} were left unstaged for manual review.`);
    return 0;
  }
  const unrelated = unrelatedStagedTopologyPaths(repoRoot, pending);
  if (unrelated.length > 0) {
    log.error(
      `Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before the topology commit.`,
    );
    unstageTopologyPaths(repoRoot, pending);
    return 2;
  }
  const message = topologyCommitMessage(kind, pending);
  if (!commitTopologyPaths(repoRoot, pending, message).success) {
    log.error("Root topology commit failed; staged topology paths were left in place.");
    return 2;
  }
  log.success(`Recorded topology commit ${shortSha(repoRoot)}  ${message}`);
  return 0;
}
