import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancel, log } from "@clack/prompts";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./constants.js";
import { findWorkspaceRoot } from "./workspace-discovery.js";
import type { AgentOptions, AgentTarget } from "./types.js";
import { canPrompt, guardedSelect, isCancel } from "./prompt-adapter.js";

const OMS_MARKER_START = "<!-- OMS START -->";
const OMS_MARKER_END = "<!-- OMS END -->";

const OMS_SCOPE_GUARDRAIL = `- Run \`oms status --json\` before Git work involving \`oms/\` to identify the main project and each source repository.
- Treat each \`oms/<alias>/\` directory as a separate Git repository.
- Use \`oms\` commands for workflows in \`oms/<alias>/\`.
- Create main-project commits for existing pointer updates only when the user explicitly runs \`oms record <alias>\`.`;

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

export function analyzeManagedBlock(content: string): ManagedBlockState {
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

function normalizeTrailingNewline(content: string): string {
  return `${content.replace(/\n+$/, "")}\n`;
}

export function installManagedBlock(existing: string | null): string {
  if (existing === null || existing.trim() === "") return `${OMS_INSTRUCTION_BLOCK}\n`;
  const state = analyzeManagedBlock(existing);
  if (state.kind === "malformed") throw new Error(state.reason);
  if (state.kind === "valid") {
    return normalizeTrailingNewline(`${state.before}${OMS_INSTRUCTION_BLOCK}${state.after}`);
  }
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

async function resolveAgentTarget(target: string | undefined): Promise<AgentTarget | null> {
  if (target !== undefined) {
    if (target !== "agents" && target !== "claude" && target !== "both") {
      log.error(`Invalid --target "${target}". Use --target agents|claude|both.`);
      return null;
    }
    return target;
  }
  if (!canPrompt()) {
    log.error(`--target is required in a non-interactive shell. Pass --target agents|claude|both.`);
    return null;
  }
  const choice = await guardedSelect<AgentTarget>({
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
  return choice;
}

type AgentEdit = AgentFile & { content: string | null; state: ManagedBlockState };

function planAgentEdits(files: AgentFile[]): AgentEdit[] | null {
  const edits = files.map((file) => {
    const content = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
    return { ...file, content, state: analyzeManagedBlock(content ?? "") };
  });
  for (const edit of edits) {
    if (edit.state.kind === "malformed") {
      log.error(`${edit.rel}: ${edit.state.reason}. Fix the OMS markers, then retry. No files were modified.`);
      return null;
    }
  }
  return edits;
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

  const edits = planAgentEdits(files);
  if (!edits) return 1;

  mkdirSync(join(repoRoot, DATA_DIRNAME), { recursive: true });
  for (const file of edits) {
    writeFileSync(file.path, installManagedBlock(file.content));
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

  const edits = planAgentEdits(files);
  if (!edits) return 1;

  for (const file of edits) {
    const state = file.state;
    if (state.kind !== "valid") {
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
