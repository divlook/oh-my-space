## MODIFIED Requirements

### Requirement: Pull and push keep root pointer updates explicit
The system SHALL keep `oms pull` and `oms push` focused only on synchronizing submodules, while existing root gitlink pointer-update staging and commits are created only by `oms record <alias>`. Sync and unsync root commits are a separate topology workflow; sync commits SHALL also include reconciled metadata and its current declarative `oms.yaml` source. `oms sync` and `oms unsync` SHALL create their root commit by default whenever pending changes and the workflow's safety conditions allow it, SHALL leave those changes unstaged only when `--no-commit` is passed, and SHALL decide this identically whether or not stdin is a terminal.

#### Scenario: Sync creates one root commit by default
- **WHEN** the user runs `oms sync api`
- **AND** every requested alias succeeds with topology or metadata changes
- **THEN** the command creates one root commit for those successful OMS changes without prompting
- **AND** the commit includes topology, reconciled metadata, and the complete current `oms.yaml` when changed

#### Scenario: Unsync creates the topology commit by default
- **WHEN** the user runs `oms unsync api` and topology changes succeed
- **THEN** the command creates a root topology commit with message `chore(oms): remove api submodule` without prompting

#### Scenario: Topology finalization does not depend on a terminal
- **WHEN** the user runs `oms sync api` or `oms unsync api` in a non-interactive shell without `--no-commit`
- **THEN** the command creates the same root commit it would create in an interactive terminal
- **AND** the command does not skip the commit because stdin is not a TTY
- **AND** the command does not leave the workspace requiring a follow-up invocation to record the topology

#### Scenario: Sync leaves OMS root changes unstaged with --no-commit
- **WHEN** the user runs `oms sync api --no-commit` and the command changes topology or managed metadata
- **THEN** those root working-tree changes remain available as the explicit no-commit result
- **AND** the command does not leave those changes staged in the real root index
- **AND** unrelated staged root changes remain staged

#### Scenario: Unsync leaves topology changes unstaged with --no-commit
- **WHEN** the user runs `oms unsync api --no-commit` and the command removes or updates root topology files such as `.gitmodules` or `oms/api`
- **THEN** those root working tree changes remain available for review
- **AND** the command does not leave those changes staged in the root index
- **AND** unrelated staged root changes remain staged
- **AND** the command prints guidance to review, stage, and commit root topology changes explicitly

#### Scenario: Sync commits detected pending state
- **WHEN** a previous `oms sync api --no-commit` left pending topology or managed metadata without creating a root commit
- **AND** the user later runs `oms sync api`
- **THEN** the command detects the pending state from root HEAD, working tree, `.gitmodules`, and `oms.yaml`
- **AND** creates the root commit for that pending state after successful validation
- **AND** does not ask whether to create it

#### Scenario: Unsync commits detected pending topology
- **WHEN** a previous `oms unsync api --no-commit` left pending topology without creating a topology commit
- **AND** the user later runs `oms unsync api`
- **THEN** the command detects the pending topology from root HEAD, working tree, and `.gitmodules` state
- **AND** creates the root topology commit for it

#### Scenario: Sync commit flag is accepted as a no-op
- **WHEN** the user runs `oms sync api --commit`
- **THEN** the command creates one root commit containing successful `api` topology, reconciled metadata, and the complete current `oms.yaml` when changed
- **AND** the result is identical to running `oms sync api` without the flag

#### Scenario: Unsync commit flag is accepted as a no-op
- **WHEN** the user runs `oms unsync api --commit`
- **THEN** the command creates a root topology commit with message `chore(oms): remove api submodule`
- **AND** the result is identical to running `oms unsync api` without the flag

#### Scenario: Delegated preparation sync commits its topology
- **WHEN** a command prepares an unregistered alias by delegating to the sync workflow without passing a commit option
- **THEN** the delegated sync creates the root topology commit
- **AND** the alias is left fully registered across root HEAD, the root index, and the working tree
- **AND** immediately repeating the original command succeeds instead of failing with an inconsistent or pending registration

#### Scenario: Unsync commit rejects partial removal topology
- **WHEN** root HEAD has an `oms/api` gitlink
- **AND** exactly one of the working tree path or `.gitmodules` entry for `oms/api` has been removed
- **AND** the current `oms unsync api` invocation cannot complete the matching cleanup
- **THEN** the command fails without creating a topology commit
- **AND** the message explains that partial removal topology must be cleaned up before committing

#### Scenario: Multi-alias sync commit uses plural message
- **WHEN** the user runs `oms sync api web`
- **AND** all requested aliases succeed
- **THEN** the command creates one root commit for their topology, metadata, and changed `oms.yaml`
- **AND** the commit message is `chore(oms): add submodules`

#### Scenario: Multi-alias unsync commit uses plural message
- **WHEN** the user runs `oms unsync api web`
- **THEN** the command creates one root topology commit when all requested aliases succeed
- **AND** the commit message is `chore(oms): remove submodules`

#### Scenario: Partial multi-alias sync commit finalizes successful aliases
- **WHEN** the user runs `oms sync api web`
- **AND** `api` succeeds while `web` fails
- **THEN** the command uses a temporary index to commit only `api` topology and metadata plus the complete current `oms.yaml`
- **AND** failed-alias `.gitmodules` metadata and gitlink changes and unrelated working-tree changes are not included
- **AND** failed-alias `oms.yaml` declarations and other current manifest edits are intentionally included
- **AND** pre-existing real-index entries other than `oms.yaml` are preserved after the new HEAD is installed
- **AND** the command exits 2 with the alias-level summary

#### Scenario: Partial multi-alias unsync commit is skipped
- **WHEN** the user runs `oms unsync api web`
- **AND** any requested alias fails
- **THEN** the command does not create a topology commit
- **AND** successfully changed topology paths are returned to unstaged state

#### Scenario: Sync commit preserves unrelated staged root changes
- **WHEN** the real root index has staged paths other than `.gitmodules` before sync
- **AND** the command creates its root commit
- **THEN** the temporary commit index excludes unrelated staged paths other than `oms.yaml`
- **AND** those excluded paths remain staged in the real index after the sync commit
- **AND** staged `oms.yaml` is replaced by and consumed as the complete current working-tree manifest
- **AND** a selected OMS path is consumed only when its staged blob and mode exactly match the validated commit result

#### Scenario: Unsync topology commit rejects unrelated staged root changes
- **WHEN** the root index has staged paths unrelated to selected unsync topology paths
- **AND** the command would create the topology commit
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
- **THEN** the command prints a hint to run `oms sync api`
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
- **THEN** the command prints a hint to run `oms sync api`
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
