---
name: oms-workspace
description: Use for ambiguous Git scope, moved pointers, push failures, or repository additions and removals in an OMS workspace.
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  author: oh-my-space
  version: "1.3.0"
  oh-my-space-version: ">=1.0.0-0"
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

## Work in a managed tree

A **managed tree** is a disposable Git worktree at `.oms-tree/<alias>/<task>/`.
It shares the source repository's history and preserves the canonical checkout at `oms/<alias>/`.

1. Use plain Git for source work inside the tree.
   OMS refuses `commit`, `push`, `branch`, `fetch`, `pull`, and `record` there.
2. Push the task branch.
3. Open a pull request.
4. After the pull request merges, run `oms pull <alias>` from the workspace root or canonical checkout.
5. Apply the scope guardrail before a requested `oms record <alias>`.

`oms status --json` reports trees in `trees`.
`oms doctor` reports broken tree links.
Read `oms tree --help` for tree commands and options.
