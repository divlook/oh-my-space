import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertRelocationInventory, migrationIndexDigest, type LegacySource } from "./migration-plan.js";
import type { SourceWorkspace } from "./source-checkout.js";
import type { GitResult } from "./types.js";

function pathInfo(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function linkPointsTo(file: string, to: string): boolean {
  const info = pathInfo(file);
  if (!info?.isFile()) return false;
  const value = /^gitdir: (.+)\r?\n$/.exec(readFileSync(file, "utf8"));
  return value !== null && resolve(dirname(file), value[1]) === to;
}

function matchesHead(probe: (args: string[]) => GitResult, head: string | null, branch: string | null): boolean {
  const actualHead = probe(["rev-parse", "--verify", "HEAD^{commit}"]);
  const actualBranch = probe(["symbolic-ref", "--quiet", "HEAD"]);
  return actualHead.success && actualHead.stdout.trim() === head &&
    (branch === null ? actualBranch.exitCode === 1 : actualBranch.success && actualBranch.stdout.replace(/\n$/, "") === branch);
}

function inspectRecordedGitData(workspace: SourceWorkspace, source: LegacySource) {
  const { gitDir, gitIdentity, path, worktrees } = source;
  if (!gitDir || !gitIdentity) return null;
  const { git } = workspace;
  const targetGit = join(path, ".git");
  const old = pathInfo(gitDir);
  const target = pathInfo(targetGit);
  const current = old?.isDirectory() ? gitDir : targetGit;
  const identity = current === gitDir ? old : target;
  if (!identity?.isDirectory() || identity.dev !== gitIdentity.device || identity.ino !== gitIdentity.inode || realpathSync(current) !== current ||
      (gitDir !== targetGit && old && target?.isDirectory())) {
    throw new Error(`Git data does not match the planned location ${gitDir} or ${targetGit}; preserve both paths and inspect them`);
  }
  const needsRelocation = gitDir !== targetGit && current === gitDir;
  assertRelocationInventory(current, gitDir, worktrees, gitDir !== targetGit);
  if (migrationIndexDigest(current) !== source.index) throw new Error(`${path}: source index changed since migration was planned`);
  const probe = (dir: string, args: string[]) => git(workspace.root, [`--git-dir=${dir}`, `--work-tree=${workspace.root}`, ...args]);
  if (!matchesHead((args) => probe(current, args), source.sourceHead, source.sourceBranch)) {
    throw new Error(`${path}: source HEAD changed since migration was planned`);
  }
  for (const tree of worktrees) {
    const file = join(tree.path, ".git");
    const admin = join(current, tree.admin);
    if (realpathSync(tree.path) !== tree.path || !pathInfo(file)?.isFile() ||
        (readFileSync(file, "utf8") !== tree.gitFile && (needsRelocation || !linkPointsTo(file, join(targetGit, tree.admin)))) ||
        migrationIndexDigest(admin) !== tree.index || !matchesHead((args) => probe(admin, args), tree.head, tree.branch)) {
      throw new Error(`${tree.path}: linked worktree no longer matches the migration plan; preserve the files and inspect its Git link, HEAD and index`);
    }
  }
  return { gitDir, targetGit, target, needsRelocation };
}

function repairRelocatedCheckout({ root, git }: SourceWorkspace, source: LegacySource, targetGit: string): void {
  const { path, worktrees } = source;
  const coreWorktree = git(root, ["config", "--file", join(targetGit, "config"), "--null", "--get-all", "core.worktree"]);
  if (coreWorktree.success) {
    if (coreWorktree.stdout !== `${source.coreWorktree}\0` || !git(root, ["config", "--file", join(targetGit, "config"), "--unset", "core.worktree"]).success) {
      throw new Error(`could not remove the obsolete core.worktree binding in ${targetGit}`);
    }
  } else if (coreWorktree.exitCode !== 1) throw new Error(`could not read ${targetGit}/config`);
  if (worktrees.length && !git(path, ["worktree", "repair", "--", ...worktrees.map((tree) => tree.path)]).success) {
    throw new Error(`could not repair linked worktrees for ${path}; inspect their links before retrying`);
  }
}

function verifyConvertedCheckouts({ git }: SourceWorkspace, source: LegacySource, targetGit: string): void {
  const verify = (path: string, dir: string, expectedHead: string | null, expectedBranch: string | null, index: string | null) => {
    const actual = git(path, ["rev-parse", "--absolute-git-dir"]);
    const common = git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const top = git(path, ["rev-parse", "--show-toplevel"]);
    if (!actual.success || actual.stdout.replace(/\n$/, "") !== dir ||
        !common.success || common.stdout.replace(/\n$/, "") !== targetGit ||
        !top.success || top.stdout.replace(/\n$/, "") !== path ||
        !matchesHead((args) => git(path, args), expectedHead, expectedBranch) ||
        migrationIndexDigest(dir) !== index) {
      throw new Error(`${path}: could not verify the converted checkout or worktree. Preserve the Git data at ${targetGit} and inspect it before retrying`);
    }
  };
  verify(source.path, targetGit, source.sourceHead, source.sourceBranch, source.index);
  for (const { path, admin, head, branch, index } of source.worktrees) verify(path, join(targetGit, admin), head, branch, index);
}

export function convertLocalSource(workspace: SourceWorkspace, source: LegacySource): void {
  const recorded = inspectRecordedGitData(workspace, source);
  if (!recorded) return;
  const { gitDir, targetGit, target, needsRelocation } = recorded;
  const { path, recreateFiles } = source;
  const { git } = workspace;
  const parent = dirname(path);
  if (!pathInfo(parent)) mkdirSync(parent);
  if (realpathSync(parent) !== parent) throw new Error(`${parent} is not a canonical source parent`);
  if (needsRelocation) {
    const checkout = pathInfo(path);
    if (!checkout) mkdirSync(path);
    else if (!checkout.isDirectory() || realpathSync(path) !== path) throw new Error(`${path} is not the canonical checkout`);
    if (target) {
      if (!target.isFile() || readFileSync(targetGit, "utf8") !== source.gitFile) throw new Error(`${targetGit} no longer matches its original link`);
      unlinkSync(targetGit);
    }
    if (recreateFiles && readdirSync(path).length) throw new Error(`${path} is not empty; preserve its files before recovering legacy Git data`);
    renameSync(gitDir, targetGit);
  }
  if (gitDir !== targetGit) repairRelocatedCheckout(workspace, source, targetGit);
  if (recreateFiles) {
    const remaining = readdirSync(path).filter((name) => name !== ".git");
    if (!remaining.length) {
      if (!git(path, ["checkout-index", "--all"]).success) throw new Error(`${path}: retained index could not populate working files; inspect the partial checkout before retrying`);
    } else {
      const state = git(path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"]);
      if (!state.success || state.stdout.split("\0").some((row) => row && (row[1] !== " " || row[0] === "?" || row[0] === "!"))) {
        throw new Error(`${path}: files appeared or were only partly recovered; preserve them and restore the recorded index contents before retrying`);
      }
    }
  }
  verifyConvertedCheckouts(workspace, source, targetGit);
}
