import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { GITIGNORE_COMMENT, GITIGNORE_ENTRY } from "./constants.js";

/** Submodules live inside the parent's history, so oms/ must not be gitignored. Strip a managed entry. */
export function ensureOmsNotIgnored(repoRoot: string): void {
  const path = join(repoRoot, ".gitignore");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === GITIGNORE_ENTRY || trimmed === `/${GITIGNORE_ENTRY}`) {
      if (out.length > 0 && out[out.length - 1].trim() === GITIGNORE_COMMENT) out.pop();
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (removed) {
    writeFileSync(path, out.join("\n"));
    log.info(`removed ${GITIGNORE_ENTRY} from .gitignore (submodules are tracked, not ignored)`);
  }
}

export function gitignoreIgnoresOms(repoRoot: string): boolean {
  const gi = join(repoRoot, ".gitignore");
  return (
    existsSync(gi)
    && readFileSync(gi, "utf8")
      .split("\n")
      .some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === `/${GITIGNORE_ENTRY}`)
  );
}
