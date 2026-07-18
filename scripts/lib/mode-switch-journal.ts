import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceMode } from "./types.js";

export const MODE_SWITCH_JOURNAL = ".oms-mode-switch.json";

export type ModeSwitchPhase = "prepared" | "source-removed" | "manifest-updated" | "target-synced" | "root-finalized";

export type StagedModeSwitchRepository = {
  alias: string;
  path: string;
  selectedOid: string | null;
  selectedBranch: string | null;
  selectedUpstream: string | null;
  refs: Array<{ refname: string; oid: string }>;
};

export type ModeSwitchJournal = {
  version: 1;
  transitionId: string;
  lockOperationId: string;
  workspaceId: string;
  sourceMode: WorkspaceMode;
  targetMode: WorkspaceMode;
  sync: boolean;
  commit: boolean;
  force: boolean;
  preserveLocal: boolean;
  originalManifestHash: string;
  expectedManifestHash: string;
  modeRange: [number, number];
  modeToken: string | null;
  rootIndex: { hash: string; size: number } | null;
  exclude: { hash: string; markerStart: number; markerEnd: number } | null;
  rootHeadBefore: string | null;
  phase: ModeSwitchPhase;
  completedAliases: string[];
  stagedRepositories: StagedModeSwitchRepository[];
  selectedSources: Array<{ alias: string; target: string | null; oid: string }>;
  createdAt: string;
};

function validate(value: Partial<ModeSwitchJournal>): ModeSwitchJournal {
  if (value.version !== 1 || typeof value.transitionId !== "string" || typeof value.lockOperationId !== "string" || typeof value.workspaceId !== "string"
    || !["submodule", "worktree"].includes(value.sourceMode ?? "")
    || !["submodule", "worktree"].includes(value.targetMode ?? "")
    || typeof value.sync !== "boolean" || typeof value.commit !== "boolean" || typeof value.force !== "boolean"
    || typeof value.originalManifestHash !== "string" || typeof value.expectedManifestHash !== "string"
    || !Array.isArray(value.modeRange) || value.modeRange.length !== 2 || typeof value.modeToken !== "string" && value.modeToken !== null
    || value.rootIndex === undefined || value.exclude === undefined || value.rootHeadBefore === undefined
    || !["prepared", "source-removed", "manifest-updated", "target-synced", "root-finalized"].includes(value.phase ?? "")
    || !Array.isArray(value.completedAliases) || typeof value.createdAt !== "string") {
    throw new Error(`${MODE_SWITCH_JOURNAL} is malformed; run "oms doctor" before retrying`);
  }
  value.preserveLocal ??= false;
  value.stagedRepositories ??= [];
  value.selectedSources ??= [];
  const stagedValid = Array.isArray(value.stagedRepositories) && value.stagedRepositories.every((entry) =>
    entry && typeof entry.alias === "string" && typeof entry.path === "string"
    && (entry.selectedOid === null || typeof entry.selectedOid === "string")
    && (entry.selectedBranch === null || typeof entry.selectedBranch === "string")
    && (entry.selectedUpstream === null || typeof entry.selectedUpstream === "string")
    && Array.isArray(entry.refs) && entry.refs.every((ref) => typeof ref.refname === "string" && typeof ref.oid === "string"));
  const sourcesValid = Array.isArray(value.selectedSources) && value.selectedSources.every((entry) =>
    entry && typeof entry.alias === "string" && (entry.target === null || typeof entry.target === "string") && typeof entry.oid === "string");
  if (typeof value.preserveLocal !== "boolean" || !stagedValid || !sourcesValid) {
    throw new Error(`${MODE_SWITCH_JOURNAL} is malformed; run "oms doctor" before retrying`);
  }
  return value as ModeSwitchJournal;
}

/** Reads a mode-switch journal without changing it. */
export function readModeSwitchJournal(workspaceRoot: string): ModeSwitchJournal | null {
  const path = join(workspaceRoot, MODE_SWITCH_JOURNAL);
  if (!existsSync(path)) return null;
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${MODE_SWITCH_JOURNAL} must be a regular file`);
  return validate(JSON.parse(readFileSync(path, "utf8")) as Partial<ModeSwitchJournal>);
}

/** Atomically writes credential-free mode-switch recovery state. */
export function writeModeSwitchJournal(workspaceRoot: string, journal: ModeSwitchJournal): void {
  const path = join(workspaceRoot, MODE_SWITCH_JOURNAL);
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

export function removeModeSwitchJournal(workspaceRoot: string): void {
  rmSync(join(workspaceRoot, MODE_SWITCH_JOURNAL), { force: true });
}
