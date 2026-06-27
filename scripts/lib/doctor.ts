import { spawnSync } from "node:child_process";
import { log } from "@clack/prompts";
import {
  GITIGNORE_ENTRY,
  MANIFEST_FILENAME,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
} from "./constants.js";
import {
  currentBranch,
  isGitRepo,
  isRegisteredSubmodule,
  parseGitVersion,
  isGitVersionSupported,
  aliasDir,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { abortOnLegacyRenameAt, abortOnLegacyWorktree, emitLegacyRenameHintWalkUp, loadRepos } from "./manifest.js";
import { pinState } from "./status.js";
import { gitignoreIgnoresOms } from "./workspace-ignore.js";

export async function runDoctor(): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  log.success(`Workspace root: ${repoRoot}`);
  log.success(`${MANIFEST_FILENAME}: ${repos.length} repo(s) configured`);

  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git.status !== 0) {
    log.error("git: not found");
    return 1;
  }
  log.success(`git: ${git.stdout.trim()}`);

  let warnings = 0;

  const parsed = parseGitVersion(git.stdout);
  if (!parsed) {
    log.warn(
      `git: could not parse version from "${git.stdout.trim()}"; oms expects git >=${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}.`,
    );
    warnings++;
  } else if (!isGitVersionSupported(parsed)) {
    log.warn(
      `git ${parsed.major}.${parsed.minor} is older than the recommended ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}. oms uses "git switch" and submodule commands which may behave differently on older releases — upgrade git.`,
    );
    warnings++;
  }

  if (!isGitRepo(repoRoot)) {
    log.warn(
      `workspace is not a git repository. oms manages sources as submodules; run "git init" at ${repoRoot}.`,
    );
    warnings++;
  }

  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  if (gitignoreIgnoresOms(repoRoot)) {
    log.warn(`.gitignore excludes ${GITIGNORE_ENTRY}, but submodules must be tracked. Run "oms sync" to remove it.`);
    warnings++;
  }

  for (const repo of repos) {
    if (!isRegisteredSubmodule(repoRoot, submodulePath(repo.alias))) {
      log.info(`${repo.alias}: not synced`);
      continue;
    }
    if (!submoduleInitialized(repoRoot, repo.alias)) {
      log.warn(`${repo.alias}: registered but not initialized. Run "oms sync ${repo.alias}".`);
      warnings++;
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir);
    if (!branch) {
      log.warn(`${repo.alias}: detached HEAD. Run "oms switch ${repo.alias} <branch>" to get on a branch.`);
      warnings++;
    } else {
      log.success(`${repo.alias}: submodule OK (branch=${branch})`);
    }
    if (pinState(repoRoot, repo.alias) === "moved") {
      log.info(`${repo.alias}: working commit differs from the recorded pointer. Commit oms/${repo.alias} to record it.`);
    }
  }

  return warnings > 0 ? 2 : 0;
}
