#!/usr/bin/env node
import { Command } from "commander";
import { cancel, log } from "@clack/prompts";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./lib/constants.js";
import { readPackageVersion } from "./lib/env.js";
import { assertPromptQueueDrained, canPrompt, guardedSelect, isCancel } from "./lib/prompt-adapter.js";
import { runAgentInstall, runAgentUninstall } from "./lib/agent.js";
import { runBranchDelete } from "./lib/branch-delete.js";
import { runBranchClean } from "./lib/branch-clean.js";
import { runBranchList } from "./lib/branch-list.js";
import { runCheckout, runSwitch } from "./lib/branch-ops.js";
import { runCommit } from "./lib/commit.js";
import { runRecord } from "./lib/record.js";
import { runDoctor } from "./lib/doctor.js";
import { runExec } from "./lib/exec.js";
import {
  agentInstallHelp,
  agentUninstallHelp,
  branchCheckoutHelp,
  branchCleanHelp,
  branchDeleteHelp,
  branchListHelp,
  branchSwitchHelp,
  commitHelp,
  execHelp,
  exitHelp,
  fetchHelp,
  initHelp,
  pullHelp,
  pushHelp,
  recordHelp,
  skillsHelp,
  statusHelp,
  syncHelp,
  treeAddHelp,
  treeHelp,
  treeListHelp,
  treeRemoveHelp,
  unsyncHelp,
  workspaceContextHelp,
} from "./lib/help.js";
import { runInit } from "./lib/init.js";
import { runManage } from "./lib/manage-ops.js";
import { runSync, runUnsync } from "./lib/repo-ops.js";
import { runSkills } from "./lib/skills.js";
import { runStatus } from "./lib/status.js";
import { runTreeAdd, runTreeList, runTreeRemove } from "./lib/tree-ops.js";
import { runUpdate } from "./lib/update.js";
import { findWorkspaceRoot } from "./lib/workspace-discovery.js";
import { refuseInsideManagedTree } from "./lib/tree-context.js";
import { loadForSubmodules } from "./lib/manifest.js";
import type {
  AgentOptions,
  CheckoutOptions,
  CommitOptions,
  RemoteOptions,
  SourcesOptions,
  StatusOptions,
  SyncCommitOptions,
  UnsyncOptions,
  UpdateOptions,
} from "./lib/types.js";

type SkillsOptions = { install?: boolean };
type PushCliOptions = SourcesOptions & RemoteOptions & { commit?: boolean; record?: boolean };

async function runPush(aliases: string[], options: PushCliOptions): Promise<number> {
  if (options.commit || options.record) {
    const loaded = loadForSubmodules();
    if (!loaded || refuseInsideManagedTree(loaded.repoRoot)) return 1;
    const flag = options.record ? "--record" : "--commit";
    const pushExample = aliases.length > 0 ? `oms push ${aliases.join(" ")}` : "oms push <alias>";
    const recordExample = aliases.length > 0 ? `oms record ${aliases[0]}` : "oms record <alias>";
    log.error(
      `"oms push ${flag}" is not supported. Push the submodule branch with "${pushExample}", then commit the existing root pointer update with "${recordExample}".`,
    );
    return 1;
  }
  return runManage("push", aliases, options);
}

async function exitWith(action: Promise<number>): Promise<void> {
  try {
    const code = await action;
    assertPromptQueueDrained();
    process.exit(code);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const collectRepeatable = (value: string, acc: string[]): string[] => [...acc, value];
const execSeparator = process.argv[2] === "exec" ? process.argv.indexOf("--", 3) : -1;
const execCommand = execSeparator === -1 ? [] : process.argv.slice(execSeparator + 1);
const cliArgs = execSeparator === -1 ? process.argv : process.argv.slice(0, execSeparator);
const program = new Command();

program
  .name("oms")
  .description(
    `Manage source repositories listed in ${MANIFEST_FILENAME} as git submodules under ${DATA_DIRNAME}/<alias>/.`,
  )
  .version(readPackageVersion())
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`);

program
  .command("init")
  .description(`Create a starter ${MANIFEST_FILENAME} in the current directory.`)
  .option("--force", `overwrite an existing ${MANIFEST_FILENAME}`)
  .addHelpText("after", `${initHelp}${exitHelp}`)
  .action(async (options: { force?: boolean }) => {
    await exitWith(runInit(options));
  });

program
  .command("doctor")
  .description(
    `Check ${MANIFEST_FILENAME}, git availability, and the submodule state of each registered alias.`,
  )
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(runDoctor());
  });

program
  .command("exec")
  .description("Run a command sequentially in initialized canonical source checkouts without preparation.")
  .usage("[aliases...] [--all] -- <command> [args...]")
  .argument("[aliases...]", "repo aliases to execute in (omit for interactive multi-select)")
  .option("--all", "select every declared source repo in manifest order")
  .addHelpText("after", `${execHelp}${workspaceContextHelp}`)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runExec(aliases, options, execCommand));
  });

program
  .command("sync")
  .description(
    `Register each repo as a submodule at ${DATA_DIRNAME}/<alias>/ (or initialize and refresh an existing one), checked out on its baseline branch.`,
  )
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .option("--commit", "accepted for compatibility; the root topology commit (chore(oms): add ...) is created by default")
  .option("--no-commit", "leave the root topology changes unstaged instead of committing them")
  .addHelpText("after", `${syncHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SyncCommitOptions) => {
    await exitWith(runSync(aliases, options));
  });

program
  .command("status")
  .description("Show each submodule's branch, pointer state, dirtiness, and ahead/behind counts.")
  .argument("[aliases...]", "repo aliases to inspect (omit for all)")
  .option("--all", "inspect every registered source repo")
  .option("--json", "print machine-readable workspace state (one JSON object on stdout)")
  .addHelpText("after", `${statusHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: StatusOptions) => {
    await exitWith(runStatus(aliases, options));
  });

program
  .command("commit")
  .description("Prepare the selected registration, then commit submodule source changes only (never the root gitlink).")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .option("-m, --message <message>", "commit message (repeatable; required only to create a commit)", collectRepeatable, [])
  .addHelpText("after", `${commitHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, options: CommitOptions) => {
    await exitWith(runCommit(alias, options));
  });

program
  .command("record")
  .description("Commit an existing root gitlink pointer update for the selected submodule (root repo only).")
  .argument("[aliases...]", "registered source aliases (omit to infer from the current oms/<alias>/ directory)")
  .option("--all", "record every moved source repo pointer")
  .addHelpText("after", `${recordHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runRecord(aliases, options));
  });

const branchCommand = program
  .command("branch")
  .description("Inspect, switch, checkout, delete, or clean source branches (interactive action selector).")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(selectBranchAction(branchCommand));
  });

const branchSwitchCommand = branchCommand
  .command("switch")
  .description(
    "Prepare one declared source, then switch to or create a LOCAL branch (no remote required).",
  )
  .argument("[alias]", "declared source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from local branches or create one)")
  .option("--from <ref>", "start point for a new branch (default: current HEAD)")
  .addHelpText("after", `${branchSwitchHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, branch: string | undefined, options: CheckoutOptions) => {
    await exitWith(runSwitch(alias, branch, options));
  });

const branchCheckoutCommand = branchCommand
  .command("checkout")
  .description(
    "Prepare one declared source, fetch origin, then check out a REMOTE branch as a local tracking branch.",
  )
  .argument("[alias]", "declared source alias (omit to pick interactively)")
  .argument("[branch]", "remote branch name (omit to pick from origin/* branches)")
  .addHelpText("after", `${branchCheckoutHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, branch: string | undefined) => {
    await exitWith(runCheckout(alias, branch));
  });

const branchListCommand = branchCommand
  .command("list")
  .description("Prepare one declared source, refresh declared remotes, and list local and remote branches.")
  .argument("[alias]", "declared source alias (the sole alias is selected automatically)")
  .addHelpText("after", `${branchListHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined) => {
    await exitWith(runBranchList(alias));
  });

const branchDeleteCommand = branchCommand
  .command("delete")
  .description(
    "Prepare one declared source, then delete a LOCAL branch (never a remote branch or root topology).",
  )
  .argument("[alias]", "declared source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from deletable local branches)")
  .option("-f, --force", "force-delete with git branch -D (still respects protected branches)")
  .addHelpText("after", `${branchDeleteHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, branch: string | undefined, options: { force?: boolean }) => {
    await exitWith(runBranchDelete(alias, branch, options));
  });

const branchCleanCommand = branchCommand
  .command("clean")
  .description("Confirm deletion of merged local branches in one source repository.")
  .argument("[alias]", "declared source alias (omit to pick interactively)")
  .option("--base <ref>", "existing local or remote-tracking comparison branch")
  .addHelpText("after", branchCleanHelp)
  .action(async (alias: string | undefined, options: { base?: string }) => {
    await exitWith(runBranchClean(alias, options));
  });

async function selectBranchAction(command: Command): Promise<number> {
  const repoRoot = findWorkspaceRoot();
  if (repoRoot !== null && refuseInsideManagedTree(repoRoot)) return 1;
  if (!canPrompt()) {
    command.outputHelp();
    return 1;
  }
  const actions = [
    { command: branchListCommand, label: "list branches in a submodule", run: () => runBranchList(undefined) },
    { command: branchSwitchCommand, label: "switch to or create a local branch in a submodule", run: () => runSwitch(undefined, undefined, {}) },
    { command: branchCheckoutCommand, label: "check out a remote branch in a submodule", run: () => runCheckout(undefined, undefined) },
    { command: branchDeleteCommand, label: "delete a local branch in a submodule", run: () => runBranchDelete(undefined, undefined, {}) },
    { command: branchCleanCommand, label: "clean merged local branches in a source repository", run: () => runBranchClean(undefined, {}) },
  ];
  const choice = await guardedSelect<string>({
    message: "Select a branch action",
    options: actions.map(({ command, label }) => ({ value: command.name(), label })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return 1;
  }
  return actions.find(({ command }) => command.name() === choice)?.run() ?? 1;
}

const treeCommand = program
  .command("tree")
  .description("Create, list, or remove a disposable per-task checkout of a source repository.")
  .addHelpText("after", `${treeHelp}${workspaceContextHelp}${exitHelp}`);

treeCommand
  .command("add")
  .description("Create a per-task worktree of an initialized submodule at .oms-tree/<alias>/<task>/.")
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[task]", "task name; also the branch checked out in the tree")
  .option("--from <ref>", "start point for a new task branch (default: the submodule's current HEAD)")
  .addHelpText("after", `${treeAddHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, task: string | undefined, options: { from?: string }) => {
    await exitWith(runTreeAdd(alias, task, options));
  });

treeCommand
  .command("list")
  .description("List every managed tree under .oms-tree/ with its branch, dirty, and broken state.")
  .addHelpText("after", `${treeListHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(runTreeList());
  });

treeCommand
  .command("remove")
  .description("Remove a managed tree's worktree only; the task branch and its commits survive.")
  .argument("[alias]", "alias of the tree to remove (omit to pick interactively)")
  .argument("[task]", "task name of the tree to remove (omit to pick interactively)")
  .option("-f, --force", "remove a dirty worktree or a non-empty foreign directory (branch still survives)")
  .addHelpText("after", `${treeRemoveHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, task: string | undefined, options: { force?: boolean }) => {
    await exitWith(runTreeRemove(alias, task, options));
  });

program
  .command("fetch")
  .description("Prepare each selected source, then run git fetch <remote> --prune (defaults to origin).")
  .argument("[aliases...]", "declared source aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every declared source repo")
  .option("--remote <name>", "remote to fetch (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${fetchHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("fetch", aliases, options));
  });

program
  .command("pull")
  .description(
    "Prepare each selected source, then pull its submodule branch only; never records the root gitlink.",
  )
  .argument("[aliases...]", "declared source aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every declared source repo")
  .option("--remote <name>", "remote to pull from (single; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pullHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("pull", aliases, options));
  });

program
  .command("push")
  .description(
    "Prepare each registered source, then push its submodule branch only; unregistered aliases are refused.",
  )
  .argument("[aliases...]", "declared source aliases to push (omit for interactive multi-select)")
  .option("--all", "push every declared source repo")
  .option("--commit", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--record", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--remote <name>", "remote to push to (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pushHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: PushCliOptions) => {
    await exitWith(runPush(aliases, options));
  });

program
  .command("unsync")
  .description(
    `Deinitialize and remove the submodule for each alias (keeps ${MANIFEST_FILENAME} entry).`,
  )
  .argument("[aliases...]", "repo aliases to unsync (omit for interactive multi-select)")
  .option("--all", "unsync every registered source repo")
  .option("--force", "discard uncommitted changes in the submodule")
  .option("--commit", "accepted for compatibility; the root topology commit (chore(oms): remove ...) is created by default")
  .option("--no-commit", "leave the root topology changes unstaged instead of committing them")
  .addHelpText("after", `${unsyncHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: UnsyncOptions) => {
    await exitWith(runUnsync(aliases, options));
  });

const agentCommand = program
  .command("agent")
  .description(`Manage OMS agent instruction blocks under ${DATA_DIRNAME}/ (AGENTS.md, CLAUDE.md).`)
  .addHelpText("after", exitHelp);

agentCommand
  .command("install")
  .description(`Install or refresh the marker-managed OMS instruction block in ${DATA_DIRNAME}/AGENTS.md and/or ${DATA_DIRNAME}/CLAUDE.md.`)
  .option("--target <target>", "agents | claude | both (omit to choose interactively)")
  .addHelpText("after", `${agentInstallHelp}${exitHelp}`)
  .action(async (options: AgentOptions) => {
    await exitWith(runAgentInstall(options));
  });

agentCommand
  .command("uninstall")
  .description(`Remove the marker-managed OMS instruction block from ${DATA_DIRNAME}/AGENTS.md and/or ${DATA_DIRNAME}/CLAUDE.md.`)
  .option("--target <target>", "agents | claude | both (omit to choose interactively)")
  .addHelpText("after", `${agentUninstallHelp}${exitHelp}`)
  .action(async (options: AgentOptions) => {
    await exitWith(runAgentUninstall(options));
  });

program
  .command("skills")
  .description("Print the command to install the oms workspace skills, or run it with --install.")
  .option("--install", "delegate to \"npx skills add\" (forwards extra args such as -g, --skill, --list)")
  .allowUnknownOption()
  .argument("[args...]", "extra arguments forwarded to \"npx skills add\" with --install")
  .addHelpText("after", `${skillsHelp}${exitHelp}`)
  .action(async (_args: string[], options: SkillsOptions) => {
    const forwardedArgs = process.argv.slice(3).filter((arg) => arg !== "--install");
    await exitWith(runSkills(Boolean(options.install), forwardedArgs));
  });

program
  .command("update")
  .description("Check for and safely update the oms CLI. Only confident global installs are updated automatically.")
  .option("--check", "check for an available update without mutating the installation")
  .option("--yes", "run a confirmed global update without prompting")
  .addHelpText("after", exitHelp)
  .action(async (options: UpdateOptions) => {
    await exitWith(runUpdate(options));
  });

const requestedCommand = process.argv[2];
const commandNames = new Set([...program.commands.map((command) => command.name()), "help"]);
if (requestedCommand && !requestedCommand.startsWith("-") && !commandNames.has(requestedCommand)) {
  console.error(`error: unknown command '${requestedCommand}'`);
  process.exit(1);
}

await program.parseAsync(cliArgs);
