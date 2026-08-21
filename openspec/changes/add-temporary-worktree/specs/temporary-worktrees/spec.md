# Delta: temporary-worktrees

## Purpose

Disposable per-task Git worktrees layered on an initialized source submodule, so several tasks can proceed in one repository at once without registering task-specific aliases, cloning extra copies, or creating root topology changes.

## ADDED Requirements

### Requirement: Managed tree creation

`oms tree add <alias> <task>` SHALL create a Git worktree of the initialized submodule `oms/<alias>/` at `<workspace-root>/.oms-tree/<alias>/<task>/`, attached to that submodule's existing Git directory. The task name SHALL be a valid branch name without path separators. When the `<task>` branch does not exist, it SHALL be created at the canonical checkout's current HEAD, or at the commit named by `--from <ref>` when that option is given, and checked out in the new worktree. When the branch already exists, the worktree SHALL check it out at its existing tip without creating a commit, and an explicit `--from` SHALL fail rather than move the branch. Creation from an initialized submodule SHALL require no network access. Creation SHALL NOT attach a detached canonical checkout to a branch, prompt about it, or move its working tree: the start point is the current HEAD commit and the canonical checkout is left exactly as it was. On success the command SHALL print a one-line confirmation naming the alias and the task.

#### Scenario: New task branch starts at the canonical HEAD

- **WHEN** alias `api` is an initialized submodule whose canonical checkout is at commit `X`
- **AND** branch `fix-auth` does not exist
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** a worktree exists at `.oms-tree/api/fix-auth/` with branch `fix-auth` created at `X` and checked out
- **AND** the canonical checkout `oms/api/` keeps its branch and commit

#### Scenario: Start point override with `--from`

- **WHEN** the user runs `oms tree add api fix-auth --from origin/feature`
- **AND** branch `fix-auth` does not exist
- **THEN** branch `fix-auth` is created at the tip of `origin/feature` and checked out in the new worktree

#### Scenario: Existing branch resumes at its tip

- **WHEN** branch `fix-auth` already exists at commit `Y`
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the worktree is created with `fix-auth` checked out at `Y`
- **AND** no new commit is created and the canonical checkout is unchanged

#### Scenario: Detached canonical HEAD starts the task branch at HEAD

- **WHEN** the canonical checkout of alias `api` is in detached HEAD at commit `X`
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the worktree is created with branch `fix-auth` at `X`
- **AND** the canonical checkout remains in detached HEAD at `X`
- **AND** no prompt is presented and no branch is created or switched in the canonical checkout

#### Scenario: Creation prints a one-line confirmation

- **WHEN** `oms tree add api fix-auth` completes successfully
- **THEN** the command prints a one-line confirmation naming the alias and the task

#### Scenario: `--from` with an existing branch fails

- **WHEN** branch `fix-auth` already exists
- **AND** the user runs `oms tree add api fix-auth --from origin/feature`
- **THEN** the command fails before creating any worktree
- **AND** the branch tip is unchanged

#### Scenario: Branch checked out elsewhere fails

- **WHEN** branch `fix-auth` is already checked out in the canonical checkout or in another worktree
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the command fails with Git's refusal surfaced
- **AND** no directory is created under `.oms-tree/`

#### Scenario: Registered but uninitialized alias is initialized first

- **WHEN** the selected alias has a root gitlink and `.gitmodules` registration but is not initialized
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the submodule is initialized without creating or staging root topology
- **AND** the worktree is created afterwards

#### Scenario: Unregistered alias is refused without an interactive offer

- **WHEN** the selected alias is declared in `oms.yaml` but not registered
- **AND** stdin is non-interactive
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the command exits non-zero without creating root topology or a worktree
- **AND** names `oms sync <alias>` as the command that registers the alias

#### Scenario: Unknown alias fails

- **WHEN** the user runs `oms tree add missing fix-auth`
- **AND** `missing` is not declared by the selected manifest
- **THEN** the command fails with an invalid-alias error and creates nothing

#### Scenario: Invalid task name fails

- **WHEN** the task name contains a path separator or is not a valid branch name
- **THEN** `oms tree add` fails with an actionable message naming the task-name rule
- **AND** nothing is created under `.oms-tree/`

#### Scenario: Existing tree path refuses a duplicate

- **WHEN** `.oms-tree/api/fix-auth/` already exists as an inventory entry, whether a registered worktree or a foreign directory
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the command fails instead of overwriting the directory
- **AND** the message points to the existing tree and to `oms tree remove`

#### Scenario: Creation succeeds offline

- **WHEN** alias `api` is initialized and no remote is reachable
- **AND** the user runs `oms tree add api fix-auth`
- **THEN** the worktree is created from the submodule's local Git directory

#### Scenario: Omitted arguments prompt interactively and fail non-interactively

- **WHEN** the user runs `oms tree add` in an interactive terminal without an alias or task
- **THEN** the command prompts for the missing values
- **WHEN** the same command runs in a non-interactive shell
- **THEN** it fails with a usage error naming the required arguments

### Requirement: Managed tree location and root hygiene

All managed trees SHALL live under `<workspace-root>/.oms-tree/`. OMS SHALL keep `.oms-tree/` out of the root repository's untracked files through the root's local exclude file (`.git/info/exclude`), idempotently, and SHALL NOT track the directory in root history. Managed-tree lifecycle operations SHALL NOT modify `.gitmodules`, root gitlinks, the root index, or root HEAD. Removing the last inventory entry SHALL delete the empty `<workspace-root>/.oms-tree/` directory while leaving the local exclude entry in place.

#### Scenario: Local exclude entry is added idempotently

- **WHEN** the first managed tree is created
- **THEN** the root's `.git/info/exclude` contains a `.oms-tree/` entry
- **AND** creating another tree does not add a duplicate entry

#### Scenario: Root working tree stays clean

- **WHEN** a managed tree contains files and commits
- **THEN** `git status` at the workspace root reports no untracked `.oms-tree/` path and no submodule pointer change caused by the tree

#### Scenario: Tree lifecycle creates no root topology

- **WHEN** `oms tree add` or `oms tree remove` completes
- **THEN** `.gitmodules`, the root index, and root HEAD are unchanged

#### Scenario: Last entry removal deletes the empty namespace root

- **WHEN** the last inventory entry under `.oms-tree/` is removed
- **THEN** the `<workspace-root>/.oms-tree/` directory no longer exists
- **AND** the root's `.git/info/exclude` entry remains

### Requirement: Managed tree inventory

OMS SHALL treat `<workspace-root>/.oms-tree/` as its own namespace: the inventory SHALL combine the `<alias>/<task>` entries discovered on the filesystem with the worktrees that `git worktree list --porcelain` reports under `.oms-tree/` for every submodule Git directory that can be located, regardless of whether the alias is still declared in the manifest. `oms tree list` SHALL report every inventory entry with its alias, task, branch, and dirty state, SHALL mark an entry whose worktree link is broken, and SHALL report an entry that is not a registered worktree — a foreign directory — with an error state. An entry's dirty state SHALL count staged, unstaged, and untracked changes.

#### Scenario: Trees are listed with their state

- **WHEN** two managed trees exist
- **THEN** `oms tree list` reports each tree's alias, task, branch, and dirty state

#### Scenario: No trees is an informative no-op

- **WHEN** no inventory entries exist
- **THEN** `oms tree list` reports that none exist and exits 0

#### Scenario: Broken worktree link is marked

- **WHEN** a managed tree's worktree link is broken, for example after the workspace root moved
- **THEN** `oms tree list` marks that tree as broken instead of omitting it

#### Scenario: Tree of an undeclared alias stays listed and removable

- **WHEN** a managed tree exists at `.oms-tree/api/fix-auth/`
- **AND** alias `api` is no longer declared in `oms.yaml`
- **THEN** `oms tree list` still reports the tree
- **AND** `oms tree remove api fix-auth` removes it

#### Scenario: Foreign directory is reported as an error entry

- **WHEN** `.oms-tree/api/stray/` exists but is not a registered worktree of any submodule
- **THEN** `oms tree list` reports it as an inventory entry with a non-null error stating that it is not a registered worktree

### Requirement: Managed tree removal

`oms tree remove <alias> <task>` SHALL remove the inventory entry at `.oms-tree/<alias>/<task>/` and SHALL preserve the `<task>` branch and its commits when the branch exists. It SHALL refuse a dirty worktree unless `--force` is given, reporting the preserved state. It SHALL also remove stale worktree administrative metadata when the working directory or the submodule gitdir is already gone. A foreign directory SHALL be deleted when empty and refused when it contains files unless `--force` is given. The command SHALL refuse when the current working directory is inside the tree being removed. When the alias or the task is omitted, it SHALL prompt interactively — the alias first, then the task, without auto-selection — and SHALL fail with a usage error in a non-interactive shell. After removing a worktree it SHALL print how to resume the branch and how to delete it, and it SHALL delete the `.oms-tree/<alias>/` directory when it is left empty, up to deleting the `.oms-tree/` root when no inventory entries remain.

#### Scenario: Clean removal preserves the branch

- **WHEN** the user runs `oms tree remove api fix-auth` on a clean tree
- **THEN** the `.oms-tree/api/fix-auth/` directory is gone
- **AND** branch `fix-auth` and its commits still exist
- **AND** the message names `oms tree add api fix-auth` to resume and `oms branch delete api fix-auth` to delete the branch

#### Scenario: Dirty worktree is refused without force

- **WHEN** the managed tree has uncommitted changes
- **AND** the user runs `oms tree remove api fix-auth`
- **THEN** the command fails
- **AND** the worktree, its changes, and the branch are preserved

#### Scenario: Force removes a dirty worktree and still preserves the branch

- **WHEN** the managed tree has uncommitted changes
- **AND** the user runs `oms tree remove api fix-auth --force`
- **THEN** the worktree and its uncommitted changes are discarded
- **AND** branch `fix-auth` and its commits still exist

#### Scenario: Broken tree is pruned

- **WHEN** the managed tree's worktree link is broken or its directory is already gone
- **AND** the user runs `oms tree remove api fix-auth`
- **THEN** the stale worktree administrative metadata is removed
- **AND** the command exits 0

#### Scenario: Removal from inside the target tree is refused

- **WHEN** the current working directory is inside `.oms-tree/api/fix-auth/`
- **AND** the user runs `oms tree remove api fix-auth`
- **THEN** the command fails with guidance to run it from outside the tree
- **AND** the worktree and its branch are preserved

#### Scenario: Empty foreign directory is removed

- **WHEN** `.oms-tree/api/stray/` exists as an empty foreign directory
- **AND** the user runs `oms tree remove api stray`
- **THEN** the directory is deleted and the command exits 0

#### Scenario: Non-empty foreign directory is refused without force

- **WHEN** `.oms-tree/api/stray/` exists as a foreign directory containing files
- **AND** the user runs `oms tree remove api stray`
- **THEN** the command fails and the directory and its files are preserved
- **AND** `oms tree remove api stray --force` removes it

#### Scenario: Empty alias directory is cleaned up

- **WHEN** `oms tree remove api fix-auth` removes the last tree of alias `api`
- **THEN** the `.oms-tree/api/` directory no longer exists

#### Scenario: Omitted arguments prompt interactively and fail non-interactively

- **WHEN** the user runs `oms tree remove` in an interactive terminal without an alias or a task
- **THEN** the command prompts for the alias and then the task, without auto-selecting a sole candidate
- **WHEN** the same command runs in a non-interactive shell
- **THEN** it fails with a usage error naming the required arguments

#### Scenario: Unknown tree fails

- **WHEN** no inventory entry matches the given alias and task
- **THEN** `oms tree remove` fails with an actionable error pointing to `oms tree list`

### Requirement: Command guard inside managed trees

When the current working directory is inside `.oms-tree/`, the commands `oms commit`, `oms fetch`, `oms pull`, `oms push`, `oms record`, and `oms branch` — in its bare interactive form, which fails before the action selector is presented, and in every subcommand `switch`, `checkout`, `list`, and `delete` — SHALL fail with managed-tree guidance before performing any repository operation, whether or not an alias was supplied explicitly. `oms status`, `oms doctor`, and the `oms tree` subcommands SHALL continue to work from inside a managed tree. The guidance SHALL state that Git is used directly inside a managed tree and that `oms` commands run from the canonical checkout or the workspace root.

#### Scenario: Explicit-alias command refuses inside a tree

- **WHEN** the user runs `oms commit api` from inside `.oms-tree/api/fix-auth/`
- **THEN** the command exits non-zero with managed-tree guidance
- **AND** no commit is created in any repository

#### Scenario: Omitted-alias command neither resolves nor prompts inside a tree

- **WHEN** the user runs `oms commit` from inside `.oms-tree/api/fix-auth/`
- **THEN** the command exits non-zero with managed-tree guidance
- **AND** it does not infer an alias, build a candidate list, or prompt for selection

#### Scenario: Bare `oms branch` fails before the action selector

- **WHEN** the user runs `oms branch` from inside `.oms-tree/api/fix-auth/`
- **THEN** the command exits non-zero with managed-tree guidance
- **AND** no action selector is presented

#### Scenario: Read-only commands remain available inside a tree

- **WHEN** the user runs `oms status`, `oms doctor`, or `oms tree list` from inside `.oms-tree/api/fix-auth/`
- **THEN** the command succeeds and reports workspace and tree state

### Requirement: Unsync protection while inventory entries exist

`oms unsync <alias>` SHALL fail while any inventory entry exists for that alias — healthy, broken, or foreign — including with `--force`, because unsync removes the submodule's shared Git directory that the trees are attached to. The failure SHALL name the alias's inventory entries and name `oms tree remove` as the command that removes them.

#### Scenario: Live tree blocks unsync

- **WHEN** a managed tree exists for `api`
- **AND** the user runs `oms unsync api`
- **THEN** the command fails and names the entry
- **AND** the submodule working tree, its Git directory, and the tree are preserved

#### Scenario: Broken or foreign entry blocks unsync

- **WHEN** the only inventory entry for `api` has a broken worktree link or is a foreign directory
- **AND** the user runs `oms unsync api`
- **THEN** the command still fails and names the entry

#### Scenario: Force does not bypass live-tree protection

- **WHEN** a managed tree exists for `api`
- **AND** the user runs `oms unsync api --force`
- **THEN** the command still fails with the live-tree message

#### Scenario: Unsync proceeds after trees are removed

- **WHEN** no inventory entry exists for `api`
- **THEN** `oms unsync api` follows its existing topology finalization policy

### Requirement: Managed tree visibility in status and doctor

`oms status --json` SHALL include a top-level `trees` array with one entry per inventory entry, each exposing `alias`, `task`, `path`, `absolutePath`, `branch`, `head`, `dirty`, and `error`. The array SHALL be empty when no inventory entries exist, and the addition SHALL stay additive under `schemaVersion` 1. An entry with a broken worktree link or a foreign directory SHALL carry a non-null `error`, and a broken entry SHALL report `branch`, `head`, and `dirty` as `null`. The human-readable `oms status` SHALL list inventory entries when any exist. `oms doctor` SHALL report a managed tree with a broken worktree link and name `git worktree repair` as the remediation, and SHALL warn when `.oms-tree/` exists but the root's local exclude entry is missing, naming `oms tree add` as the command that re-asserts it.

#### Scenario: Status JSON exposes managed trees

- **WHEN** inventory entries exist
- **AND** the user runs `oms status --json`
- **THEN** the `trees` array contains one entry per tree with `alias`, `task`, `path`, `absolutePath`, `branch`, `head`, `dirty`, and `error`
- **AND** a tree with a broken link carries a non-null `error` describing it, with `branch`, `head`, and `dirty` reported as `null`

#### Scenario: Status JSON without trees stays empty

- **WHEN** no inventory entries exist
- **THEN** `oms status --json` reports `trees` as an empty array

#### Scenario: Human status lists managed trees

- **WHEN** inventory entries exist
- **AND** the user runs `oms status`
- **THEN** the output lists each tree's alias, task, branch, and dirty state

#### Scenario: Alias-filtered status narrows trees

- **WHEN** the user runs `oms status api --json`
- **THEN** the `trees` array includes only trees of alias `api`

#### Scenario: Doctor reports a broken tree with repair guidance

- **WHEN** a managed tree's worktree link is broken
- **AND** the user runs `oms doctor`
- **THEN** doctor reports the broken tree
- **AND** names `git worktree repair` as the remediation

#### Scenario: Doctor warns about a missing local exclude entry

- **WHEN** `.oms-tree/` exists at the workspace root
- **AND** the root's `.git/info/exclude` has no `.oms-tree/` entry
- **THEN** `oms doctor` reports the missing entry
- **AND** names `oms tree add` as the command that re-asserts it

### Requirement: Tree command help

The `oms tree` help output SHALL describe each subcommand's purpose, name the `.oms-tree/` location, state that the tree lifecycle creates no root commits and no `.gitmodules` entries, and include at least one usage example.

#### Scenario: Help explains the tree lifecycle scope

- **WHEN** the user runs help for `oms tree` or an `oms tree` subcommand
- **THEN** the help text names the `.oms-tree/` location
- **AND** states that creating and removing trees creates no root commit and no `.gitmodules` entry
- **AND** includes an example command
