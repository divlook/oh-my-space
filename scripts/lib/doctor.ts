import { log } from "@clack/prompts";
import {
  DATA_DIRNAME,
  MANIFEST_FILENAME,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
  TREE_DIRNAME,
} from "./constants.js";
import { resolveSourceSelection, undeclaredSourcePaths } from "./former-source.js";
import {
  parseGitVersion,
  isGitVersionSupported,
  runGit,
  type RawGitRunner,
} from "./git.js";
import { loadRepos } from "./manifest.js";
import { inspectSourceCheckout, openSourceWorkspace, type SourceWorkspace } from "./source-checkout.js";
import { reportSkillFindings } from "./skills.js";
import { listIndependentManagedTrees, type ManagedTree } from "./tree-inventory.js";
import { rootExcludeEntryPresent } from "./tree-exclude.js";


function reportGitVersion(git: RawGitRunner): number | null {
  const result = git(process.cwd(), ["--version"]);
  if (!result.success) {
    log.error("git: not found");
    return null;
  }
  log.success(`git: ${result.stdout.trim()}`);

  const parsed = parseGitVersion(result.stdout);
  if (!parsed) {
    log.warn(`git: could not parse version from "${result.stdout.trim()}"; oms expects git >=${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}.`);
    return 1;
  }
  if (!isGitVersionSupported(parsed)) {
    log.warn(`git ${parsed.major}.${parsed.minor} is older than the recommended ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}. Upgrade Git to avoid unsupported command behavior.`);
    return 1;
  }
  return 0;
}

function reportTreeWarnings(treeInventory: ManagedTree[], workspace: SourceWorkspace): number {
  let warnings = 0;
  for (const tree of treeInventory) {
    if (tree.state === "broken") {
      log.warn(
        `${tree.path}: ${tree.error}. Run "git -C oms/${tree.alias} worktree repair ${tree.absolutePath}" to restore it.`,
      );
      warnings++;
    } else if (tree.state === "foreign") {
      log.warn(`${tree.path}: ${tree.error}. Remove it with "oms tree remove ${tree.alias} ${tree.task}".`);
      warnings++;
    }
  }
  if (treeInventory.length > 0 && !rootExcludeEntryPresent(workspace)) {
    log.warn(
      `${TREE_DIRNAME}/ exists but the root's local exclude entry is missing. Run "oms tree add" to re-assert it.`,
    );
    warnings++;
  }

  return warnings;
}

export async function runIndependentDoctor(git?: RawGitRunner): Promise<number> {
  if (!git) {
    // Inspection may cross partial-clone history. Prevent Git from contacting any remote on a cache miss.
    const env = { ...process.env, LANG: "C", LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" };
    git = (cwd, args) => runGit(cwd, args, false, env);
  }
  let warnings = reportGitVersion(git);
  if (warnings === null) return 1;
  const loaded = loadRepos();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;
  log.success(`Workspace manifest directory: ${repoRoot}`);
  log.success(`${MANIFEST_FILENAME}: ${repos.length} repo(s) configured`);
  let workspace: SourceWorkspace;
  try {
    workspace = openSourceWorkspace(repoRoot, git);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    return message.includes("is not a Git workspace") ? 2 : 1;
  }
  log.success(`Workspace root: ${workspace.root}`);
  if (git(workspace.root, ["check-ignore", "--no-index", "--quiet", "--", `${DATA_DIRNAME}/`]).success) {
    log.warn(`Root ignore rules hide all of ${DATA_DIRNAME}/, including agent instruction files. Replace the blanket rule with alias-specific ignores.`);
    warnings++;
  }

  for (const repo of repos) {
    const state = inspectSourceCheckout(workspace, repo);
    if (state.kind === "missing") {
      log.info(`${repo.alias}: not cloned. ${state.reason}`);
      continue;
    }
    if (state.kind !== "ready") {
      log.warn(`${repo.alias}: ${state.reason}`);
      warnings++;
      continue;
    }
    const branch = git(state.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.success && branch.stdout.trim()) {
      log.success(`${repo.alias}: independent checkout OK (branch=${branch.stdout.trim()})`);
    } else {
      if (branch.exitCode === 1) {
        log.warn(`${repo.alias}: detached HEAD. Run "oms branch switch ${repo.alias} <branch>" to get on a branch.`);
      } else {
        log.warn(`${repo.alias}: could not read the current branch.`);
      }
      warnings++;
    }
  }

  try {
    for (const alias of undeclaredSourcePaths(workspace, repos)) {
      const selection = resolveSourceSelection(workspace, repos, alias);
      if (selection.kind === "former") {
        log.info(`${DATA_DIRNAME}/${alias}: verified former source checkout.`);
      } else if (selection.kind === "unidentified") {
        log.warn(`${DATA_DIRNAME}/${alias}: unidentified path: ${selection.reason}`);
        warnings++;
      }
    }
  } catch (error) {
    log.warn(`Could not inspect undeclared source paths: ${error instanceof Error ? error.message : String(error)}`);
    warnings++;
  }

  try {
    warnings += reportTreeWarnings(listIndependentManagedTrees(workspace, { dirtyAliases: [] }), workspace);
  } catch (error) {
    log.warn(`Could not inspect managed trees: ${error instanceof Error ? error.message : String(error)}`);
    warnings++;
  }
  await reportSkillFindings(repoRoot);
  return warnings > 0 ? 2 : 0;
}
