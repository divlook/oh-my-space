---
name: oms-workspace
description: Use for ambiguous Git scope, moved pointers, push failures, repository registration, or commands across source repositories in OMS.
compatibility: Requires oh-my-space >=1.2.0-0.
metadata:
  author: oh-my-space
  version: "1.4.0"
  oh-my-space-version: ">=1.2.0-0"
---

# OMS workspace scope

Each source repository resides at `oms/<alias>/` as a Git submodule.
The main project stores a **pointer**, also called a gitlink, to each source commit.

## Scope guardrail

- Run `oms status --json` before Git work involving `oms/` to identify the main project and each source repository.
- Treat each `oms/<alias>/` directory as a separate Git repository.
- Use `oms` commands for workflows in `oms/<alias>/`.
- Create main-project commits for existing pointer updates only when the user explicitly runs `oms record <alias>`.

## Choose the repository

1. Read the result of `oms status --json`.
   Identify the workspace root, current alias, and affected repositories.
   Read pointer movement from `root.submodulePointers`.
   Check each source repository's branch, uncommitted changes, and ahead/behind state.
2. Choose the repository that owns the change.
   Source changes belong in `oms/<alias>/`.
   The main project records pointers and repository registration.
3. For a requested pointer commit, use `oms record <alias>`.
   Name several aliases when required.
   Use `--all` only when the request includes every moved pointer.
   Keep pointer commits separate from source commits.

These instructions use `oms status --json` schemaVersion 1.
For another schemaVersion, read `oms status --help` for the installed version's field definitions.

## Add or remove a repository

Registration changes affect `.gitmodules` and the `oms/<alias>` gitlink.
An existing pointer update changes only the recorded source commit.

- Use `oms sync <alias>` to add or refresh a repository.
- Use `oms unsync <alias>` to remove its registration.
- Use `oms record <alias>` only for existing moved pointers.

`sync` and `unsync` commit registration changes by default.
Use `--no-commit` to leave those changes unstaged.
If you choose this mode, commit the registration changes in the main project.
`oms record` refuses additions and removals.
Read `oms sync --help` and `oms unsync --help` before selecting other options.

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
Unavailable targets fail with `oms sync <alias>` guidance.
Do not run `oms sync` unless the request includes repository preparation.

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
   OMS refuses `commit`, `push`, `branch`, `fetch`, `pull`, `record`, and `exec` there.
2. Push the task branch.
3. Open a pull request.
4. After the pull request merges, run `oms pull <alias>` from the workspace root or canonical checkout.
5. Apply the scope guardrail before a requested `oms record <alias>`.

`oms status --json` reports trees in `trees`.
`oms doctor` reports broken tree links.
Read `oms tree --help` for tree commands and options.
