import { log } from "@clack/prompts";
import { aliasDir, isDirty, runGit, runSub, shortSha } from "./git.js";
import { refuseInsideManagedTree } from "./tree-context.js";
import type { CommitOptions } from "./types.js";
import { isDirtyCounts, parseChangeCounts, type ChangeCounts } from "./git-status.js";
import { resolveSourceBranch } from "./source-attachment.js";
import { requireSource, selectSource } from "./source-preparation.js";
import { sourceOperationBlocker } from "./source-safety.js";
import { loadForSources } from "./source-workspace.js";

function commitStagedOrAll(repoRoot: string, selected: string, counts: ChangeCounts, messages: string[]): number {
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

  log.success(`${selected}: committed ${shortSha(aliasDir(repoRoot, selected))}`);
  return 0;
}

export async function runSourceCommit(alias: string | undefined, options: CommitOptions): Promise<number> {
  const loaded = loadForSources();
  if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
  const { workspace, repoRoot, repos } = loaded;
  const selected = await selectSource(workspace, repos, alias, "commit", { dirty: isDirty });
  if (!selected) return 1;
  if (selected === "noop") return 0;
  const { repo } = selected;
  const checkout = requireSource(workspace, repo);
  if (!checkout) return 1;
  const operation = sourceOperationBlocker(checkout.path, repo.alias);
  if (operation) { log.error(operation); return 1; }
  const status = runGit(checkout.path, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
  if (!status.success) { log.error(`${repo.alias}: could not inspect source changes; nothing was committed.`); return 2; }
  const counts = parseChangeCounts(status.stdout);
  if (!isDirtyCounts(counts)) { log.info(`Nothing to commit for ${repo.alias}.`); return 0; }
  const messages = options.message ?? [];
  if (!messages.length) { log.error(`${repo.alias}: -m is required to create a source repository commit. Rerun with -m "<message>".`); return 1; }
  const attached = await resolveSourceBranch(workspace, repo, checkout, "commit");
  if (!attached.ok) return attached.code;
  // An informed switch may change which paths are staged or dirty; never use counts from the old checkout state.
  const current = runGit(checkout.path, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
  if (!current.success) { log.error(`${repo.alias}: could not inspect source changes; nothing was committed.`); return 2; }
  const currentCounts = parseChangeCounts(current.stdout);
  if (!isDirtyCounts(currentCounts)) { log.info(`Nothing to commit for ${repo.alias}.`); return 0; }
  return commitStagedOrAll(repoRoot, repo.alias, currentCounts, messages);
}

