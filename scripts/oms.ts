#!/usr/bin/env node
import { Command } from "commander";
import { log } from "@clack/prompts";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./lib/constants.js";
import { readPackageVersion } from "./lib/env.js";
import { assertPromptQueueDrained } from "./lib/prompt-adapter.js";
import { runAgentInstall, runAgentUninstall } from "./lib/agent.js";
import { runBranch, runBranchDelete } from "./lib/branch-delete.js";
import { runCheckout, runSwitch } from "./lib/branch-ops.js";
import { runCommit, runRecord } from "./lib/commit.js";
import { runDoctor } from "./lib/doctor.js";
import {
  agentInstallHelp,
  agentUninstallHelp,
  commitHelp,
  exitHelp,
  pullHelp,
  pushHelp,
  recordHelp,
  skillsHelp,
  statusHelp,
  syncHelp,
  unsyncHelp,
} from "./lib/help.js";
import { runInit } from "./lib/init.js";
import { runManage } from "./lib/manage-ops.js";
import { runSync, runUnsync } from "./lib/repo-ops.js";
import { runSkills, skillsForwardedArgs } from "./lib/skills.js";
import { runStatus } from "./lib/status.js";
import { runUpdate } from "./lib/update.js";
import type {
  AgentOptions,
  CheckoutOptions,
  CommitOptions,
  PushOptions,
  RemoteOptions,
  SourcesOptions,
  StatusOptions,
  SyncCommitOptions,
  UnsyncOptions,
  UpdateOptions,
} from "./lib/types.js";

type SkillsOptions = { install?: boolean };

async function exitWith(action: Promise<number>): Promise<void> {
  try {
    const code = await action;
    // A guarded test queue must be fully consumed; leftover responses fail closed (exit 1).
    assertPromptQueueDrained();
    process.exit(code);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const commandNames = new Set([
  "init",
  "doctor",
  "sync",
  "status",
  "commit",
  "record",
  "switch",
  "checkout",
  "branch",
  "fetch",
  "pull",
  "push",
  "unsync",
  "agent",
  "skills",
  "update",
  "help",
]);

const collectRepeatable = (value: string, acc: string[]): string[] => [...acc, value];
const program = new Command();

program
  .name("oms")
  .description(
    `Manage source repositories listed in ${MANIFEST_FILENAME} as git submodules under ${DATA_DIRNAME}/<alias>/.`,
  )
  .version(readPackageVersion())
  .addHelpText("after", exitHelp);

program
  .command("init")
  .description(`Create a starter ${MANIFEST_FILENAME} in the current directory.`)
  .option("--force", `overwrite an existing ${MANIFEST_FILENAME}`)
  .addHelpText("after", exitHelp)
  .action(async (options: { force?: boolean }) => {
    await exitWith(runInit(options));
  });

program
  .command("doctor")
  .description(
    `Check ${MANIFEST_FILENAME}, git availability, and the submodule state of each registered alias.`,
  )
  .addHelpText("after", exitHelp)
  .action(async () => {
    await exitWith(runDoctor());
  });

program
  .command("sync")
  .description(
    `Register each repo as a submodule at ${DATA_DIRNAME}/<alias>/ (or initialize and refresh an existing one), checked out on its baseline branch.`,
  )
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .option("--commit", "create the root topology commit (chore(oms): add ...) without prompting")
  .addHelpText("after", `${syncHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SyncCommitOptions) => {
    await exitWith(runSync(aliases, options));
  });

program
  .command("status")
  .description("Show each submodule's branch, pointer state, dirtiness, and ahead/behind counts.")
  .argument("[aliases...]", "repo aliases to inspect (omit for all)")
  .option("--all", "inspect every registered source repo")
  .option("--json", "print machine-readable workspace state (one JSON object on stdout)")
  .addHelpText("after", `${statusHelp}${exitHelp}`)
  .action(async (aliases: string[], options: StatusOptions) => {
    await exitWith(runStatus(aliases, options));
  });

program
  .command("commit")
  .description("Commit source changes inside the selected submodule only (never the root gitlink).")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .option("-m, --message <message>", "commit message (repeatable; required only to create a commit)", collectRepeatable, [])
  .addHelpText("after", `${commitHelp}${exitHelp}`)
  .action(async (alias: string | undefined, options: CommitOptions) => {
    await exitWith(runCommit(alias, options));
  });

program
  .command("record")
  .description("Commit an existing root gitlink pointer update for the selected submodule (root repo only).")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .addHelpText("after", `${recordHelp}${exitHelp}`)
  .action(async (alias: string | undefined) => {
    await exitWith(runRecord(alias));
  });

program
  .command("switch")
  .description(
    "Switch a submodule to a LOCAL branch, creating it locally if it does not exist yet (no remote required).",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from local branches or create one)")
  .option("--from <ref>", "start point for a new branch (default: current HEAD)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string | undefined, branch: string | undefined, options: CheckoutOptions) => {
    await exitWith(runSwitch(alias, branch, options));
  });

program
  .command("checkout")
  .description(
    "Fetch origin, then check out a REMOTE branch (origin/*) as a local tracking branch.",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "remote branch name (omit to pick from origin/* branches)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string | undefined, branch: string | undefined) => {
    await exitWith(runCheckout(alias, branch));
  });

const branchCommand = program
  .command("branch")
  .description("Manage submodule branches (interactive action selector; currently: delete).")
  .addHelpText("after", exitHelp)
  .action(async () => {
    await exitWith(runBranch(branchCommand));
  });

branchCommand
  .command("delete")
  .description(
    "Delete a LOCAL branch inside one initialized submodule (never a remote branch or the root gitlink).",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from deletable local branches)")
  .option("-f, --force", "force-delete with git branch -D (still respects protected branches)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string | undefined, branch: string | undefined, options: { force?: boolean }) => {
    await exitWith(runBranchDelete(alias, branch, options));
  });

program
  .command("fetch")
  .description("Run git fetch <remote> --prune in each submodule (defaults to origin).")
  .argument("[aliases...]", "repo aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every registered source repo")
  .option("--remote <name>", "remote to fetch (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("fetch", aliases, options));
  });

program
  .command("pull")
  .description(
    "Pull the submodule branch only (git pull --ff-only <remote>); never stages or commits the root gitlink (defaults to origin).",
  )
  .argument("[aliases...]", "repo aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every registered source repo")
  .option("--remote <name>", "remote to pull from (single; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pullHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("pull", aliases, options));
  });

program
  .command("push")
  .description(
    "Push the submodule branch only (creating the remote branch on first push); never stages or commits the root gitlink. Use \"oms record <alias>\" for root pointer commits (defaults to origin).",
  )
  .argument("<aliases...>", "repo aliases to push")
  .option("--commit", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--record", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--remote <name>", "remote to push to (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pushHelp}${exitHelp}`)
  .action(async (aliases: string[], options: PushOptions & RemoteOptions) => {
    await exitWith(runManage("push", aliases, options));
  });

program
  .command("unsync")
  .description(
    `Deinitialize and remove the submodule for each alias (keeps ${MANIFEST_FILENAME} entry).`,
  )
  .argument("[aliases...]", "repo aliases to unsync (omit for interactive multi-select)")
  .option("--all", "unsync every registered source repo")
  .option("--force", "discard uncommitted changes in the submodule")
  .option("--commit", "create the root topology commit (chore(oms): remove ...) without prompting")
  .addHelpText("after", `${unsyncHelp}${exitHelp}`)
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
    await exitWith(runSkills(Boolean(options.install), skillsForwardedArgs()));
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
if (requestedCommand && !requestedCommand.startsWith("-") && !commandNames.has(requestedCommand)) {
  console.error(`error: unknown command '${requestedCommand}'`);
  process.exit(1);
}

await program.parseAsync();
