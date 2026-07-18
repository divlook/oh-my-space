import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { MANIFEST_FILENAME } from "./constants.js";
import type { WorkspaceMode } from "./types.js";

export type ManifestModeEdit = {
  originalHash: string;
  expectedHash: string;
  originalMode: WorkspaceMode;
  targetMode: WorkspaceMode;
  range: [number, number];
  token: string | null;
  bytes: Buffer;
};

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function modePair(source: string) {
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error(`${MANIFEST_FILENAME}: ${document.errors[0].message}`);
  if (!isMap(document.contents)) throw new Error(`${MANIFEST_FILENAME}: root must be a mapping`);
  const matches = document.contents.items.filter((item) => isScalar(item.key) && item.key.value === "mode");
  if (matches.length > 1) throw new Error(`${MANIFEST_FILENAME}: duplicate top-level "mode" key`);
  return matches[0] ?? null;
}

/** Plans a byte-preserving top-level mode edit without changing the manifest. */
export function planManifestModeEdit(workspaceRoot: string, targetMode: WorkspaceMode): ManifestModeEdit {
  const path = join(workspaceRoot, MANIFEST_FILENAME);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(
      `${MANIFEST_FILENAME} must be a regular workspace-local file for mode switch; replace the symbolic link intentionally and retry`,
    );
  }
  const original = readFileSync(path);
  const source = original.toString("utf8");
  const pair = modePair(source);
  let originalMode: WorkspaceMode = "submodule";
  let range: [number, number];
  let token: string | null = null;
  let edited: string;

  if (pair) {
    if (!isScalar(pair.value) || !Array.isArray(pair.value.range)) {
      throw new Error(`${MANIFEST_FILENAME}: top-level "mode" must be a scalar`);
    }
    const value = pair.value.value;
    if (value !== "submodule" && value !== "worktree") {
      throw new Error(`${MANIFEST_FILENAME}: "mode" must be "submodule" or "worktree"`);
    }
    originalMode = value;
    range = [pair.value.range[0], pair.value.range[1]];
    token = source.slice(range[0], range[1]);
    const replacement = token.startsWith("'") ? `'${targetMode}'`
      : token.startsWith('"') ? `"${targetMode}"`
        : targetMode;
    edited = `${source.slice(0, range[0])}${replacement}${source.slice(range[1])}`;
  } else {
    const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
    const insertion = source.startsWith("#")
      ? source.indexOf(lineEnding) + lineEnding.length
      : 0;
    const modeLine = `mode: ${targetMode}${lineEnding}`;
    range = [insertion + "mode: ".length, insertion + "mode: ".length];
    edited = `${source.slice(0, insertion)}${modeLine}${source.slice(insertion)}`;
  }

  const bytes = Buffer.from(edited, "utf8");
  return {
    originalHash: hash(original),
    expectedHash: hash(bytes),
    originalMode,
    targetMode,
    range,
    token,
    bytes,
  };
}

/** Applies a previously planned manifest edit with compare-and-swap and atomic replacement. */
export function applyManifestModeEdit(workspaceRoot: string, edit: ManifestModeEdit): void {
  const path = join(workspaceRoot, MANIFEST_FILENAME);
  const current = readFileSync(path);
  if (hash(current) !== edit.originalHash) {
    throw new Error(`${MANIFEST_FILENAME} changed after mode-switch preflight; no manifest edit was applied`);
  }
  const temporary = join(dirname(path), `.${MANIFEST_FILENAME}.mode-switch.${process.pid}.${randomUUID()}`);
  const fd = openSync(temporary, "wx", lstatSync(path).mode & 0o777);
  try {
    writeFileSync(fd, edit.bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
