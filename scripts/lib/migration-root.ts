import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./constants.js";
import { inspectSourceOperations } from "./git-operation-state.js";
import { presentMigrationGitlinks, removeRegistrationSections, verifyStagedRegistrations } from "./migration-git.js";
import type { LegacySource, MigrationPlan } from "./migration-plan.js";
import type { SourceWorkspace } from "./source-checkout.js";

type FileState = { content: string; mode: number };
type FileChange = { path: string; before: FileState | null; after: FileState };
export type MigrationRootPatch = { files: FileChange[]; links: { path: string; oid: string }[] };

function readRegular(path: string): FileState | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    return { content: readFileSync(path).toString("base64"), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function removeManifestSetting(content: string): string {
  const doc = parseDocument(content);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error("workspace manifest cannot be safely edited");
  const items = doc.contents.items;
  const pair = items.find((item) => isScalar(item.key) && item.key.value === "autoCommitRegistration");
  if (!pair) return content;
  if (!isScalar(pair.key) || !pair.key.range || !isScalar(pair.value) || !pair.value.range) throw new Error("could not isolate autoCommitRegistration without changing other manifest entries");
  const start = pair.key.range[0];
  const end = pair.value.range[1];
  if (doc.contents.flow) {
    const index = items.indexOf(pair);
    if (index < items.length - 1) {
      const tail = /^[ \t\r\n]*,/.exec(content.slice(end));
      if (tail) return content.slice(0, start) + content.slice(end + tail[0].length);
    } else {
      const delimiter = /,[ \t\r\n]*$/.exec(content.slice(0, start));
      if (delimiter) return content.slice(0, delimiter.index) + content.slice(end);
    }
    throw new Error("could not isolate the legacy setting in the flow-style manifest");
  }
  const lineStart = content.lastIndexOf("\n", start - 1) + 1;
  const newline = content.indexOf("\n", end);
  const lineEnd = newline < 0 ? content.length : newline + 1;
  if (!/^\s*$/.test(content.slice(lineStart, start))) throw new Error("could not isolate the legacy setting on its own line");
  const comment = /^[ \t]*(#[^\r\n]*)/.exec(content.slice(end, lineEnd));
  return content.slice(0, lineStart) + (comment ? `${content.slice(lineStart, start)}${comment[1]}${newline < 0 ? "" : "\n"}` : "") + content.slice(lineEnd);
}

function verifyRootOperations(ws: SourceWorkspace): void {
  const operation = inspectSourceOperations(ws.root);
  if (operation.kind === "active") throw new Error(`the root workspace has an active Git ${operation.label}; finish it before migrating`);
  if (operation.kind === "unreadable") throw new Error(`could not verify root Git operation state for ${operation.marker}`);
}

// Directory-only rules can require the directory to exist. Check in a temporary
// layout so retained sources can be verified without creating a checkout.
function verifyRootIgnores(ws: SourceWorkspace, patch: MigrationRootPatch, sources: readonly LegacySource[], phase: "planned" | "applied"): void {
  const paths = new Set(patch.links.map(({ path }) => path));
  for (const { gitDir, relative } of sources) {
    if (gitDir !== null) paths.add(relative);
  }
  if (!paths.size) return;

  const ignore = join(ws.root, ".gitignore");
  const current = readRegular(ignore)?.content ?? null;
  const change = phase === "planned" ? patch.files.find(({ path }) => path === ignore) : undefined;
  const intended = change?.after.content ?? current;
  const rules = current === intended ? [current] : [current, intended];
  const nested = readRegular(join(ws.root, DATA_DIRNAME, ".gitignore"));
  const probe = mkdtempSync(join(tmpdir(), "oms-ignore-preview-"));
  try {
    for (const path of paths) mkdirSync(join(probe, path), { recursive: true });
    if (nested) writeFileSync(join(probe, DATA_DIRNAME, ".gitignore"), Buffer.from(nested.content, "base64"));
    const input = Buffer.from(`${[...paths].join("\0")}\0`);
    for (const [index, contents] of rules.entries()) {
      if (contents !== null) writeFileSync(join(probe, ".gitignore"), Buffer.from(contents, "base64"));
      const result = ws.git(probe, [`--git-dir=${ws.gitDir}`, `--work-tree=${probe}`, "check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"], input);
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error("could not verify proposed source ignore rules");
      const records = result.stdout.split("\0");
      let row = 0;
      for (const path of paths) {
        const offset = row++ * 4;
        const [file, , pattern, name] = records.slice(offset, offset + 4);
        if (name !== path) throw new Error(`could not verify the ignore rule for ${path}`);
        if (pattern.startsWith("!")) throw new Error(`${file} contains an ignore exception for ${path}; resolve it before migration`);
        if (index === rules.length - 1 && !pattern) throw new Error(`root ignore rules do not hide ${path}; resolve them before migration`);
      }
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export function planMigrationRoot(ws: SourceWorkspace, plan: MigrationPlan): MigrationRootPatch {
  const links = plan.sources.flatMap(({ relative: path, rootGitlink: oid }) => oid ? [{ path, oid }] : []);
  const files: FileChange[] = [];
  const propose = (path: string, transform: (current: string) => string) => {
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error(`${dirname(path)} is not a canonical directory`);
    const before = readRegular(path);
    const raw = before ? Buffer.from(before.content, "base64") : Buffer.alloc(0);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw)) throw new Error(`${path} is not valid UTF-8; preserve its bytes and edit the legacy entry manually`);
    const next = transform(text);
    if (next !== text) files.push({ path, before, after: { content: Buffer.from(next).toString("base64"), mode: before?.mode ?? 0o644 } });
  };
  if (links.length) {
    propose(join(ws.root, ".gitmodules"), (text) => removeRegistrationSections(ws, text, new Set(links.map(({ path }) => path))));
    propose(join(ws.root, ".gitignore"), (text) => {
      const lines = new Set(text.split(/\r?\n/));
      const added = links.map(({ path }) => `/${path}/`).filter((line) => !lines.has(line));
      return !added.length ? text : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${added.join("\n")}\n`;
    });
  }
  if (plan.removeSetting) propose(join(ws.root, MANIFEST_FILENAME), removeManifestSetting);
  const local = new Set(plan.sources.filter(({ localRegistration }) => localRegistration).map(({ relative }) => relative));
  if (local.size) propose(join(ws.commonDir, "config"), (text) => removeRegistrationSections(ws, text, local));
  const patch = { files, links };
  verifyRootIgnores(ws, patch, plan.sources, "planned");
  return patch;
}

export function verifyMigrationRoot(ws: SourceWorkspace, patch: MigrationRootPatch, sources: readonly LegacySource[], initial: boolean): void {
  if (patch.links.length) verifyRootOperations(ws);
  for (const { path, before, after } of patch.files) {
    const current = readRegular(path);
    const matches = (state: FileState | null) => current?.content === state?.content && current?.mode === state?.mode;
    if (!matches(before) && (initial || !matches(after))) throw new Error(`${path} changed since preview; preserve the file and review the migration again`);
  }
  verifyRootIgnores(ws, patch, sources, "planned");
  const present = presentMigrationGitlinks(ws, patch.links);
  if (initial && present.size !== patch.links.length) throw new Error("root index no longer contains all planned gitlinks");
  if (!initial && patch.links.length) {
    const gitmodules = join(ws.root, ".gitmodules");
    const before = patch.files.find(({ path }) => path === gitmodules)?.before;
    if (!before) throw new Error("the migration has no recorded .gitmodules baseline; preserve the journal before retrying");
    verifyStagedRegistrations(ws, Buffer.from(before.content, "base64"), patch.links);
  }
}

export function applyMigrationRoot(ws: SourceWorkspace, patch: MigrationRootPatch, sources: readonly LegacySource[]): void {
  verifyMigrationRoot(ws, patch, sources, false);
  for (const change of patch.files) {
    const { path, before, after } = change;
    const current = readRegular(path);
    if (current?.content === after.content && current.mode === after.mode) continue;
    if (current?.content !== before?.content || current?.mode !== before?.mode) throw new Error(`${path} changed during migration`);
    const lock = `${path}.lock`;
    const fd = openSync(lock, "wx", 0o600);
    let renamed = false;
    try {
      const latest = readRegular(path);
      if (latest?.content !== before?.content || latest?.mode !== before?.mode) throw new Error(`${path} changed during migration`);
      writeFileSync(fd, Buffer.from(after.content, "base64"));
      fchmodSync(fd, after.mode);
      fsyncSync(fd);
      renameSync(lock, path);
      renamed = true;
    } finally {
      closeSync(fd);
      if (!renamed) rmSync(lock, { force: true });
    }
  }
  verifyRootIgnores(ws, patch, sources, "applied");
  const present = presentMigrationGitlinks(ws, patch.links);
  if (present.size) {
    verifyRootOperations(ws);
    const result = ws.git(ws.root, ["--literal-pathspecs", "update-index", "--force-remove", "--", ...present]);
    if (!result.success || presentMigrationGitlinks(ws, patch.links).size) throw new Error("could not remove the planned gitlinks from the root index; inspect it before resuming");
  }
}
