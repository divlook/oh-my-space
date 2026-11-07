import { log } from "@clack/prompts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILENAME } from "./constants.js";
import { runGit, productionGitRunner, type RawGitRunner } from "./git.js";
import { recoveryPreflight } from "./root-tx.js";

export function prepareTopologyMutation(
  repoRoot: string,
  action: "syncing" | "unsyncing",
  runner: RawGitRunner = productionGitRunner,
): { ok: true; bytes: Buffer } | { ok: false; code: number } {
  const recovered = recoveryPreflight(repoRoot);
  if (!recovered.ok) {
    log.error(recovered.reason);
    return { ok: false, code: 2 };
  }
  const conflicts = runGit(repoRoot, ["ls-files", "-u", "--", ".gitmodules"], false, undefined, runner);
  if (!conflicts.success) {
    log.error("Root .gitmodules conflict state could not be inspected. Retry once Git is idle.");
    return { ok: false, code: 2 };
  }
  if (conflicts.stdout.trim()) {
    log.error(`Root .gitmodules is unmerged. Resolve the conflict before ${action}.`);
    return { ok: false, code: 1 };
  }
  try {
    return { ok: true, bytes: readFileSync(join(repoRoot, MANIFEST_FILENAME)) };
  } catch {
    log.error(`${MANIFEST_FILENAME} could not be read; no root changes were made`);
    return { ok: false, code: 2 };
  }
}
