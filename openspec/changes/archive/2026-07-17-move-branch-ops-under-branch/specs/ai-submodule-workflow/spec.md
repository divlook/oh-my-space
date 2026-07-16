## MODIFIED Requirements

### Requirement: Interactive branch action selection
The system SHALL provide an `oms branch` command group that hosts every supported branch-management action as a subcommand — `list`, `switch`, `checkout`, and `delete` — and SHALL NOT expose top-level `oms switch` or `oms checkout` commands. `oms branch switch [alias] [branch]` SHALL provide the local-branch management behavior (switch to an existing local branch, or create a new one with no remote required) previously provided by top-level `oms switch`, and `oms branch checkout [alias] [branch]` SHALL provide the remote-tracking behavior (fetch origin, then check out an `origin/*` branch as a local tracking branch) previously provided by top-level `oms checkout`.

#### Scenario: Interactive branch command offers every lifecycle action
- **WHEN** the user runs `oms branch` in an interactive terminal
- **THEN** the command presents `list`, `switch`, `checkout`, and `delete` actions in lifecycle order

#### Scenario: Interactive branch command selects list
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects list
- **THEN** the command continues into the `oms branch list` alias-resolution flow

#### Scenario: Interactive branch command selects switch
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects switch
- **THEN** the command continues into the `oms branch switch` local-branch interaction

#### Scenario: Interactive branch command selects checkout
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects checkout
- **THEN** the command continues into the `oms branch checkout` remote-tracking interaction

#### Scenario: Interactive branch command selects delete
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects delete
- **THEN** the command continues into the existing `oms branch delete` interaction

#### Scenario: Branch switch subcommand preserves former top-level switch behavior
- **WHEN** the user runs `oms branch switch api feature/login`
- **THEN** the command behaves exactly as the former `oms switch api feature/login`, switching to or creating the local branch without requiring a remote

#### Scenario: Branch checkout subcommand preserves former top-level checkout behavior
- **WHEN** the user runs `oms branch checkout api dev`
- **THEN** the command behaves exactly as the former `oms checkout api dev`, fetching origin and checking out `origin/dev` as a local tracking branch

#### Scenario: Top-level switch and checkout commands are removed
- **WHEN** the user runs `oms switch ...` or `oms checkout ...`
- **THEN** the CLI reports an unknown command
- **AND** exits with a non-zero status

#### Scenario: Branch action selection is cancelled
- **WHEN** the user cancels the action selector opened by `oms branch`
- **THEN** the command exits 1 without modifying any submodule or root repository state

#### Scenario: Branch command without action is non-interactive
- **WHEN** the user runs `oms branch` in a non-interactive shell
- **THEN** the command prints branch command help
- **AND** exits 1 without modifying repository state

### Requirement: Protected branch and repository state
The system SHALL protect current and baseline branches, reject unsafe submodule states, and leave unrelated dirty state independent from local branch deletion.

#### Scenario: Current branch is protected
- **WHEN** the user requests deletion of the current branch with or without `--force`
- **THEN** the command exits 1 before running `git branch -d` or `git branch -D`
- **AND** suggests switching to another branch first

#### Scenario: Detached HEAD rejects branch deletion
- **WHEN** the selected submodule is in detached HEAD
- **AND** it differs from the root-recorded gitlink or no root gitlink exists
- **THEN** the command exits 1 before deleting any branch
- **AND** suggests attaching HEAD with `oms branch switch <alias> <branch>`

#### Scenario: In-progress submodule Git operation rejects deletion
- **WHEN** the selected submodule Git directory contains `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, or `sequencer`
- **THEN** the command exits 1 before deleting any branch
- **AND** asks the user to resolve, continue, or abort that operation

#### Scenario: Dirty submodule worktree does not block deletion
- **WHEN** the selected submodule has modified, staged, or untracked files
- **AND** the target is a different unprotected local branch
- **THEN** the command permits Git to delete the target branch
- **AND** leaves the worktree and index unchanged

#### Scenario: Root repository state does not block deletion
- **WHEN** the root repository is dirty or has a merge, rebase, or similar operation in progress
- **AND** the selected submodule passes its own deletion preconditions
- **THEN** the command permits local submodule branch deletion
- **AND** does not modify root repository state

### Requirement: Root topology actions share a consistent safety preflight
The system SHALL provide one shared root-topology safety preflight in the status spine and route the root-touching commands through it, so the guard set evolves in one place rather than being re-implemented per command. The preflight SHALL classify, for a selected alias, whether the root gitlink is conflicted, whether the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar operation in progress, and whether `oms/<alias>` is occupied by a non-submodule file or directory or exists but cannot be read (permission or I/O error). Each routed command SHALL apply the subset of these checks that is meaningful for it, refuse before mutating Git state when an applied check fails, fail with a deterministic OMS message instead of leaking a raw Git error, and return a non-zero exit code. The occupied-path classification SHALL distinguish an unreadable path from one occupied by non-submodule content so the refusal message names the actual cause (access error vs. stray content) rather than misdirecting the user to "move or remove" a path they cannot read.

The checks applicable to each command are:
- `oms unsync` SHALL apply all three checks (conflicted gitlink, in-progress root operation, and occupied-or-unreadable non-submodule path), reaching parity with `oms sync`'s existing data-loss protection.
- `oms record` SHALL apply the conflicted-gitlink and in-progress-root-operation checks. The occupied-non-submodule-path check does not apply because `record` neither creates nor occupies `oms/<alias>`; its existing record-specific checks and message ordering are preserved.
- `oms sync` already refuses on an occupied non-submodule path (its `!registered` branch) and on unsafe pending-removal restore states (conflicted gitlink or in-progress root operation while restoring). It still refuses in exactly the same states with the same exit codes; the only observable change is that a path which exists but cannot be read now reports a distinct "could not be read (permission or I/O error)" message — in both its pending-removal restore branch and its `!registered` fresh-add branch — instead of the previous "occupied" / "already exists" wording. It consumes the same shared spine primitives (`gitlinkState`, `gitOperationInProgress`, `readAliasDirEntries`) that the preflight composes.

Commands that operate only inside an initialized submodule working tree (`oms commit`, `oms branch switch`, `oms branch checkout`, `oms fetch`, `oms pull`, `oms push`) are unaffected and remain gated only by their existing initialization precondition.

#### Scenario: Conflicted gitlink and in-progress root operations are refused consistently by unsync and record
- **WHEN** the selected alias has a conflicted root gitlink or the root repository has an in-progress root Git operation
- **AND** the user runs `oms unsync` or `oms record` for that alias
- **THEN** the command refuses before mutating Git state
- **AND** the command fails with a deterministic OMS message rather than a raw Git error
- **AND** the command returns a non-zero exit code

### Requirement: Submodule-only commits
The system SHALL provide `oms commit <alias> -m <message>` to create commits only inside the selected submodule while respecting the submodule index for partial commits.

#### Scenario: Commit submodule changes only when nothing is staged
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has changed files but no staged changes
- **THEN** the command runs `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/`
- **AND** the root repository does not receive a new commit
- **AND** unrelated root repository files are not staged
- **AND** the command prints the submodule short commit SHA
- **AND** the command prints the appropriate root follow-up hint, such as `oms record api` when an existing recorded gitlink is moved

#### Scenario: Commit staged submodule changes only
- **WHEN** `oms/api/` has staged changes and unstaged changes
- **AND** the user runs `oms commit api -m "feat: add login form"`
- **THEN** the command does not run `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/` using only the staged changes
- **AND** the unstaged changes remain unstaged in `oms/api/`
- **AND** the command warns that unstaged changes remain uncommitted
- **AND** the root repository does not receive a new commit

#### Scenario: Commit supports multiple message paragraphs
- **WHEN** the user runs `oms commit api -m "feat: add login" -m "Add callback handling."`
- **THEN** both message paragraphs are passed to the submodule `git commit`

#### Scenario: Commit requires explicit message only for source commits
- **WHEN** `oms/api/` has committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command fails without opening an editor
- **AND** the message explains that `-m` is required to create a submodule commit

#### Scenario: Commit no-op does not require a message
- **WHEN** `oms/api/` has no committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0

#### Scenario: Commit without submodule changes
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has no committable changes
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Commit no-op with moved pointer
- **WHEN** `oms/api/` has no committable changes and the root pointer for `api` is moved
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** prints a hint to run `oms record api`
- **AND** does not record the root pointer

#### Scenario: Commit no-op with pending add topology
- **WHEN** `oms/api/` has no committable changes
- **AND** the root repository HEAD has no recorded gitlink for `oms/api`
- **AND** the working tree has an initialized `oms/api` submodule
- **AND** `.gitmodules` contains path `oms/api`
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** prints a hint to run `oms sync api --commit`
- **AND** does not record the root pointer

#### Scenario: Commit rejects detached submodule HEAD
- **WHEN** `oms/api/` is in detached HEAD
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails
- **AND** suggests `oms branch switch api <branch>`
- **AND** does not modify the root repository

#### Scenario: Commit rejects in-progress Git operations
- **WHEN** `oms/api/` has a merge, rebase, cherry-pick, revert, bisect, or similar Git operation in progress
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails and instructs the user to resolve, continue, or abort the operation inside `oms/api/`
- **AND** does not modify the root repository

#### Scenario: Commit never records root pointer
- **WHEN** `oms commit api -m "feat: add login flow"` creates a submodule commit and the root pointer for `api` is moved
- **THEN** the command does not create a root repository pointer commit
- **AND** the command prints a hint to run `oms record api`

#### Scenario: Commit source changes with pending add topology
- **WHEN** `oms commit api -m "feat: add login flow"` creates a submodule commit
- **AND** the root repository HEAD has no recorded gitlink for `oms/api`
- **AND** the working tree has an initialized `oms/api` submodule
- **AND** `.gitmodules` contains path `oms/api`
- **THEN** the command does not create a root repository topology commit
- **AND** the command prints a hint to run `oms sync api --commit`

### Requirement: Pull and push keep root pointer updates explicit
The system SHALL keep `oms pull` and `oms push` focused only on synchronizing submodules, while existing root gitlink pointer-update staging and commits are created only by `oms record <alias>`. Sync and unsync root commits are a separate topology workflow; sync commits SHALL also include reconciled metadata and its current declarative `oms.yaml` source.

#### Scenario: Sync leaves OMS root changes unstaged
- **WHEN** the user runs `oms sync api` without creating a root commit and the command changes topology or managed metadata
- **THEN** those root working-tree changes remain available as the explicit no-commit result
- **AND** the command does not leave those changes staged in the real root index
- **AND** unrelated staged root changes remain staged

#### Scenario: Unsync leaves topology changes unstaged
- **WHEN** the user runs `oms unsync api` without creating a topology commit and the command removes or updates root topology files such as `.gitmodules` or `oms/api`
- **THEN** those root working tree changes remain available for review
- **AND** the command does not leave those changes staged in the root index
- **AND** unrelated staged root changes remain staged
- **AND** the command prints guidance to review, stage, and commit root topology changes explicitly

#### Scenario: Interactive sync prompts for one root commit
- **WHEN** the user runs `oms sync api` in an interactive terminal
- **AND** every requested alias succeeds with topology or metadata changes
- **THEN** the command asks once whether to create a root commit
- **AND** the prompt defaults to Yes and identifies topology, metadata, and changed `oms.yaml` paths that will be included
- **AND** if the user accepts, the command creates one commit for those successful OMS changes
- **AND** if the user declines, the command applies the path-limited unstage behavior

#### Scenario: Interactive unsync prompts for topology commit
- **WHEN** the user runs `oms unsync api` in an interactive terminal and topology changes succeed
- **THEN** the command asks whether to create a root topology commit
- **AND** the prompt defaults to Yes and shows commit message `chore(oms): remove api submodule`
- **AND** if the user accepts, the command creates a root commit with message `chore(oms): remove api submodule`
- **AND** if the user declines, the command applies the path-limited unstage behavior

#### Scenario: Sync commit prompt is driven by detected pending state
- **WHEN** a previous `oms sync api` left pending topology or managed metadata without creating a root commit
- **AND** the user later runs the same command again in an interactive terminal
- **THEN** the command detects the pending state from root HEAD, working tree, `.gitmodules`, and `oms.yaml`
- **AND** asks again whether to create the root commit after successful validation
- **AND** the prompt continues to re-appear until the OMS change is committed or reverted

#### Scenario: Unsync commit prompt is driven by detected pending state
- **WHEN** a previous `oms unsync api` left pending topology without creating a topology commit
- **AND** the user later runs the same command again in an interactive terminal
- **THEN** the command detects the pending topology from root HEAD, working tree, and `.gitmodules` state
- **AND** asks again whether to create the root topology commit

#### Scenario: Explicit sync commit bypasses prompt
- **WHEN** the user runs `oms sync api --commit`
- **THEN** the command creates one root commit containing successful `api` topology, reconciled metadata, and the complete current `oms.yaml` when changed
- **AND** the command does not prompt

#### Scenario: Sync commit works for pending changes
- **WHEN** `oms sync api` previously created topology or metadata working-tree changes without committing them
- **AND** the user later runs `oms sync api --commit`
- **THEN** the command validates and creates the root commit for those pending successful OMS changes

#### Scenario: Explicit unsync commit bypasses prompt
- **WHEN** the user runs `oms unsync api --commit`
- **THEN** the command creates a root topology commit with message `chore(oms): remove api submodule`
- **AND** the command does not prompt

#### Scenario: Unsync commit works for pending topology changes
- **WHEN** `oms unsync api` previously created topology working tree changes without committing them
- **AND** the user later runs `oms unsync api --commit`
- **AND** root HEAD has an `oms/api` gitlink and both the working tree path and `.gitmodules` entry for `oms/api` have been removed
- **THEN** the command creates the root topology commit for the pending `api` removal changes

#### Scenario: Unsync commit rejects partial removal topology
- **WHEN** root HEAD has an `oms/api` gitlink
- **AND** exactly one of the working tree path or `.gitmodules` entry for `oms/api` has been removed
- **AND** the current `oms unsync api --commit` invocation cannot complete the matching cleanup
- **THEN** the command fails without creating a topology commit
- **AND** the message explains that partial removal topology must be cleaned up before committing

#### Scenario: Multi-alias sync commit uses plural message
- **WHEN** the user runs `oms sync api web --commit`
- **AND** all requested aliases succeed
- **THEN** the command creates one root commit for their topology, metadata, and changed `oms.yaml`
- **AND** the commit message is `chore(oms): add submodules`

#### Scenario: Multi-alias unsync commit uses plural message
- **WHEN** the user runs `oms unsync api web --commit`
- **THEN** the command creates one root topology commit when all requested aliases succeed
- **AND** the commit message is `chore(oms): remove submodules`

#### Scenario: Partial multi-alias sync commit finalizes successful aliases
- **WHEN** the user runs `oms sync api web --commit`
- **AND** `api` succeeds while `web` fails
- **THEN** the command uses a temporary index to commit only `api` topology and metadata plus the complete current `oms.yaml`
- **AND** failed-alias `.gitmodules` metadata and gitlink changes and unrelated working-tree changes are not included
- **AND** failed-alias `oms.yaml` declarations and other current manifest edits are intentionally included
- **AND** pre-existing real-index entries other than `oms.yaml` are preserved after the new HEAD is installed
- **AND** the command exits 2 with the alias-level summary

#### Scenario: Partial multi-alias unsync commit is skipped
- **WHEN** the user runs `oms unsync api web --commit`
- **AND** any requested alias fails
- **THEN** the command does not create a topology commit
- **AND** successfully changed topology paths are returned to unstaged state

#### Scenario: Multi-alias commit prompt is skipped on partial failure
- **WHEN** the user runs `oms sync api web` or `oms unsync api web` in an interactive terminal
- **AND** any requested alias fails
- **THEN** the command does not ask whether to create a root commit
- **AND** successfully changed paths are returned to unstaged state

#### Scenario: Sync commit preserves unrelated staged root changes
- **WHEN** the real root index has staged paths other than `.gitmodules` before sync
- **AND** the user accepts the sync commit prompt or passes `--commit`
- **THEN** the temporary commit index excludes unrelated staged paths other than `oms.yaml`
- **AND** those excluded paths remain staged in the real index after the sync commit
- **AND** staged `oms.yaml` is replaced by and consumed as the complete current working-tree manifest
- **AND** a selected OMS path is consumed only when its staged blob and mode exactly match the validated commit result

#### Scenario: Unsync topology commit rejects unrelated staged root changes
- **WHEN** the root index has staged paths unrelated to selected unsync topology paths
- **AND** the user accepts the topology commit prompt or passes `--commit`
- **THEN** the command fails before creating the topology commit
- **AND** selected topology paths are returned to unstaged state

#### Scenario: Sync commit failure preserves working changes
- **WHEN** sync attempts its root commit and Git rejects it
- **AND** `HEAD` has not advanced
- **THEN** the command does not create a partial OMS commit
- **AND** the real index remains byte-for-byte unchanged while working-tree changes are preserved

#### Scenario: Unsync commit failure preserves staged paths
- **WHEN** unsync stages selected topology paths for a topology commit
- **AND** the root `git commit` step fails
- **THEN** the command fails
- **AND** the selected topology paths remain staged

#### Scenario: Pull does not stage or commit the root gitlink
- **WHEN** the user runs `oms pull api`
- **THEN** the command pulls the current `api` submodule branch according to the existing fast-forward policy
- **AND** does not stage the root gitlink
- **AND** does not create a root repository commit

#### Scenario: Pull prints record hint when pointer moved
- **WHEN** the user runs `oms pull api` successfully and the root pointer for `api` is moved
- **THEN** the command prints a hint to run `oms record api`
- **AND** the command does not stage or record the root pointer

#### Scenario: Pull prints topology hint when recorded gitlink is missing
- **WHEN** the user runs `oms pull api` successfully
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command prints a hint to run `oms sync api --commit`
- **AND** the command does not stage or record the root pointer

#### Scenario: Pull rejects dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms pull api`
- **THEN** the command fails before running pull
- **AND** the message asks the user to commit, stash, or clean changes inside `oms/api`

#### Scenario: Push does not stage or commit the root gitlink
- **WHEN** the user runs `oms push api`
- **THEN** the command pushes the current `api` submodule branch
- **AND** does not stage the root gitlink
- **AND** does not create a root repository commit

#### Scenario: Push prints record hint when pointer moved
- **WHEN** the user runs `oms push api` successfully and the root pointer for `api` is moved
- **THEN** the command prints a hint to run `oms record api`
- **AND** the command does not stage or record the root pointer

#### Scenario: Push prints topology hint when recorded gitlink is missing
- **WHEN** the user runs `oms push api` successfully
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command prints a hint to run `oms sync api --commit`
- **AND** the command does not stage or record the root pointer

#### Scenario: Push warns for dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms push api`
- **THEN** the command warns that only the current HEAD will be pushed
- **AND** the command does not auto-commit source changes

#### Scenario: Push rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD
- **AND** the user runs `oms push api`
- **THEN** the command fails and suggests `oms branch switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Pull rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD
- **AND** the user runs `oms pull api`
- **THEN** the command fails and suggests `oms branch switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Multi-alias pull and push process aliases independently
- **WHEN** the user runs `oms push api web` or `oms pull api web`
- **THEN** the command processes aliases independently
- **AND** continues processing later aliases after one alias fails
- **AND** exits non-zero if any alias operation fails
- **AND** prints a final summary of per-alias results

#### Scenario: Push record option is unsupported
- **WHEN** the user runs `oms push api --record`
- **THEN** the command fails before pushing
- **AND** the message explains that existing root pointer updates are committed with `oms record api`

#### Scenario: Removed push commit option fails before pushing
- **WHEN** the user runs `oms push api --commit`
- **THEN** the command fails before pushing
- **AND** the message explains that submodule branches are pushed with `oms push api` and root pointer updates are committed with `oms record api`
- **AND** does not create a root repository commit
