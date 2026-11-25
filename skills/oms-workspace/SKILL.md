---
name: oms-workspace
description: Use for ambiguous Git scope, missing or legacy OMS checkouts, commands across sources, or work inside managed trees.
compatibility: Requires oh-my-space >=3.0.0-0.
metadata:
  author: oh-my-space
  version: "2.0.0"
  oh-my-space-version: ">=3.0.0-0"
---

# OMS workspace scope

Each source repository resides at `oms/<alias>/` as an independent Git clone.
The workspace root shares declarations in `oms.yaml`, not a set of source commits.

## Scope guardrail

- Run `oms status --json` before Git work involving `oms/` and check `schemaVersion: 2`. Use `oms status --help` for the installed version's fields.
- Choose the repository that owns the change: the workspace root for shared files, or the independent `oms/<alias>/` checkout for source work.
- Commit and push in the intended source checkout without a root pointer step.
- Use plain Git inside managed trees at `.oms-tree/<alias>/<task>/`.

## Choose the repository

1. Read `workspaceRoot`, `currentAlias`, and the selected entries in `repos`.
2. Check the source branch, uncommitted changes, tracking state, and errors before changing Git scope.
3. Use `oms <command> --help` for the installed CLI's usage and exit behavior.

## Provision or remove a checkout

- Use `oms clone <alias>` to provision a declared, genuinely missing source.
- Request authorization before `oms remove <alias>`; it deletes the selected local checkout, not its declaration.
- Use `oms migrate --dry-run` to inspect legacy data. Do not provision or remove a legacy path in its place.

## Run commands across source repositories

A **canonical checkout** is the declared source repository at `oms/<alias>/`.
Use `oms exec` for requested tests, builds, or inspections across canonical checkouts.
For work inside a managed tree, run the command directly inside that tree.
`oms exec` never substitutes a managed tree for a canonical checkout.

1. Read `oms exec --help` for the installed command contract.
2. Select the aliases that the request includes.
   Use `--all` only when the request includes every declared repository.
   Name aliases explicitly in non-interactive sessions.
3. Run `oms exec <alias> [aliases...] -- <command> [args...]` from the workspace root.
   The first `--` separates OMS arguments from the executable and its arguments.
   OMS passes the command arguments unchanged.
   Invoke a shell explicitly when the requested command needs shell syntax.
4. Read the result for every selected alias.
   Check the OMS exit code.

OMS runs one child process at a time.
Each child process runs the supplied command in the selected canonical checkout.
OMS does not prepare targets.
For missing targets, OMS prints `oms clone <alias>` guidance. Do not provision unless the request includes it.

- Exit `0` means that every selected target succeeded.
- Exit `1` means a usage, workspace, or selection error.
- Exit `2` means a command or target failure. Later eligible targets still run.
- Exit `130` means interruption. Later targets do not run.

Ctrl+C interrupts the active child process.
OMS waits for that child process to finish.
Child processes can change files, Git state, or remote services.
OMS preserves their effects after failure or interruption.
Child processes consume standard input sequentially.
OMS does not replay piped input for each repository.

## Work in a managed tree

A **managed tree** is a disposable Git worktree at `.oms-tree/<alias>/<task>/`.
It shares the source repository's history and preserves the canonical checkout at `oms/<alias>/`.

1. Use plain Git for source work inside the tree.
   OMS refuses `commit`, `push`, `branch`, `fetch`, `pull`, and `exec` there.
2. Push the task branch.
3. Open a pull request.
4. After the pull request merges, run `oms pull <alias>` from the workspace root or canonical checkout.

`oms status --json` reports trees in `trees`.
`oms doctor` reports broken tree links.
Read `oms tree --help` for tree commands and options.
