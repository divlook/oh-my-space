import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { log } from "@clack/prompts";
import { parseDocument } from "yaml";
import { MANIFEST_FILENAME, MIGRATION_JOURNAL_PATH } from "./constants.js";
import { redactSensitiveUrls } from "./git.js";
import { loadRepos } from "./manifest.js";
import { acquireMigrationLock, clearMigrationJournal, loadMigrationRecovery, readMigrationJournal, rootMigrationHead, writeMigrationJournal, type MigrationJournal } from "./migration-journal.js";
import { convertLocalSource } from "./migration-local.js";
import { applyMigrationRoot, planMigrationRoot, verifyMigrationRoot } from "./migration-root.js";
import { planMigration, type MigrationPlan } from "./migration-plan.js";
import { canPrompt, guardedConfirm } from "./prompt-adapter.js";
import { openSourceWorkspace, type SourceWorkspace } from "./source-checkout.js";
import type { Repo } from "./types.js";

function freshPlan(workspace: SourceWorkspace, repoList: Repo[]): { plan: MigrationPlan; journal: MigrationJournal | null } {
  const doc = parseDocument(readFileSync(join(workspace.root, MANIFEST_FILENAME), "utf8"));
  const plan = planMigration(workspace, repoList, doc.has("autoCommitRegistration"));
  if (plan.blockers.length) return { plan, journal: null };
  try {
    const patch = planMigrationRoot(workspace, plan);
    verifyMigrationRoot(workspace, patch, plan.sources, true);
    const journal: MigrationJournal = {
      version: 1, root: workspace.root, gitDir: workspace.gitDir, head: rootMigrationHead(workspace), sources: plan.sources, patch,
    };
    return { plan, journal };
  } catch (error) {
    plan.blockers.push(error instanceof Error ? error.message : String(error));
    return { plan, journal: null };
  }
}

function printMigrationPlan(plan: MigrationPlan): void {
  for (const item of plan.sources) {
    const data = item.gitDir ?? "no local Git data";
    log.info(`${item.repo.alias}: ${item.path}; Git data: ${data}`);
    for (const worktree of item.worktrees) log.info(`  Linked worktree: ${worktree.path}`);
    if (item.recreateFiles) log.warn("  Rebuild working files from the retained index; missing uncommitted files cannot be recovered.");
    if (item.rootGitlink) log.info(`  Remove root gitlink and .gitmodules section; add shared ignore /${item.relative}/.`);
    if (item.localRegistration) log.info(`  Remove root-local submodule section ${item.relative}.`);
  }
  if (plan.removeSetting) log.info(`Remove autoCommitRegistration from ${MANIFEST_FILENAME}.`);
  for (const reason of plan.blockers) log.error(redactSensitiveUrls(reason));
}

export async function runMigrate(aliases: string[], options: { dryRun?: boolean; yes?: boolean }, git?: SourceWorkspace["git"]): Promise<number> {
  if (aliases.length) {
    log.error("oms migrate applies to the entire workspace and does not accept aliases.");
    return 1;
  }
  const loaded = loadRepos({ allowLegacyRegistration: true });
  if (!loaded) return 1;
  let journalStarted = false;
  let journalFile: string | undefined;
  try {
    const workspace = openSourceWorkspace(loaded.repoRoot, git);
    journalFile = join(workspace.gitDir, MIGRATION_JOURNAL_PATH);
    const resume = loadMigrationRecovery(workspace, loaded.repos, () => {
      journalStarted = true;
      log.info(`Interrupted migration found at ${journalFile}.`);
    });
    let journal: MigrationJournal;
    if (resume) {
      printMigrationPlan({ sources: resume.sources, removeSetting: resume.patch.files.some(({ path }) => path === join(workspace.root, MANIFEST_FILENAME)), blockers: [] });
      journal = resume;
    } else {
      const { plan, journal: next } = freshPlan(workspace, loaded.repos);
      printMigrationPlan(plan);
      if (!next) {
        log.error("Migration is blocked; no workspace changes were made.");
        return 2;
      }
      if (!next.sources.length && !next.patch.files.length && !next.patch.links.length) {
        log.info("No legacy OMS sources need migration.");
        return 0;
      }
      journal = next;
    }
    if (options.dryRun) {
      log.info("Preview only; no workspace changes were made.");
      return 0;
    }
    if (!options.yes) {
      if (!canPrompt()) {
        log.error("Run oms migrate --dry-run to review the plan, then pass --yes to approve it without a terminal.");
        return 1;
      }
      const yes = await guardedConfirm({ message: resume ? "Resume the recorded migration?" : "Apply this workspace migration?", initialValue: false });
      if (yes !== true) {
        log.info("Migration was not applied.");
        return 1;
      }
    }
    const release = acquireMigrationLock(workspace);
    try {
      const reread = loadRepos({ cwd: workspace.root, allowLegacyRegistration: true });
      if (!reread || reread.repoRoot !== workspace.root) {
        throw new Error("the workspace manifest changed since preview; run oms migrate --dry-run again");
      }
      if (resume) {
        const recovery = loadMigrationRecovery(workspace, reread.repos, () => { journalStarted = true; });
        if (!isDeepStrictEqual(recovery, resume)) throw new Error("the migration journal changed since preview; run oms migrate --dry-run again");
      } else {
        if (readMigrationJournal(workspace) || !isDeepStrictEqual(freshPlan(workspace, reread.repos).journal, journal)) {
          throw new Error("the workspace changed since preview; run oms migrate --dry-run again");
        }
        writeMigrationJournal(workspace, journal);
        journalStarted = true;
        verifyMigrationRoot(workspace, journal.patch, journal.sources, true);
      }
      for (const source of journal.sources) convertLocalSource(workspace, source);
      applyMigrationRoot(workspace, journal.patch, journal.sources);
      clearMigrationJournal(workspace);
      journalStarted = false;
    } finally {
      release();
    }
    log.success("Migration complete. Review root changes before committing them; OMS did not commit or push.");
    if (journal.patch.links.length) {
      log.info("Until you commit the root conversion, oms status may still report these sources as legacy. Review git diff and git diff --cached, then commit the staged pointer removals together with their .gitmodules registration removals and any related .gitignore or oms.yaml edits.");
    }
    return 0;
  } catch (error) {
    log.error(redactSensitiveUrls(error instanceof Error ? error.message : String(error)));
    if (journalStarted) log.error(`Keep ${journalFile} and the affected Git directories intact. Inspect the reported paths, then rerun oms migrate --dry-run before resuming.`);
    return 2;
  }
}
