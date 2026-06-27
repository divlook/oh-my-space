import { cancel, isCancel, log, select } from "@clack/prompts";
import { runGit, shortSha, submodulePath } from "./git.js";
import { stagedRootPaths } from "./root-index.js";
import { gitlinkState, partialRemovalTopology, pendingAddTopology, pendingRemovalTopology } from "./status.js";
import type { GitResult } from "./types.js";

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
