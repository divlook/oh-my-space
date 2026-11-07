import { log } from "@clack/prompts";
import { runGit, shortSha, stagedRootPaths, submodulePath } from "./git.js";
import { gitlinkState, partialRemovalTopology, pendingAddTopology, pendingRemovalTopology } from "./workspace-state.js";
import { finalizeRootCommit } from "./root-tx.js";
import type { AliasMetadataPlan } from "./gitmodules-reconcile.js";

type TopologyKind = "add" | "remove";

function unstageTopologyPaths(repoRoot: string, aliases: string[]): void {
  runGit(repoRoot, ["reset", "-q", "HEAD", "--", ".gitmodules", ...aliases.map(submodulePath)]);
}

function topologyCommitMessage(kind: TopologyKind, aliases: string[]): string {
  if (kind === "add") {
    return aliases.length === 1 ? `chore(oms): add ${aliases[0]} submodule` : "chore(oms): add submodules";
  }
  return aliases.length === 1 ? `chore(oms): remove ${aliases[0]} submodule` : "chore(oms): remove submodules";
}

function unrelatedStagedTopologyPaths(repoRoot: string, aliases: string[]): string[] {
  const topo = new Set([".gitmodules", ...aliases.map(submodulePath)]);
  return stagedRootPaths(repoRoot).filter((p) => !topo.has(p));
}

type TopologyInput = {
  repoRoot: string;
  requested: string[];
  kind: TopologyKind;
  commit: boolean | undefined;
  allSucceeded: boolean;
  metadataPlans?: AliasMetadataPlan[];
  omsYamlBytes?: Buffer | null;
  metadataAliases?: string[];
};

export async function finalizeTopology(input: TopologyInput): Promise<number> {
  const { repoRoot, requested, kind, commit, allSucceeded, metadataPlans = [], omsYamlBytes = null, metadataAliases = [] } = input;
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
  const metaOnly = metadataAliases.filter((a) => !topoPending.includes(a));
  const pending = [...topoPending, ...metaOnly];
  if (pending.length === 0 && partial.length === 0) return 0;
  const involved = [...pending, ...partial];

  const message =
    topoPending.length > 0
      ? topologyCommitMessage(kind, topoPending)
      : pending.length === 1
        ? `chore(oms): reconcile ${pending[0]} submodule metadata`
        : "chore(oms): reconcile submodule metadata";

  // The topology commit is the default; only an explicit --no-commit declines it. Resolving here
  // rather than at the flag keeps the default identical for piped shells and programmatic callers.
  const createCommit = commit ?? true;

  if (!createCommit) {
    unstageTopologyPaths(repoRoot, involved);
    log.info("Root topology changes left unstaged. Review and commit them, or re-run without --no-commit.");
    return 0;
  }

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
    log.error(`Root commit failed: ${fin.reason}. No changes were committed; re-run "${retry}" to retry.`);
    return fin.exitCode;
  }
  log.success(`Recorded topology commit ${shortSha(repoRoot)}  ${message}`);
  return 0;
}
