import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { ALIAS_PATTERN, DATA_DIRNAME, MIGRATION_JOURNAL_PATH, WORKTREE_MIGRATION_DOC } from "./constants.js";
import { docUrl } from "./env.js";
import { productionGitRunner, type RawGitRunner } from "./git.js";
import type { Repo } from "./types.js";

export type SourceWorkspace = {
  root: string;
  gitDir: string;
  commonDir: string;
  git: RawGitRunner;
};

export type SourceCheckout = { kind: "ready"; path: string; gitDir: string; origin: string; device: number; inode: number }
  | { kind: "missing"; path: string; reason: string }
  | { kind: "legacy" | "blocked"; path: string; reason: string };

export type ReadySourceCheckout = Extract<SourceCheckout, { kind: "ready" }>;

type IndependentCheckoutIdentity = ReadySourceCheckout & { gitDevice: number; gitInode: number };

// Revision path output is newline-terminated, not whitespace-delimited.
function gitPath(git: RawGitRunner, cwd: string, flag: string): string {
  const result = git(cwd, ["rev-parse", "--path-format=absolute", flag]);
  if (!result.success || !result.stdout.endsWith("\n")) throw new Error(`Git could not resolve ${flag} at ${cwd}`);
  return realpathSync(result.stdout.slice(0, -1));
}

export function openSourceWorkspace(root: string, git = productionGitRunner): SourceWorkspace {
  root = realpathSync(root);
  const top = git(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (!top.success && /not a git repository|not a git work tree|must be run in a work tree/i.test(top.stderr)) {
    throw new Error(`${root} is not a Git workspace. Run "git init" at the workspace root.`);
  }
  if (!top.success || !top.stdout.endsWith("\n")) {
    throw new Error(`Could not verify the root Git top-level for ${root}; check Git and filesystem access before retrying.`);
  }
  let topLevel: string;
  try {
    topLevel = realpathSync(top.stdout.slice(0, -1));
  } catch {
    throw new Error(`Could not verify the root Git top-level for ${root}; check Git and filesystem access before retrying.`);
  }
  if (topLevel !== root) {
    throw new Error(`Workspace manifest directory ${root} does not match the root Git top-level ${topLevel}. Move oms.yaml there or use a separate Git repository.`);
  }
  return { root, gitDir: gitPath(git, root, "--git-dir"), commonDir: gitPath(git, root, "--git-common-dir"), git };
}

function pathEntry(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function directory(path: string) {
  const entry = pathEntry(path);
  if (!entry) return undefined;
  if (!entry.isDirectory() || realpathSync(path) !== path) throw new Error(`${path} is not a canonical directory`);
  accessSync(path, constants.R_OK | constants.X_OK);
  return entry;
}

function legacyConfig(workspace: SourceWorkspace, source: string[], path: string): boolean {
  const config = workspace.git(workspace.root, ["config", ...source, "--null", "--list"]);
  if (!config.success) throw new Error(`Could not inspect ${source.join(" ")} for legacy registration`);
  for (const record of config.stdout.split("\0")) {
    if (!record.startsWith("submodule.")) continue;
    const separator = record.indexOf("\n");
    const key = separator < 0 ? record : record.slice(0, separator);
    const dot = key.lastIndexOf(".");
    if (key.slice("submodule.".length, dot) === path) return true;
    if (key.slice(dot + 1) === "path" && separator >= 0 && posix.normalize(record.slice(separator + 1)).replace(/\/+$/, "") === path) return true;
  }
  return false;
}

function rootTracking(workspace: SourceWorkspace, path: string): "legacy" | "tracked" | "clear" {
  const { git, root } = workspace;
  const paths = ["--", path, DATA_DIRNAME, ".gitmodules"];
  const index = git(root, ["--literal-pathspecs", "ls-files", "--stage", "-z", ...paths]);
  const head = git(root, ["--literal-pathspecs", "ls-tree", "-rz", "HEAD", ...paths]);
  if (!index.success) throw new Error("Could not inspect the workspace Git index");
  if (!head.success) {
    const branch = git(root, ["symbolic-ref", "--quiet", "HEAD"]);
    const refs = branch.success ? git(root, ["for-each-ref", "--format=%(refname)", "--", branch.stdout.trim()]) : null;
    if (!refs?.success || refs.stdout || refs.stderr) throw new Error("Could not inspect workspace HEAD");
  }
  let tracked = false;
  for (const output of [index.stdout, head.success ? head.stdout : ""]) {
    for (const record of output.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      if (tab < 0) throw new Error("Could not read workspace Git entry");
      const name = record.slice(tab + 1);
      if (name === path && record.startsWith("160000 ")) return "legacy";
      if (name === path || name === DATA_DIRNAME || name.startsWith(`${path}/`)) tracked = true;
      if (name !== ".gitmodules") continue;
      const blob = /^100(?:644|755) (?:blob )?([a-f0-9]+)(?: 0)?$/.exec(record.slice(0, tab));
      if (!blob) throw new Error("Workspace .gitmodules is not a regular, unconflicted Git entry");
      if (legacyConfig(workspace, ["--blob", blob[1]], path)) return "legacy";
    }
  }
  return tracked ? "tracked" : "clear";
}

export function matchingOrigin(git: RawGitRunner, path: string, expected: string): string {
  const urls = git(path, ["config", "--null", "--get-all", "remote.origin.url"]);
  if (!urls.success || urls.stdout.indexOf("\0") !== urls.stdout.length - 1 || urls.stdout.length <= 1) {
    throw new Error("checkout must have exactly one fetch URL for origin");
  }
  const actual = git(path, ["remote", "get-url", "--all", "origin"]);
  // A temporary config entry prevents Git treating the declaration itself as an existing remote name.
  const name = `oms-inspect-${randomUUID()}`;
  const declared = git(path, ["-c", `remote.${name}.url=${expected}`, "ls-remote", "--get-url", "--", name]);
  if (!actual.success || !declared.success || !actual.stdout.endsWith("\n")) throw new Error("could not resolve the origin fetch URL");
  if (actual.stdout !== declared.stdout) throw new Error("origin does not match the current declaration after Git URL rewriting");
  return actual.stdout.slice(0, -1);
}

function migrationInProgress({ gitDir }: SourceWorkspace): boolean {
  const file = join(gitDir, MIGRATION_JOURNAL_PATH);
  return Boolean(directory(dirname(file)) && pathEntry(file));
}

function readCheckoutIdentity(git: RawGitRunner, path: string, checkout: { dev: number; ino: number }, repo: Repo): IndependentCheckoutIdentity {
  if (pathEntry(join(path, ".bare"))) throw new Error(`legacy bare clone exists; preserve it and follow ${docUrl(WORKTREE_MIGRATION_DOC)} first`);
  const gitDir = join(path, ".git");
  const local = directory(gitDir);
  if (!local || gitPath(git, path, "--show-toplevel") !== path ||
      gitPath(git, path, "--git-dir") !== gitDir || gitPath(git, path, "--git-common-dir") !== gitDir) {
    throw new Error("not an independent Git checkout (linked worktrees are not canonical sources)");
  }
  if (!git(path, ["rev-parse", "--verify", "HEAD^{commit}"]).success) throw new Error("checkout has no readable HEAD commit");
  const origin = matchingOrigin(git, path, repo.remotes.origin);
  return { kind: "ready", path, gitDir, origin, device: checkout.dev, inode: checkout.ino, gitDevice: local.dev, gitInode: local.ino };
}

/** Recheck physical identity without repeating the initial eligibility check against root Git. */
export function inspectIndependentCheckoutIdentity(workspace: SourceWorkspace, repo: Repo, ready: ReadySourceCheckout): IndependentCheckoutIdentity {
  if (!ALIAS_PATTERN.test(repo.alias)) throw new Error("invalid source alias");
  if (migrationInProgress(workspace)) throw new Error("migration is incomplete. Run oms migrate to inspect or resume it.");
  const sources = join(workspace.root, DATA_DIRNAME);
  const path = join(sources, repo.alias);
  if (path !== ready.path) throw new Error("selected source path changed");
  const checkout = directory(sources) && directory(path);
  if (!checkout) throw new Error(`${path} is missing`);
  return readCheckoutIdentity(workspace.git, path, checkout, repo);
}

export function inspectSourceCheckout(workspace: SourceWorkspace, repo: Repo): SourceCheckout {
  const { root, gitDir, git } = workspace;
  const relative = `${DATA_DIRNAME}/${repo.alias}`;
  const path = join(root, relative);
  try {
    if (!ALIAS_PATTERN.test(repo.alias)) throw new Error("invalid source alias");
    if (migrationInProgress(workspace)) {
      return { kind: "legacy", path, reason: "migration is incomplete. Run oms migrate to inspect or resume it." };
    }
    const sources = directory(join(root, DATA_DIRNAME));
    const checkout = sources && directory(path);
    const modules = directory(join(gitDir, "modules"));
    const managedModules = modules && directory(join(gitDir, "modules", DATA_DIRNAME));
    const retained = managedModules && pathEntry(join(gitDir, "modules", relative));
    const tracked = rootTracking(workspace, relative);
    const gitmodules = pathEntry(join(root, ".gitmodules"));
    if (gitmodules && !gitmodules.isFile()) throw new Error("workspace .gitmodules is not a regular file");
    // The common Git config can still describe a submodule used by a different root worktree.
    if (retained || tracked === "legacy" || (gitmodules && legacyConfig(workspace, ["--file", ".gitmodules"], relative))) {
      return { kind: "legacy", path, reason: `legacy source data or registration for ${relative}. Run oms migrate --dry-run.` };
    }
    if (tracked === "tracked") throw new Error(`${relative} is tracked by the workspace root`);
    if (!checkout) return { kind: "missing", path, reason: `Run oms clone ${repo.alias}.` };

    return readCheckoutIdentity(git, path, checkout, repo);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "blocked", path, reason: `${reason}. Check ${relative}; OMS left it unchanged.` };
  }
}
