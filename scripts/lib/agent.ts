import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancel, isCancel, log, select } from "@clack/prompts";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./constants.js";
import { findWorkspaceRoot } from "./git.js";
import type { AgentOptions, AgentTarget } from "./types.js";

const OMS_MARKER_START = "<!-- OMS START -->";
const OMS_MARKER_END = "<!-- OMS END -->";

/** Canonical scope-guardrail kernel, single-sourced into the marker block and each published SKILL.md. */
const OMS_SCOPE_GUARDRAIL = `- Run \`oms status --json\` before Git work involving \`oms/\` to read root versus submodule state.
- Treat each \`oms/<alias>/\` directory as a separate Git repository.
- Use \`oms\` commands for scoped submodule workflows; do not guess root repository versus submodule Git scope.
- Do not create root commits for existing submodule pointer updates unless the user explicitly runs \`oms record <alias>\`.`;

/** Concise, durable agent rules; detailed usage is deferred to CLI help. The marker's own --help line stays outside the kernel constant. */
const OMS_INSTRUCTION_BLOCK = `${OMS_MARKER_START}
## OMS Workspace Rules

${OMS_SCOPE_GUARDRAIL}
- Check \`oms --help\` and \`oms <command> --help\` for exact command usage.
${OMS_MARKER_END}`;

type ManagedBlockState =
  | { kind: "missing" }
  | { kind: "valid"; before: string; after: string }
  | { kind: "malformed"; reason: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Classify the OMS marker state of a file: missing, exactly one valid block, or malformed. */
function analyzeManagedBlock(content: string): ManagedBlockState {
  const starts = countOccurrences(content, OMS_MARKER_START);
  const ends = countOccurrences(content, OMS_MARKER_END);
  if (starts === 0 && ends === 0) return { kind: "missing" };
  if (starts !== 1 || ends !== 1) {
    return { kind: "malformed", reason: "expected exactly one matched OMS START/END marker pair" };
  }
  const startIdx = content.indexOf(OMS_MARKER_START);
  const endIdx = content.indexOf(OMS_MARKER_END);
  if (endIdx < startIdx) {
    return { kind: "malformed", reason: "OMS END marker appears before OMS START" };
  }
  return {
    kind: "valid",
    before: content.slice(0, startIdx),
    after: content.slice(endIdx + OMS_MARKER_END.length),
  };
}

/** Collapse trailing newlines to exactly one. */
function normalizeTrailingNewline(content: string): string {
  return `${content.replace(/\n+$/, "")}\n`;
}

/** Compute the post-install content for a target file: create, append after two blank lines, or replace. */
function installManagedBlock(existing: string | null): string {
  if (existing === null || existing.trim() === "") return `${OMS_INSTRUCTION_BLOCK}\n`;
  const state = analyzeManagedBlock(existing);
  if (state.kind === "valid") {
    return normalizeTrailingNewline(`${state.before}${OMS_INSTRUCTION_BLOCK}${state.after}`);
  }
  // Non-empty file with no block: append after two blank lines, preserving existing content.
  return `${existing.replace(/\n+$/, "")}\n\n\n${OMS_INSTRUCTION_BLOCK}\n`;
}

type AgentFile = { path: string; rel: string };

function agentTargetFiles(repoRoot: string, target: AgentTarget): AgentFile[] {
  const names = target === "agents" ? ["AGENTS.md"] : target === "claude" ? ["CLAUDE.md"] : ["AGENTS.md", "CLAUDE.md"];
  return names.map((name) => ({
    path: join(repoRoot, DATA_DIRNAME, name),
    rel: `${DATA_DIRNAME}/${name}`,
  }));
}

/** Resolve the install/uninstall target: explicit --target, interactive prompt, or non-interactive failure. */
async function resolveAgentTarget(target: string | undefined): Promise<AgentTarget | null> {
  if (target !== undefined) {
    if (target !== "agents" && target !== "claude" && target !== "both") {
      log.error(`Invalid --target "${target}". Use --target agents|claude|both.`);
      return null;
    }
    return target;
  }
  if (!process.stdin.isTTY) {
    log.error(`--target is required in a non-interactive shell. Pass --target agents|claude|both.`);
    return null;
  }
  const choice = await select({
    message: "Which instruction file(s) should OMS manage?",
    options: [
      { value: "agents", label: `${DATA_DIRNAME}/AGENTS.md` },
      { value: "claude", label: `${DATA_DIRNAME}/CLAUDE.md` },
      { value: "both", label: `${DATA_DIRNAME}/AGENTS.md + ${DATA_DIRNAME}/CLAUDE.md` },
    ],
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice as AgentTarget;
}

/** Validate that no selected file has malformed markers before any write (atomic pre-write check). */
function validateAgentFiles(files: AgentFile[], action: string): boolean {
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    const state = analyzeManagedBlock(readFileSync(file.path, "utf8"));
    if (state.kind === "malformed") {
      log.error(`${file.rel}: ${state.reason}. Fix the OMS markers, then retry. No files were ${action}.`);
      return false;
    }
  }
  return true;
}

export async function runAgentInstall(options: AgentOptions): Promise<number> {
  const repoRoot = findWorkspaceRoot();
  if (!repoRoot) {
    log.error(`Could not find ${MANIFEST_FILENAME} in the current directory or its parents.`);
    return 1;
  }
  const target = await resolveAgentTarget(options.target);
  if (!target) return 1;
  const files = agentTargetFiles(repoRoot, target);

  if (!validateAgentFiles(files, "modified")) return 1;

  mkdirSync(join(repoRoot, DATA_DIRNAME), { recursive: true });
  for (const file of files) {
    const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
    writeFileSync(file.path, installManagedBlock(existing));
    log.success(`${file.rel}: OMS instructions installed.`);
  }
  log.info("OMS instruction files are not staged; review and commit them yourself.");
  return 0;
}

export async function runAgentUninstall(options: AgentOptions): Promise<number> {
  const repoRoot = findWorkspaceRoot();
  if (!repoRoot) {
    log.error(`Could not find ${MANIFEST_FILENAME} in the current directory or its parents.`);
    return 1;
  }
  const target = await resolveAgentTarget(options.target);
  if (!target) return 1;
  const files = agentTargetFiles(repoRoot, target);

  if (!validateAgentFiles(files, "modified")) return 1;

  for (const file of files) {
    if (!existsSync(file.path)) {
      log.info(`${file.rel}: no OMS block found.`);
      continue;
    }
    const state = analyzeManagedBlock(readFileSync(file.path, "utf8"));
    if (state.kind !== "valid") {
      // missing here; malformed was already rejected by the pre-write validation above.
      log.info(`${file.rel}: no OMS block found.`);
      continue;
    }
    const remaining = state.before + state.after;
    if (remaining.trim() === "") {
      rmSync(file.path);
      log.success(`${file.rel}: removed OMS block and deleted the now-empty file.`);
    } else {
      writeFileSync(file.path, normalizeTrailingNewline(remaining));
      log.success(`${file.rel}: removed OMS block.`);
    }
  }
  return 0;
}
