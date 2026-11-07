import { log } from "@clack/prompts";
import { aliasDir, runSub, shortSha } from "./git.js";
import { prepareAlias, resolveDetachedHead } from "./alias-preparation.js";
import { loadForSubmodules } from "./manifest.js";
import { resolveCommitAlias } from "./prompts.js";
import { changeCounts, isDirtyCounts } from "./workspace-state.js";
import { gitOperationInProgress } from "./git-operation-state.js";
import { printRootFollowup } from "./status.js";
import { refuseInsideManagedTree } from "./tree-context.js";
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
  if (refuseInsideManagedTree(repoRoot)) return 1;

  const resolution = await resolveCommitAlias(repos, repoRoot, alias);
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selected = resolution.alias;
  const dir = aliasDir(repoRoot, selected);

  // Committing presupposes uncommitted source changes, which a freshly registered alias cannot have,
  // so this path initializes a registered alias but refuses to create topology for an unregistered one.
  const repo = repos.find((r) => r.alias === selected);
  if (!repo) {
    log.error(`Unknown alias "${selected}". Use "oms sync --list" to see registered aliases.`);
    return 1;
  }
  const prepared = await prepareAlias(repoRoot, repo, { command: "commit", topologyOffer: false, requiresSettledTopology: false });
  if (!prepared.ok) return prepared.code;
  // Check for an in-progress operation before detached HEAD, since a rebase detaches HEAD and should
  // report "rebase in progress" rather than a generic detached-HEAD message.
  const op = gitOperationInProgress(dir);
  if (op) {
    log.error(
      `${selected}: a ${op} is in progress inside oms/${selected}. Resolve, continue, or abort it first.`,
    );
    return 1;
  }
  const attached = await resolveDetachedHead(repoRoot, repo, "commit");
  if (!attached.ok) return attached.code;

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

