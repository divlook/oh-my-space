#!/usr/bin/env node
import { Command } from "commander";
import { cancel, log } from "@clack/prompts";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./lib/constants.js";
import { readPackageVersion } from "./lib/env.js";
import { assertPromptQueueDrained, canPrompt, guardedSelect, isCancel } from "./lib/prompt-adapter.js";
import { runAgentInstall, runAgentUninstall } from "./lib/agent.js";
import { runSourceBranchDelete as runBranchDelete } from "./lib/branch-delete.js";
import { runSourceBranchClean as runBranchClean } from "./lib/branch-clean.js";
import { runSourceBranchList as runBranchList } from "./lib/branch-list.js";
import { runSourceCheckout as runCheckout, runSourceSwitch as runSwitch } from "./lib/branch-ops.js";
import { runSourceCommit as runCommit } from "./lib/commit.js";
import { runClone } from "./lib/clone-source.js";
import { runIndependentDoctor } from "./lib/doctor.js";
import { runIndependentExec } from "./lib/exec.js";
import {
  agentInstallHelp,
  agentUninstallHelp,
  branchCheckoutHelp,
  branchCleanHelp,
  branchDeleteHelp,
  branchListHelp,
  branchSwitchHelp,
  cloneHelp,
  commitHelp,
  execHelp,
  exitHelp,
  fetchHelp,
  initHelp,
  pullHelp,
  pushHelp,
  migrateHelp,
  removeHelp,
  skillsHelp,
  independentStatusHelp,
  treeAddHelp,
  treeHelp,
  treeListHelp,
  treeRemoveHelp,
  workspaceContextHelp,
} from "./lib/help.js";
import { runInit } from "./lib/init.js";
import { runSourceManage as runManage } from "./lib/manage-ops.js";
import { runMigrate } from "./lib/migrate-source.js";
import { runRemove } from "./lib/remove-source.js";
import { runSkills } from "./lib/skills.js";
import { runIndependentStatus } from "./lib/status.js";
import { runIndependentTreeAdd, runIndependentTreeList, runIndependentTreeRemove } from "./lib/tree-ops.js";
import { runUpdate } from "./lib/update.js";
import { findWorkspaceRoot } from "./lib/workspace-discovery.js";
import { refuseInsideManagedTree } from "./lib/tree-context.js";
import type {
  AgentOptions,
  CheckoutOptions,
  CommitOptions,
  RemoteOptions,
  SourcesOptions,
  StatusOptions,
  UpdateOptions,
} from "./lib/types.js";

type SkillsOptions = { install?: boolean };

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
    `Manage independent Git clones listed in ${MANIFEST_FILENAME} under ${DATA_DIRNAME}/<alias>/.`,
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
    `Check ${MANIFEST_FILENAME}, Git, and source checkout identity.`,
  )
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(runIndependentDoctor());
  });

program
  .command("exec")
  .description("Run a command sequentially in initialized canonical source checkouts without preparation.")
  .usage("[aliases...] [--all] -- <command> [args...]")
  .argument("[aliases...]", "repo aliases to execute in (omit for interactive multi-select)")
  .option("--all", "select every declared source repo in manifest order")
  .addHelpText("after", `${execHelp}${workspaceContextHelp}`)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runIndependentExec(aliases, options, execCommand));
  });

program
  .command("clone")
  .description("Clone missing independent checkouts on the declared or remote default branch.")
  .argument("[aliases...]", "declared aliases to clone (omit for interactive multi-select)")
  .option("--all", "clone missing checkouts for every declaration")
  .option("--list", "print declarations without using Git")
  .addHelpText("after", `${cloneHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions) => {
    await exitWith(runClone(aliases, options));
  });

program
  .command("status")
  .description("Show source branches, changes, and tracking divergence.")
  .argument("[aliases...]", "repo aliases to inspect (omit for all)")
  .option("--all", "inspect every declared source")
  .option("--json", "print machine-readable workspace state (one JSON object on stdout)")
  .addHelpText("after", `${independentStatusHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: StatusOptions) => {
    await exitWith(runIndependentStatus(aliases, options));
  });

program
  .command("commit")
  .description("Commit changes in one source checkout without touching the workspace root.")
  .argument("[alias]", "declared source alias (omit to infer from the current oms/<alias>/ directory)")
  .option("-m, --message <message>", "commit message (repeatable; required only to create a commit)", collectRepeatable, [])
  .addHelpText("after", `${commitHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, options: CommitOptions) => {
    await exitWith(runCommit(alias, options));
  });

program
  .command("migrate")
  .description("Convert a legacy OMS workspace to independent clones.")
  .argument("[aliases...]", "not supported; migration always applies to the entire workspace")
  .option("--dry-run", "preview the plan without changing the workspace")
  .option("--yes", "apply the reviewed plan without prompting")
  .addHelpText("after", `${migrateHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: { dryRun?: boolean; yes?: boolean }) => {
    await exitWith(runMigrate(aliases, options));
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
    { command: branchListCommand, label: "list branches in a source checkout", run: () => runBranchList(undefined) },
    { command: branchSwitchCommand, label: "switch to or create a local branch", run: () => runSwitch(undefined, undefined, {}) },
    { command: branchCheckoutCommand, label: "check out a remote branch", run: () => runCheckout(undefined, undefined) },
    { command: branchDeleteCommand, label: "delete a local branch", run: () => runBranchDelete(undefined, undefined, {}) },
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
  .description("Create a task worktree of an independent checkout at .oms-tree/<alias>/<task>/.")
  .argument("[alias]", "declared source alias (omit to pick interactively)")
  .argument("[task]", "task name; also the branch checked out in the tree")
  .option("--from <ref>", "start point for a new task branch (default: canonical HEAD)")
  .addHelpText("after", `${treeAddHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, task: string | undefined, options: { from?: string }) => {
    await exitWith(runIndependentTreeAdd(alias, task, options));
  });

treeCommand
  .command("list")
  .description("List every managed tree under .oms-tree/ with its branch, dirty, and broken state.")
  .addHelpText("after", `${treeListHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(runIndependentTreeList());
  });

treeCommand
  .command("remove")
  .description("Remove a managed tree's worktree only; the task branch and its commits survive.")
  .argument("[alias]", "alias of the tree to remove (omit to pick interactively)")
  .argument("[task]", "task name of the tree to remove (omit to pick interactively)")
  .option("-f, --force", "remove a dirty worktree or a non-empty foreign directory (branch still survives)")
  .addHelpText("after", `${treeRemoveHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, task: string | undefined, options: { force?: boolean }) => {
    await exitWith(runIndependentTreeRemove(alias, task, options));
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
    "Fast-forward source branches without changing the workspace root.",
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
    "Push branches from verified source checkouts only.",
  )
  .argument("[aliases...]", "declared source aliases to push (omit for interactive multi-select)")
  .option("--all", "push every declared source repo")
  .option("--remote <name>", "remote to push to (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pushHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("push", aliases, options));
  });

program
  .command("remove")
  .description(`Remove verified local checkouts without changing ${MANIFEST_FILENAME}.`)
  .argument("[aliases...]", "declared or verified former aliases to remove")
  .option("--all", "select every declared and verified former checkout")
  .option("--yes", "approve the reviewed plan without the normal prompt")
  .option("--force", "allow discarding working files only")
  .addHelpText("after", `${removeHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: { all?: boolean; force?: boolean; yes?: boolean }) => {
    await exitWith(runRemove(aliases, options));
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
  if (requestedCommand === "sync" || requestedCommand === "unsync" || requestedCommand === "record") {
    console.error("OMS 3.0 uses independent clones. For an existing OMS 2.x workspace, start with 'oms migrate --dry-run'.");
  }
  process.exit(1);
}

await program.parseAsync(cliArgs);
