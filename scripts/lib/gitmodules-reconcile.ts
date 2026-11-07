import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productionGitRunner, submodulePath } from "./git.js";
import { transformManagedGitmodules } from "./managed-gitmodules.js";
import { shellQuote as shq } from "./shell.js";

export type AliasMetadataPlan = {
  alias: string;
  url: string;
  /** Explicit branch to write, or null to remove the `submodule.<path>.branch` key. */
  branch: string | null;
};

type ReconcileResult =
  | { ok: true; changedFields: Map<string, string[]> }
  | {
      ok: false;
      retained: "original" | "owner-only";
      reason: string;
      /** Empty after a mode-restoration failure: all metadata was applied. */
      unapplied: string[];
      /** Present only when the file is left owner-only after an exhausted mode-restoration failure. */
      chmodCommand?: string;
    };


function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function getConfigValue(repoRoot: string, snapshot: string, key: string): string | null {
  const r = productionGitRunner(repoRoot, ["config", "--file", "-", "--get", key], Buffer.from(snapshot));
  const value = r.stdout.trim();
  return r.success && value.length > 0 ? value : null;
}

function computeChangedFields(repoRoot: string, snapshot: string, plans: AliasMetadataPlan[]): Map<string, string[]> {
  const changed = new Map<string, string[]>();
  for (const plan of plans) {
    const fields: string[] = [];
    const path = submodulePath(plan.alias);
    if (getConfigValue(repoRoot, snapshot, `submodule.${path}.url`) !== plan.url) fields.push("url");
    const currentBranch = getConfigValue(repoRoot, snapshot, `submodule.${path}.branch`);
    if (currentBranch !== plan.branch) fields.push("branch");
    if (fields.length > 0) changed.set(plan.alias, fields);
  }
  return changed;
}

type ApplyOutcome = { kind: "ok" } | { kind: "planning" } | { kind: "io" };

function applyOnce(
  repoRoot: string,
  gitmodules: string,
  tmpPath: string,
  snapshot: string,
  plans: AliasMetadataPlan[],
): ApplyOutcome {
  try {
    const fd = openSync(tmpPath, "wx", 0o600);
    try {
      writeFileSync(fd, snapshot);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { kind: "io" };
  }

  if (!transformManagedGitmodules(repoRoot, tmpPath, plans, { writePaths: false, removeAliases: [] })) {
    return { kind: "planning" };
  }

  try {
    renameSync(tmpPath, gitmodules);
  } catch {
    return { kind: "io" };
  }
  return { kind: "ok" };
}

function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // best-effort cleanup; never let temp removal mask the primary outcome
  }
}

/**
 * Atomically reconcile OMS-managed `.gitmodules` metadata for the given aliases against the verified
 * post-topology snapshot. All-or-nothing: a deterministic transformation error preserves the original;
 * a transient file write/replacement failure is retried once from a fresh owner-only temp file while
 * the snapshot is unchanged; a detected concurrent edit is never retried. The temp file stays owner-only
 * until it atomically replaces `.gitmodules`, after which the original mode is restored (one retry).
 */
export function reconcileGitmodules(repoRoot: string, plans: AliasMetadataPlan[], snapshot: string): ReconcileResult {
  if (plans.length === 0) return { ok: true, changedFields: new Map() };

  const gitmodules = join(repoRoot, ".gitmodules");
  const aliases = plans.map((p) => p.alias);

  if (readFileOrNull(gitmodules) !== snapshot) {
    return { ok: false, retained: "original", reason: "concurrent edit detected before applying metadata", unapplied: aliases };
  }

  const changedFields = computeChangedFields(repoRoot, snapshot, plans);
  if (changedFields.size === 0) return { ok: true, changedFields };

  let originalMode: number;
  try {
    originalMode = statSync(gitmodules).mode & 0o777;
  } catch {
    return { ok: false, retained: "original", reason: "could not read .gitmodules file mode", unapplied: aliases };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const tmpPath = join(repoRoot, `.gitmodules.oms-${process.pid}-${Date.now()}-${attempt}`);
    const outcome = applyOnce(repoRoot, gitmodules, tmpPath, snapshot, plans);
    if (outcome.kind === "ok") {
      for (let m = 0; m < 2; m++) {
        try {
          chmodSync(gitmodules, originalMode);
          return { ok: true, changedFields };
        } catch {
          if (m === 1) {
            const octal = `0${(originalMode & 0o777).toString(8).padStart(3, "0")}`;
            return {
              ok: false,
              retained: "owner-only",
              reason: "reconciled .gitmodules is left owner-only because its original mode could not be restored",
              unapplied: [],
              chmodCommand: `chmod ${octal} ${shq(gitmodules)}`,
            };
          }
        }
      }
    }
    removeIfPresent(tmpPath);
    if (outcome.kind === "planning") {
      return { ok: false, retained: "original", reason: "a metadata transformation failed; the batch was cancelled", unapplied: aliases };
    }
    if (readFileOrNull(gitmodules) !== snapshot) {
      return { ok: false, retained: "original", reason: "concurrent edit detected before retry", unapplied: aliases };
    }
  }

  return { ok: false, retained: "original", reason: "atomic .gitmodules replacement failed twice", unapplied: aliases };
}
