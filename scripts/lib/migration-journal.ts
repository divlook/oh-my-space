import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ALIAS_PATTERN, DATA_DIRNAME, MANIFEST_FILENAME, MIGRATION_JOURNAL_PATH } from "./constants.js";
import { sharedRegistrationBlockers, type LegacySource } from "./migration-plan.js";
import { verifyMigrationRoot, type MigrationRootPatch } from "./migration-root.js";
import type { SourceWorkspace } from "./source-checkout.js";
import type { Repo } from "./types.js";

const lockRef = "refs/oms/source-migration-lock";
export type MigrationJournal = { version: 1; root: string; gitDir: string; head: string | null; sources: LegacySource[]; patch: MigrationRootPatch };

export function rootMigrationHead(ws: SourceWorkspace): string | null {
  const head = ws.git(ws.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.success && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.stdout.trim())) return head.stdout.trim();
  const branch = ws.git(ws.root, ["symbolic-ref", "--quiet", "HEAD"]);
  const refs = branch.success ? ws.git(ws.root, ["for-each-ref", "--format=%(refname)", "--", branch.stdout.trim()]) : null;
  if (refs?.success && !refs.stdout && !refs.stderr) return null;
  throw new Error("could not verify workspace HEAD");
}

export function acquireMigrationLock(ws: SourceWorkspace): () => void {
  const { root, git } = ws;
  const owner = Buffer.from(JSON.stringify({ pid: process.pid, host: hostname(), time: Date.now() }));
  const object = git(root, ["hash-object", "-w", "--stdin"], owner);
  if (!object.success) throw new Error("could not create the migration lock record");
  const next = object.stdout.trim();
  const held = git(root, ["rev-parse", "--verify", "--quiet", lockRef]);
  const previous = held.success ? held.stdout.trim() : "0".repeat(next.length);
  if (held.success) {
    const blob = git(root, ["cat-file", "blob", previous]);
    if (!blob.success) throw new Error("could not inspect the migration lock owner; preserve the lock and journal");
    const current: unknown = JSON.parse(blob.stdout);
    if (!current || typeof current !== "object" || !("host" in current) || current.host !== hostname() || !("pid" in current) ||
        typeof current.pid !== "number" || !Number.isSafeInteger(current.pid) || current.pid <= 0) {
      throw new Error("migration lock ownership could not be verified on this computer");
    }
    try {
      process.kill(current.pid, 0);
      throw new Error("another migration process is running");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else if (held.exitCode !== 1) throw new Error("could not read the migration lock");
  if (!git(root, ["update-ref", lockRef, next, previous]).success) throw new Error("could not acquire the migration lock; retry after other migrations finish");
  return () => {
    if (!git(root, ["update-ref", "-d", lockRef, next]).success) throw new Error("could not release the migration lock; retry after this process exits");
  };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readMigrationJournal(ws: SourceWorkspace): MigrationJournal | null {
  const file = join(ws.gitDir, MIGRATION_JOURNAL_PATH);
  const dir = dirname(file);
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(file).isFile()) throw new Error("state path is not a regular journal in a canonical directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const { payload, digest } = JSON.parse(readFileSync(file, "utf8"));
  if (typeof payload !== "string" || createHash("sha256").update(payload).digest("hex") !== digest) throw new Error(`invalid migration journal ${file}; preserve it and inspect its records`);
  const data = JSON.parse(payload) as MigrationJournal;
  const allowedFiles = new Set([join(ws.root, MANIFEST_FILENAME), join(ws.root, ".gitmodules"), join(ws.root, ".gitignore"), join(ws.commonDir, "config")]);
  const paths = new Set<string>();
  if (data.version !== 1 || data.root !== ws.root || data.gitDir !== ws.gitDir || data.head !== rootMigrationHead(ws) ||
      !Array.isArray(data.sources) || !Array.isArray(data.patch?.files) || !Array.isArray(data.patch?.links)) {
    throw new Error(`workspace identity or HEAD differs from ${file}; preserve the journal and both Git directories`);
  }
  for (const source of data.sources) {
    const relative = `${DATA_DIRNAME}/${source.repo.alias}`;
    const path = join(ws.root, relative);
    if (!ALIAS_PATTERN.test(source.repo.alias) || source.relative !== relative || source.path !== path || paths.has(relative) ||
        (source.gitDir !== null && source.gitDir !== join(path, ".git") && source.gitDir !== join(ws.gitDir, "modules", relative)) ||
        !Array.isArray(source.worktrees) || source.worktrees.some((tree) => !isAbsolute(tree.path) || !/^worktrees[/\\][^/\\]+$/.test(tree.admin) || /(?:^|[/\\])\.\.?$/.test(tree.admin))) {
      throw new Error(`unsafe source record in ${file}; preserve the journal and inspect it`);
    }
    paths.add(relative);
  }
  if (data.patch.files.some(({ path }) => !allowedFiles.has(path)) || data.patch.links.some(({ path }) => !paths.has(path))) throw new Error(`unsafe root path in ${file}; preserve the journal and inspect it`);
  return data;
}

export function loadMigrationRecovery(ws: SourceWorkspace, repos: readonly Repo[], onFound: () => void): MigrationJournal | null {
  const journal = readMigrationJournal(ws);
  if (!journal) return null;
  onFound();
  verifyMigrationRoot(ws, journal.patch, journal.sources, false);
  for (const source of journal.sources) {
    if (!repos.some((repo) => repo.alias === source.repo.alias && repo.branch === source.repo.branch && isDeepStrictEqual(repo.remotes, source.repo.remotes))) {
      throw new Error(`${source.repo.alias}: declaration differs from the recorded migration; preserve the journal and review oms.yaml`);
    }
  }
  const blockers = sharedRegistrationBlockers(ws, journal.sources);
  if (blockers.length) throw new Error(blockers.join("\n"));
  return journal;
}

export function writeMigrationJournal(ws: SourceWorkspace, journal: MigrationJournal): void {
  const file = join(ws.gitDir, MIGRATION_JOURNAL_PATH);
  const dir = dirname(file);
  try {
    mkdirSync(dir, { mode: 0o700 });
    syncDirectory(ws.gitDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a canonical migration state directory`);
  }
  const temp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify(journal);
  const contents = JSON.stringify({ payload, digest: createHash("sha256").update(payload).digest("hex") });
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  syncDirectory(dir);
}

export function clearMigrationJournal(ws: SourceWorkspace): void {
  const file = join(ws.gitDir, MIGRATION_JOURNAL_PATH);
  rmSync(file);
  syncDirectory(dirname(file));
}
