#!/usr/bin/env node
import { Command } from "commander";
import { log } from "@clack/prompts";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./lib/constants.js";
import { readPackageVersion } from "./lib/env.js";
import { assertPromptQueueDrained } from "./lib/prompt-adapter.js";
import { runAgentInstall, runAgentUninstall } from "./lib/agent.js";
import { runBranch, runBranchDelete } from "./lib/branch-delete.js";
import { runBranchList, runWorktreeBranchList } from "./lib/branch-list.js";
import { runCheckout, runSwitch } from "./lib/branch-ops.js";
import { runCommit, runRecord } from "./lib/commit.js";
import { runDoctor } from "./lib/doctor.js";
import {
  agentInstallHelp,
  agentUninstallHelp,
  commitHelp,
  exitHelp,
  initHelp,
  pullHelp,
  pushHelp,
  recordHelp,
  skillsHelp,
  statusHelp,
  syncHelp,
  unsyncHelp,
  workspaceContextHelp,
} from "./lib/help.js";
import { runInit } from "./lib/init.js";
import { runManage } from "./lib/manage-ops.js";
import { runModeSwitch } from "./lib/mode-switch.js";
import { loadRepos } from "./lib/manifest.js";
import { runSync, runUnsync } from "./lib/repo-ops.js";
import { runSkills, skillsForwardedArgs } from "./lib/skills.js";
import { runStatus } from "./lib/status.js";
import { runUpdate } from "./lib/update.js";
import { withWorkspaceMutation } from "./lib/workspace-mutation.js";
import { runWorktreeAdd, runWorktreeList, runWorktreeMove, runWorktreeRemove } from "./lib/worktree-ops.js";
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
  "mode",
  "worktree",
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
const mutate = (operation: string, action: () => Promise<number>): Promise<number> =>
  withWorkspaceMutation(operation, action);
const runModeAwareBranchList = (alias: string | undefined): Promise<number> => {
  const loaded = loadRepos();
  if (!loaded) return Promise.resolve(1);
  return loaded.mode === "worktree"
    ? runWorktreeBranchList(alias)
    : mutate("branch list", () => runBranchList(alias));
};
const program = new Command();

program
  .name("oms")
  .description(
    `Manage multi-repo workspaces in submodule or worktree mode from ${MANIFEST_FILENAME}.`,
  )
  .version(readPackageVersion())
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`);

program
  .command("init")
  .description(`Create a starter ${MANIFEST_FILENAME} in the current directory.`)
  .option("--force", `overwrite an existing ${MANIFEST_FILENAME}`)
  .option("--mode <mode>", "workspace mode: submodule or worktree")
  .addHelpText("after", `${initHelp}${exitHelp}`)
  .action(async (options: { force?: boolean; mode?: string }) => {
    await exitWith(runInit(options));
  });

program
  .command("doctor")
  .description(
    `Check ${MANIFEST_FILENAME}, Git, ownership, transition, and mode-specific repository state.`,
  )
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(runDoctor());
  });

program
  .command("sync")
  .description(
    `Provision or refresh each alias using the workspace's submodule or worktree mode.`,
  )
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .option("--commit", "create the root topology commit (chore(oms): add ...) without prompting")
  .addHelpText("after", `${syncHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SyncCommitOptions) => {
    await exitWith(options.list ? runSync(aliases, options) : mutate("sync", () => runSync(aliases, options)));
  });

program
  .command("status")
  .description("Show mode-aware repository, pointer, common-repository, and worktree state.")
  .argument("[aliases...]", "repo aliases to inspect (omit for all)")
  .option("--all", "inspect every registered source repo")
  .option("--json", "print machine-readable workspace state (one JSON object on stdout)")
  .addHelpText("after", `${statusHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: StatusOptions) => {
    await exitWith(runStatus(aliases, options));
  });

program
  .command("commit")
  .description("Commit source changes in one submodule alias or managed alias/name checkout.")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .option("-m, --message <message>", "commit message (repeatable; required only to create a commit)", collectRepeatable, [])
  .addHelpText("after", `${commitHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, options: CommitOptions) => {
    await exitWith(mutate("commit", () => runCommit(alias, options)));
  });

program
  .command("record")
  .description("Commit an existing root gitlink pointer update for the selected submodule (root repo only).")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .addHelpText("after", `${recordHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined) => {
    await exitWith(mutate("record", () => runRecord(alias)));
  });

const worktreeCommand = program
  .command("worktree")
  .description("Create, inspect, move, or remove named managed worktrees.")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`);

worktreeCommand
  .command("add")
  .description("Create an attached managed worktree for a local, remote, or new branch.")
  .argument("[alias]", "repository alias")
  .argument("[branch]", "local branch name")
  .option("--name <name>", "portable checkout name (defaults to a branch-derived slug)")
  .option("--from <ref>", "start point when creating a new branch")
  .option("--remote <name>", "declared remote to refresh and inspect (default: origin)")
  .addHelpText(
    "after",
    `\nFailure recovery: a branch created before worktree registration is retained. OMS removes only the empty directory created by that invocation; retry the same command, or run "oms doctor" when a registration remains.${workspaceContextHelp}${exitHelp}`,
  )
  .action(async (alias: string | undefined, branch: string | undefined, options: { name?: string; from?: string; remote?: string }) => {
    await exitWith(mutate("worktree add", () => runWorktreeAdd(alias, branch, options)));
  });

const modeCommand = program
  .command("mode")
  .description("Inspect or explicitly switch the workspace-wide repository mode.")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`);

modeCommand
  .command("switch")
  .description("Switch between submodule and worktree topology through a resumable transition.")
  .argument("<mode>", "target mode: submodule or worktree")
  .option("--sync", "provision target-mode topology as part of the transition")
  .option("--no-sync", "stop after transition without target-mode topology")
  .option("--force", "discard disclosed managed local state; never bypass ownership, external, or lock boundaries")
  .option("--commit", "create the scoped root transition commit")
  .option("--preserve-local", "preserve non-reconstructible local source state in staged target storage")
  .option("--source <target>", "worktree source as alias/name (repeatable)", collectRepeatable, [])
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async (mode: string, raw: { sync?: boolean; force?: boolean; commit?: boolean; preserveLocal?: boolean; source?: string[] }) => {
    await exitWith(withWorkspaceMutation("mode switch", () => runModeSwitch(mode, {
      ...raw,
      sync: process.argv.includes("--sync"),
      noSync: process.argv.includes("--no-sync"),
    }), { allowBootstrapWithoutSubmoduleRoot: true, recoverModeSwitch: true }));
  });

worktreeCommand
  .command("list")
  .description("List declared repositories plus managed and external linked worktrees.")
  .argument("[alias]", "repository alias (omit for all)")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined) => {
    await exitWith(runWorktreeList(alias));
  });

worktreeCommand
  .command("move")
  .description("Move a managed worktree to another portable name without changing its branch.")
  .argument("<target>", "managed target as alias/name")
  .argument("<new-name>", "new portable worktree name")
  .addHelpText(
    "after",
    `\nFailure recovery: Git owns the path and registration transition. OMS never guesses a filesystem rollback; inspect "oms worktree list <alias>", retry, or run "oms doctor".${workspaceContextHelp}${exitHelp}`,
  )
  .action(async (target: string, newName: string) => {
    await exitWith(mutate("worktree move", () => runWorktreeMove(target, newName)));
  });

worktreeCommand
  .command("remove")
  .description("Remove a managed checkout while preserving its local branch.")
  .argument("<target>", "managed target as alias/name")
  .option("--force", "discard reviewed local checkout data")
  .addHelpText(
    "after",
    `\nFailure recovery: the local branch is always retained. If Git changes only the path or registration, inspect "oms worktree list <alias>" and retry; use "oms doctor" for ambiguous state.${workspaceContextHelp}${exitHelp}`,
  )
  .action(async (target: string, options: { force?: boolean }) => {
    await exitWith(mutate("worktree remove", () => runWorktreeRemove(target, options)));
  });

const branchCommand = program
  .command("branch")
  .description("Inspect or delete alias-scoped branches, or switch/checkout one selected source target.")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async () => {
    await exitWith(mutate("branch", () => runBranch(branchCommand)));
  });

branchCommand
  .command("switch")
  .description(
    "Switch one submodule alias or managed alias/name target to a local branch.",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from local branches or create one)")
  .option("--from <ref>", "start point for a new branch (default: current HEAD)")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, branch: string | undefined, options: CheckoutOptions) => {
    await exitWith(mutate("branch switch", () => runSwitch(alias, branch, options)));
  });

branchCommand
  .command("checkout")
  .description(
    "Fetch a declared remote, then check out its branch in one source target.",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "remote branch name (omit to pick from origin/* branches)")
  .option("--remote <name>", "declared remote to fetch and track (default: origin)")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, branch: string | undefined, options: { remote?: string }) => {
    await exitWith(mutate("branch checkout", () => runCheckout(alias, branch, options)));
  });

branchCommand
  .command("list")
  .description("Prepare one submodule, refresh declared remotes, and list local and remote branches.")
  .argument("[alias]", "declared source alias (the sole alias is selected automatically)")
  .addHelpText(
    "after",
    `\nBehavior:\n  Initializes safe existing registration automatically; an unregistered alias requires an accepted sync.\n  Reconciles and fetches every oms.yaml remote with prune, retries once, then shows cached refs as stale.\n  Baseline state is known, incomplete, or unknown. Listing never switches or mutates a branch or root gitlink.\n  Exit 0 includes degraded remote results; exit 1 is selection/preparation refusal; exit 2 is initialization/local inspection failure.\n\nExamples:\n  $ oms branch list api\n  $ oms branch list\n${workspaceContextHelp}${exitHelp}`,
  )
  .action(async (alias: string | undefined) => {
    await exitWith(runModeAwareBranchList(alias));
  });

branchCommand
  .command("delete")
  .description(
    "Delete a LOCAL branch inside one initialized submodule (never a remote branch or the root gitlink).",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from deletable local branches)")
  .option("-f, --force", "force-delete with git branch -D (still respects protected branches)")
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async (alias: string | undefined, branch: string | undefined, options: { force?: boolean }) => {
    await exitWith(mutate("branch delete", () => runBranchDelete(alias, branch, options)));
  });

program
  .command("fetch")
  .description("Fetch declared remotes at alias scope without moving managed checkouts.")
  .argument("[aliases...]", "repo aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every registered source repo")
  .option("--remote <name>", "remote to fetch (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(mutate("fetch", () => runManage("fetch", aliases, options)));
  });

program
  .command("pull")
  .description(
    "Fast-forward one submodule alias or managed alias/name target; worktree --all aggregates managed targets.",
  )
  .argument("[aliases...]", "repo aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every registered source repo")
  .option("--remote <name>", "remote to pull from (single; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pullHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(mutate("pull", () => runManage("pull", aliases, options)));
  });

program
  .command("push")
  .description(
    "Push one submodule alias or managed alias/name target to declared remotes.",
  )
  .argument("[aliases...]", "repo aliases or managed alias/name targets to push")
  .option("--commit", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--record", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--remote <name>", "remote to push to (repeatable; omit to choose interactively)", collectRepeatable, [])
  .addHelpText("after", `${pushHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: PushOptions & RemoteOptions) => {
    await exitWith(mutate("push", () => runManage("push", aliases, options)));
  });

program
  .command("unsync")
  .description(
    `Remove each alias's current-mode storage while keeping its ${MANIFEST_FILENAME} entry.`,
  )
  .argument("[aliases...]", "repo aliases to unsync (omit for interactive multi-select)")
  .option("--all", "unsync every registered source repo")
  .option("--force", "discard disclosed managed local state (never external, locked, foreign, or symlinked state)")
  .option("--commit", "submodule mode only: create the root topology commit (chore(oms): remove ...) without prompting")
  .addHelpText("after", `${unsyncHelp}${workspaceContextHelp}${exitHelp}`)
  .action(async (aliases: string[], options: UnsyncOptions) => {
    await exitWith(mutate("unsync", () => runUnsync(aliases, options)));
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
    await exitWith(mutate("agent install", () => runAgentInstall(options)));
  });

agentCommand
  .command("uninstall")
  .description(`Remove the marker-managed OMS instruction block from ${DATA_DIRNAME}/AGENTS.md and/or ${DATA_DIRNAME}/CLAUDE.md.`)
  .option("--target <target>", "agents | claude | both (omit to choose interactively)")
  .addHelpText("after", `${agentUninstallHelp}${exitHelp}`)
  .action(async (options: AgentOptions) => {
    await exitWith(mutate("agent uninstall", () => runAgentUninstall(options)));
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
