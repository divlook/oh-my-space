import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ALIAS_PATTERN, DATA_DIRNAME, MANIFEST_FILENAME } from "./constants.js";
import { inspectSourceOperations } from "./git-operation-state.js";
import { parseManifest } from "./manifest.js";
import { blobRegistrations, registration, registrationMatchesOrigin, registrations, rootEntries, sameRegistration, type RootEntries } from "./migration-git.js";
import { inspectSourceCheckout, matchingOrigin, type SourceWorkspace } from "./source-checkout.js";
import type { Repo } from "./types.js";

export type LegacyWorktree = { path: string; head: string; branch: string | null; gitFile: string; admin: string; index: string | null };
export type LegacySource = {
  repo: Repo;
  relative: string;
  path: string;
  gitDir: string | null;
  gitFile: string | null;
  sourceHead: string | null;
  sourceBranch: string | null;
  index: string | null;
  gitIdentity: { device: number; inode: number } | null;
  coreWorktree: string | null;
  recreateFiles: boolean;
  worktrees: LegacyWorktree[];
  rootGitlink: string | null;
  localRegistration: boolean;
};
export type MigrationPlan = { sources: LegacySource[]; blockers: string[]; removeSetting: boolean };

function pathInfo(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function checkDirectory(path: string): boolean {
  const entry = pathInfo(path);
  if (!entry) return false;
  if (!entry.isDirectory() || realpathSync(path) !== path) throw new Error(`${path} is not a canonical directory`);
  return true;
}

function formerlyRegistered(ws: SourceWorkspace, head: string, repo: Repo, path: string): void {
  const { root, git } = ws;
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);
  const advice = "fetch full root history (git fetch --unshallow for a shallow clone) and retry oms migrate --dry-run";
  if (!shallow.success || shallow.stdout.trim() !== "false") throw new Error(`root history cannot verify ownership; ${advice}`);
  const log = git(root, ["log", "--first-parent", "--full-history", "--format=%P", head, "--", path, ".gitmodules"]);
  if (!log.success) throw new Error(`could not inspect earlier registrations; ${advice}`);
  const originMismatch = "historic origin differs from the current declaration; preserve the old Git data separately";
  const verifyDeclaration = (files: RootEntries) => {
    const manifest = files.get(MANIFEST_FILENAME)?.[0];
    if (!manifest || !/^100(644|755)$/.test(manifest.mode)) throw new Error(`the former registration has no verifiable declaration; ${advice}`);
    const content = git(root, ["cat-file", "blob", manifest.oid]);
    const declared = content.success && parseManifest(content.stdout, true).repos.find(({ alias }) => alias === repo.alias);
    if (!declared || declared.remotes.origin !== repo.remotes.origin) throw new Error(originMismatch);
  };
  let newestRegistrationOnly: string | undefined;
  for (const line of log.stdout.trimEnd().split("\n")) {
    if (!line) continue;
    const evidence: (string | null)[] = [];
    const parents = line.split(" ");
    for (const parent of parents) {
      const files = rootEntries(ws, parent);
      const link = files.get(path)?.find(({ mode }) => mode === "160000");
      const mapping = registration(blobRegistrations(ws, files), path);
      if (!mapping) {
        if (link) throw new Error("historical gitlink and registration do not agree");
        if (newestRegistrationOnly) throw new Error("historical .gitmodules registration was removed and restored; preserve the old Git data separately");
        evidence.push(null);
        continue;
      }
      if (!link && parents.length > 1) throw new Error("historical merge parents disagree about legacy ownership");
      verifyDeclaration(files);
      if (!registrationMatchesOrigin(mapping, repo.remotes.origin)) throw new Error(originMismatch);
      if (!link) newestRegistrationOnly ??= parent;
      evidence.push(link?.oid ?? null);
    }
    if (evidence.some(Boolean)) {
      if (evidence.some((value) => value !== evidence[0])) throw new Error("historical merge parents disagree about legacy ownership");
      if (newestRegistrationOnly) {
        // A path-filtered log can omit a merge that kept its first parent's registration.
        const range = `${parents[0]}..${newestRegistrationOnly}`;
        const merges = git(root, ["rev-list", "--first-parent", "--merges", range]);
        if (!merges.success) throw new Error("could not verify linear history for the obsolete registration");
        if (merges.stdout) throw new Error("historical merge prevents verifying legacy ownership through a registration without a gitlink");
        const manifests = git(root, ["rev-list", "--first-parent", range, "--", MANIFEST_FILENAME]);
        if (!manifests.success) throw new Error("could not verify declaration history for the obsolete registration");
        for (const revision of manifests.stdout.trimEnd().split("\n")) {
          if (revision) verifyDeclaration(rootEntries(ws, revision, [MANIFEST_FILENAME]));
        }
      }
      return;
    }
  }
  throw new Error(`no agreeing historical gitlink and registration; ${advice}`);
}

function verifiedGitFile(file: string, gitDir: string): string {
  if (!lstatSync(file).isFile()) throw new Error(`${file} is not a regular Git link`);
  const content = readFileSync(file, "utf8");
  const match = /^gitdir: (.+)\r?\n$/.exec(content);
  if (!match || realpathSync(resolve(dirname(file), match[1])) !== gitDir) throw new Error(`${file} does not point to ${gitDir}`);
  return content;
}

export function migrationIndexDigest(gitDir: string): string | null {
  const file = join(gitDir, "index");
  const entry = pathInfo(file);
  if (!entry) return null;
  if (!entry.isFile()) throw new Error(`${file} is not a regular Git index`);
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function rejectNestedModules(gitDir: string): void {
  const modules = join(gitDir, "modules");
  if (checkDirectory(modules) && readdirSync(modules).length !== 0) {
    throw new Error(`${modules}: nested submodule Git data cannot be relocated safely; preserve it and its checkout before migration`);
  }
}

export function assertRelocationInventory(gitDir: string, originalGitDir: string, worktrees: readonly LegacyWorktree[], relocating: boolean): void {
  const registrations = join(gitDir, "worktrees");
  // The admin directories survive a rename even when checkout gitfiles still point at the old location.
  const existing = new Set(checkDirectory(registrations) ? readdirSync(registrations) : []);
  const changed = () => new Error(`${gitDir}: linked worktree inventory differs from the migration plan; preserve the worktrees and inspect their Git links`);
  if (existing.size !== worktrees.length) throw changed();
  if (relocating) rejectNestedModules(gitDir);
  for (const tree of worktrees) {
    const admin = join(gitDir, tree.admin);
    if (dirname(admin) !== registrations || !existing.delete(admin.slice(registrations.length + 1)) || !checkDirectory(admin)) throw changed();
    const backLink = join(admin, "gitdir");
    if (!pathInfo(backLink)?.isFile()) throw changed();
    const link = readFileSync(backLink, "utf8").replace(/\r?\n$/, "");
    const file = join(tree.path, ".git");
    if (!link || (resolve(admin, link) !== file && resolve(originalGitDir, tree.admin, link) !== file)) throw changed();
    if (relocating) rejectNestedModules(admin);
  }
}

export function sharedRegistrationBlockers(ws: SourceWorkspace, sources: readonly LegacySource[]): string[] {
  const paths = sources.filter(({ localRegistration }) => localRegistration).map(({ relative }) => relative);
  if (!paths.length) return [];

  // Local config belongs to the common repository, not the current root worktree.
  const listing = ws.git(ws.root, ["worktree", "list", "--porcelain", "-z"]);
  if (!listing.success) throw new Error("could not check whether other root worktrees use the shared submodule registrations");
  const blockers: string[] = [];
  for (const group of listing.stdout.split("\0\0")) {
    if (!group) continue;
    const [record, ...flags] = group.split("\0");
    if (!record.startsWith("worktree ")) throw new Error("could not read the root worktree inventory");
    const root = record.slice(9);
    if (root === ws.root || flags.includes("bare") || !pathInfo(join(root, DATA_DIRNAME))?.isDirectory()) continue;
    const live = new Set(paths.filter((path) => {
      const checkout = join(root, path);
      return pathInfo(checkout)?.isDirectory() && pathInfo(join(checkout, ".git"));
    }));
    if (!live.size) continue;
    const index = ws.git(root, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...live]);
    if (!index.success) throw new Error(`could not check legacy registrations in root worktree ${root}`);
    for (const entry of index.stdout.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const path = entry.slice(entry.indexOf("\t") + 1);
      if (live.delete(path)) {
        blockers.push(`${path}: root worktree ${root} still uses the shared submodule registration; preserve both checkouts and migrate from separate root clones`);
      }
    }
  }
  return blockers;
}

function localSource(ws: SourceWorkspace, repo: Repo, relative: string, retained: string | null): Omit<LegacySource, "rootGitlink" | "localRegistration"> {
  const path = join(ws.root, relative);
  const dotGit = join(path, ".git");
  const present = checkDirectory(path);
  const marker = present ? pathInfo(dotGit) : undefined;
  const gitDir = marker?.isDirectory() ? dotGit : retained;
  const gitFile = marker && !marker.isDirectory() && retained ? verifiedGitFile(dotGit, retained) : null;
  if (marker && !marker.isDirectory() && gitFile === null) throw new Error("checkout Git link does not point to verified legacy data");
  if (marker?.isDirectory() && retained) throw new Error("both an independent Git directory and retained legacy data exist");
  if (!marker && present && readdirSync(path).length) throw new Error("canonical checkout is occupied by files without a verified Git link");
  const source = { repo, relative, path, gitDir, gitFile, recreateFiles: Boolean(retained && !marker) };
  if (!gitDir) return { ...source, sourceHead: null, sourceBranch: null, index: null, gitIdentity: null, coreWorktree: null, worktrees: [] };
  checkDirectory(gitDir);
  const cwd = marker ? path : ws.root;
  const git = (args: string[]) => ws.git(cwd, [`--git-dir=${gitDir}`, `--work-tree=${cwd}`, ...args]);
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.success || realpathSync(common.stdout.replace(/\n$/, "")) !== gitDir) throw new Error("legacy Git directory shares repository data with another repository");
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.success) throw new Error("legacy Git directory has no readable HEAD");
  const branch = git(["symbolic-ref", "--quiet", "HEAD"]);
  if (!branch.success && branch.exitCode !== 1) throw new Error("could not inspect legacy source branch");
  const cfg = git(["config", "--local", "--null", "--get-all", "core.worktree"]);
  if (cfg.exitCode !== 0 && cfg.exitCode !== 1) throw new Error("could not read legacy core.worktree");
  const coreWorktree = cfg.success ? cfg.stdout.slice(0, -1) : null;
  if (coreWorktree !== null && (!coreWorktree || coreWorktree.includes("\0") || resolve(gitDir, coreWorktree) !== path)) {
    throw new Error("legacy core.worktree does not bind exactly to the canonical source");
  }
  const worktreeConfig = git(["config", "--local", "--type=bool", "--get", "extensions.worktreeConfig"]);
  if ((worktreeConfig.exitCode !== 0 && worktreeConfig.exitCode !== 1) ||
      (worktreeConfig.success && worktreeConfig.stdout.trim() !== "false") || pathInfo(join(gitDir, "objects", "info", "alternates"))) {
    throw new Error("legacy Git data has worktree-specific configuration or borrowed objects; preserve or consolidate it before migration");
  }
  const index = migrationIndexDigest(gitDir);
  if (source.recreateFiles) {
    const unmerged = git(["ls-files", "--unmerged", "-z"]);
    if (!index || !unmerged.success || unmerged.stdout) throw new Error("retained index cannot safely recreate working files");
  }
  const sourceRunner = (_cwd: string, args: string[]) => git(args);
  matchingOrigin(sourceRunner, cwd, repo.remotes.origin);
  const op = marker ? inspectSourceOperations(path) : null;
  if ((op && op.kind !== "idle") || ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer", "index.lock", "config.lock"].some((name) => pathInfo(join(gitDir, name)))) {
    throw new Error("legacy checkout contains an active Git operation or lock");
  }
  const listing = git(["worktree", "list", "--porcelain", "-z"]);
  if (!listing.success) throw new Error("could not inventory linked worktrees");
  const worktrees: LegacyWorktree[] = [];
  for (const group of listing.stdout.split("\0\0").slice(1)) {
    if (!group) continue;
    const fields = group.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const oid = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    if (!worktree || !oid || !checkDirectory(worktree) || fields.some((field) => field.startsWith("prunable"))) {
      throw new Error(`unresolved linked worktree ${worktree ?? "path"}; run git worktree repair before retrying`);
    }
    const file = join(worktree, ".git");
    const actual = ws.git(worktree, ["rev-parse", "--absolute-git-dir"]);
    if (!actual.success || dirname(actual.stdout.replace(/\n$/, "")) !== join(gitDir, "worktrees")) throw new Error(`linked worktree ${worktree} is not attached to ${relative}`);
    if (inspectSourceOperations(worktree).kind !== "idle") throw new Error(`linked worktree ${worktree} contains an active Git operation`);
    const adminDir = actual.stdout.replace(/\n$/, "");
    worktrees.push({ path: worktree, head: oid, branch: fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null, gitFile: verifiedGitFile(file, adminDir), admin: adminDir.slice(gitDir.length + 1), index: migrationIndexDigest(adminDir) });
  }
  assertRelocationInventory(gitDir, gitDir, worktrees, gitDir !== dotGit);
  const { dev, ino } = lstatSync(gitDir);
  return { ...source, sourceHead: head.stdout.trim(), sourceBranch: branch.success ? branch.stdout.replace(/\n$/, "") : null, index, gitIdentity: { device: dev, inode: ino }, coreWorktree, worktrees };
}

export function planMigration(ws: SourceWorkspace, repos: Repo[], removeSetting: boolean): MigrationPlan {
  const plan: MigrationPlan = { sources: [], blockers: [], removeSetting };
  const { root, git } = ws;
  try {
    const stateDir = join(ws.gitDir, "oms");
    const lock = git(root, ["show-ref", "--verify", "--quiet", "refs/oms/finalize-lock"]);
    if (lock.exitCode !== 1 || (checkDirectory(stateDir) && readdirSync(stateDir).some((file) => /^finalize\.json$|^index\.(?:tmp\.|recovery)/.test(file)))) {
      throw new Error("finish the interrupted root transaction with OMS 2.x before migrating");
    }
    checkDirectory(join(root, DATA_DIRNAME));
    checkDirectory(join(ws.gitDir, "modules"));
    checkDirectory(join(ws.gitDir, "modules", DATA_DIRNAME));
    const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const headOid = head.success ? head.stdout.trim() : null;
    const committed: RootEntries = headOid ? rootEntries(ws, headOid) : new Map();
    const staged = rootEntries(ws, null);
    const headConfig = blobRegistrations(ws, committed);
    const stagedConfig = blobRegistrations(ws, staged);
    const configFile = pathInfo(join(root, ".gitmodules"));
    if (configFile && !configFile.isFile()) throw new Error("workspace .gitmodules is not a regular file");
    const workingConfig = configFile ? registrations(ws, ["--file", ".gitmodules"]) : [];
    const localConfig = registrations(ws, ["--local"]);
    for (const repo of repos) {
      const relative = `${DATA_DIRNAME}/${repo.alias}`;
      try {
        if (!ALIAS_PATTERN.test(repo.alias)) throw new Error("invalid source alias");
        const expectedGitDir = join(ws.gitDir, "modules", relative);
        const retained = checkDirectory(expectedGitDir) ? expectedGitDir : null;
        const headReg = registration(headConfig, relative);
        const stagedReg = registration(stagedConfig, relative);
        const workingReg = registration(workingConfig, relative);
        const localRegistration = localConfig.some(({ name }) => name === relative);
        const rootLink = committed.get(relative)?.filter(({ mode }) => mode === "160000")[0];
        const current = staged.get(relative);
        const stagedLink = current?.find(({ mode }) => mode === "160000");
        if (!retained && !headReg && !stagedReg && !workingReg && !rootLink && !stagedLink && !localRegistration) {
          const checkout = inspectSourceCheckout(ws, repo);
          if (checkout.kind === "legacy") throw new Error(checkout.reason);
          continue;
        }
        if (rootLink && !stagedLink) {
          throw new Error("the submodule pointer is still in HEAD but is missing from the index. Review git diff --cached and git diff. If oms migrate already completed, commit the pointer removal together with its .gitmodules registration removal and any related .gitignore or oms.yaml edits. Otherwise, inspect why the pointer was removed before committing or retrying migration.");
        }
        if (!rootLink && !stagedLink && headReg && !workingReg && (!stagedReg || sameRegistration(headReg, stagedReg))) {
          throw new Error("the root no longer tracks this submodule, but its .gitmodules registration still exists in HEAD. If the submodule was removed intentionally, review and commit only the obsolete registration removal, then run oms migrate --dry-run again. Keep the source checkout and its Git data.");
        }
        if (headReg || rootLink || stagedReg || stagedLink || workingReg) {
          if (!headReg || !rootLink || !stagedReg || !workingReg || !stagedLink || current?.length !== 1 || stagedLink.stage !== "0" ||
              rootLink.oid !== stagedLink.oid || !registrationMatchesOrigin(headReg, repo.remotes.origin) ||
              !sameRegistration(headReg, stagedReg) || !sameRegistration(headReg, workingReg)) {
            throw new Error("root gitlink and .gitmodules registration disagree or have overlapping changes; resolve with OMS 2.x first");
          }
        } else {
          if (!headOid) throw new Error("root HEAD is unavailable; fetch history to verify the retained registration");
          formerlyRegistered(ws, headOid, repo, relative);
        }
        if (current?.some(({ mode }) => mode !== "160000") || [...staged.keys()].some((name) => name.startsWith(`${relative}/`))) {
          throw new Error("the root index tracks regular files at the source path");
        }
        const ignore = git(root, ["check-ignore", "--no-index", "-v", "-z", "--stdin"], Buffer.from(`${relative}\0${relative}/.oms-ignore-probe\0`));
        if (ignore.exitCode !== 0 && ignore.exitCode !== 1) throw new Error("could not verify existing root ignore rules");
        const fields = ignore.stdout.split("\0");
        for (let i = 0; i + 3 < fields.length; i += 4) {
          if (fields[i + 2].startsWith("!")) throw new Error(`${fields[i]} contains an ignore exception for ${relative}; resolve it before migration`);
        }
        plan.sources.push({ ...localSource(ws, repo, relative, retained), rootGitlink: rootLink?.oid ?? null, localRegistration });
      } catch (error) {
        plan.blockers.push(`${repo.alias}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    plan.blockers.push(...sharedRegistrationBlockers(ws, plan.sources));
  } catch (error) {
    plan.blockers.push(error instanceof Error ? error.message : String(error));
  }
  return plan;
}
