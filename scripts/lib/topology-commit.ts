import { cancel, isCancel, log, select } from "@clack/prompts";
import { runGit, shortSha, submodulePath } from "./git.js";
import { stagedRootPaths } from "./root-index.js";
import { gitlinkState, partialRemovalTopology, pendingAddTopology, pendingRemovalTopology } from "./status.js";
import { finalizeRootCommit } from "./root-tx.js";
import type { AliasMetadataPlan } from "./gitmodules-reconcile.js";

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
  metadataPlans: AliasMetadataPlan[] = [],
  omsYamlBytes: Buffer | null = null,
  metadataAliases: string[] = [],
): Promise<number> {
  const topoPending: string[] = [];
  const partial: string[] = [];
  for (const alias of requested) {
    const s = gitlinkState(repoRoot, alias);
    if (kind === "add") {
      if (pendingAddTopology(s)) topoPending.push(alias);
    } else if (partialRemovalTopology(s)) {
      partial.push(alias);
    } else if (pendingRemovalTopology(s)) {
      topoPending.push(alias);
    }
  }
  // Metadata-only aliases (reconciled .gitmodules but no pending gitlink move) also drive finalization.
  const metaOnly = metadataAliases.filter((a) => !topoPending.includes(a));
  const pending = [...topoPending, ...metaOnly];
  if (pending.length === 0 && partial.length === 0) return 0;
  const involved = [...pending, ...partial];

  // A topology change names the add/remove message; a metadata-only reconciliation uses its own.
  const message =
    topoPending.length > 0
      ? topologyCommitMessage(kind, topoPending)
      : pending.length === 1
        ? `chore(oms): reconcile ${pending[0]} submodule metadata`
        : "chore(oms): reconcile submodule metadata";

  // Decide whether a commit is created: explicit --commit, or an interactive accept (default Yes).
  let createCommit = commit;
  let declined = false;
  if (!commit && process.stdin.isTTY && allSucceeded && partial.length === 0) {
    const confirmed = await confirmTopologyCommit(message);
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
  // On partial failure an unsync (remove) commit is skipped entirely, while a sync (add) commit still
  // finalizes the successful aliases in `pending` through the temporary index (failed aliases already
  // have no pending topology and are excluded), and the caller surfaces the overall non-zero exit.
  if (!allSucceeded && kind === "remove") {
    unstageTopologyPaths(repoRoot, involved);
    log.info(`Not all aliases succeeded; topology changes for ${pending.join(", ")} were left unstaged for manual review.`);
    return 0;
  }
  // A removal (unsync) commit still refuses unrelated staged paths; an add (sync) commit isolates them
  // through the temporary index and preserves them staged, so only remove rejects here.
  if (kind === "remove") {
    const unrelated = unrelatedStagedTopologyPaths(repoRoot, pending);
    if (unrelated.length > 0) {
      log.error(
        `Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before the topology commit.`,
      );
      unstageTopologyPaths(repoRoot, pending);
      return 2;
    }
  }
  // Disclose that the commit consumes the complete working-tree oms.yaml (including any failed-alias or
  // other manifest edits) and its prior staging, so the declarative source and derived metadata commit
  // together. Fires when the manifest is untracked in HEAD or differs from it.
  if (omsYamlBytes !== null) {
    const trackedInHead = runGit(repoRoot, ["cat-file", "-e", "HEAD:oms.yaml"]).success;
    const differs = !trackedInHead || runGit(repoRoot, ["diff", "--quiet", "HEAD", "--", "oms.yaml"]).exitCode !== 0;
    if (differs) {
      log.info("Including the complete working-tree oms.yaml in this commit (consuming any prior staging of it).");
    }
  }

  const pendingSet = new Set(pending);
  const fin = finalizeRootCommit({
    repoRoot,
    kind,
    // Metadata-only aliases contribute only their .gitmodules section; pointer moves remain for record.
    addAliases: kind === "add" ? topoPending : [],
    removeAliases: kind === "remove" ? topoPending : [],
    metadataPlans: metadataPlans.filter((p) => pendingSet.has(p.alias)),
    message,
    omsYamlBytes,
  });
  if (!fin.ok) {
    const retry = kind === "remove" ? "oms unsync <alias> --commit" : "oms sync <alias> --commit";
    if (fin.headAdvanced) {
      log.error(`Root commit ${shortSha(repoRoot)} was created, but finalization failed: ${fin.reason}. Re-run "${retry}" to recover.`);
      return fin.exitCode;
    }
    // The commit failed before HEAD advanced; the real index and working tree are unchanged.
    log.error(`Root commit failed: ${fin.reason}. No changes were committed; re-run "${retry}" to retry.`);
    return fin.exitCode;
  }
  log.success(`Recorded topology commit ${shortSha(repoRoot)}  ${message}`);
  return 0;
}
