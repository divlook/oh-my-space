## ADDED Requirements

### Requirement: Shared alias preparation across commands
The system SHALL prepare a selected alias through one shared implementation for every command that operates inside a submodule working tree — `oms commit`, `oms fetch`, `oms pull`, `oms push`, `oms branch list`, `oms branch switch`, `oms branch checkout`, and `oms branch delete` — classifying its root registration, initializing it automatically when that requires no root topology change, and offering topology-creating registration only for the commands a fresh registration could serve. `oms status`, `oms doctor`, and `oms record` SHALL NOT perform this preparation.

#### Scenario: Registration is classified consistently for every command
- **WHEN** any preparing command resolves an alias
- **THEN** OMS classifies it as initialized, registered but uninitialized, partially registered, or unregistered
- **AND** the classification compares root HEAD, the root index, and the working tree for both the gitlink and the `.gitmodules` registration
- **AND** every preparing command derives the same classification for the same repository state

#### Scenario: Registered uninitialized alias is initialized for any preparing command
- **WHEN** a preparing command's selected alias has a root gitlink and `.gitmodules` registration but is not initialized
- **THEN** OMS initializes only that alias automatically
- **AND** does not create, stage, or commit root topology
- **AND** continues the requested command without requiring a separate command

#### Scenario: Unregistered alias is offered registration for commands a fresh clone can serve
- **WHEN** the selected alias is declared in `oms.yaml` but not registered in the root repository
- **AND** the command is `oms fetch`, `oms pull`, `oms branch list`, `oms branch switch`, or `oms branch checkout`
- **AND** stdin is interactive
- **THEN** OMS offers to register the alias and continue, stating the root topology consequence
- **AND** accepting delegates to the sync workflow and resumes the requested command
- **AND** declining leaves root topology unchanged and exits non-zero

#### Scenario: Unregistered alias is refused for commands presupposing local state
- **WHEN** the selected alias is declared in `oms.yaml` but not registered in the root repository
- **AND** the command is `oms commit`, `oms push`, or `oms branch delete`
- **THEN** OMS does not offer registration
- **AND** exits non-zero explaining that a newly registered alias has no uncommitted changes, no unpushed commits, and no branch other than its baseline
- **AND** names `oms sync <alias>` as the command that registers it

#### Scenario: Unregistered alias is refused non-interactively
- **WHEN** a preparing command's selected alias is unregistered
- **AND** stdin is non-interactive
- **THEN** OMS exits non-zero without creating root topology
- **AND** names `oms sync <alias>` and the command to retry

#### Scenario: Partially registered alias is refused by every preparing command
- **WHEN** root HEAD, the root index, and the working tree disagree about an alias's gitlink or `.gitmodules` registration
- **OR** either registration element is conflicted or has a pending topology addition or removal
- **THEN** OMS exits non-zero without attempting automatic initialization or topology repair
- **AND** identifies the inconsistent registration and provides sync repair guidance

#### Scenario: Multi-alias preparation asks once and registers together
- **WHEN** `oms fetch` or `oms pull` selects several aliases and more than one is unregistered
- **AND** stdin is interactive
- **THEN** OMS presents one choice naming every unregistered alias
- **AND** accepting registers them in a single delegated sync producing one root topology commit
- **AND** OMS does not present the choice once per alias

#### Scenario: Multi-alias preparation offers a skip that does not fail the run
- **WHEN** OMS presents the multi-alias preparation choice
- **THEN** the choices include registering all of them, skipping them and continuing with the rest, and cancelling
- **AND** choosing to skip reports the skipped aliases, processes the remaining aliases, and exits 0
- **AND** cancelling performs no repo operation and exits non-zero

#### Scenario: Preparation choice defaults by how the selection was made
- **WHEN** the alias was named on the command line, or was auto-selected as the only candidate
- **THEN** the preparation choice defaults to registering and continuing
- **WHEN** the selection came from `--all` or a multi-select prompt
- **THEN** the preparation choice defaults to skipping the unregistered aliases

#### Scenario: Detached submodule HEAD is attached when a branch already points at it
- **WHEN** a preparing command's selected submodule is in detached HEAD
- **AND** at least one local branch points at exactly the current HEAD commit
- **THEN** OMS switches to that branch without changing the working tree contents
- **AND** reports the attachment
- **AND** continues the requested command

#### Scenario: Detached submodule HEAD with no branch at HEAD offers a choice
- **WHEN** a preparing command's selected submodule is in detached HEAD
- **AND** no local branch points at the current HEAD commit
- **AND** stdin is interactive
- **THEN** OMS presents choices to create a branch at the current commit, to switch to the baseline branch while stating that the working tree moves, or to cancel
- **AND** continues the requested command after the user chooses

#### Scenario: Detached submodule HEAD with no branch at HEAD fails non-interactively
- **WHEN** a preparing command's selected submodule is in detached HEAD
- **AND** no local branch points at the current HEAD commit
- **AND** stdin is non-interactive
- **THEN** OMS exits non-zero without moving the working tree
- **AND** names `oms branch switch <alias> <branch>`

#### Scenario: Diagnostic and pointer commands do not prepare
- **WHEN** the user runs `oms status`, `oms doctor`, or `oms record`
- **THEN** OMS does not initialize, register, or attach any alias
- **AND** reports the state it observes
- **AND** `oms record` still resolves an omitted selection through the shared alias-resolution rules, which govern selection only and are separate from preparation

## MODIFIED Requirements

### Requirement: Current submodule alias resolution
The system SHALL resolve omitted alias selection for supported alias commands using explicit arguments, current path inference, and interactive selection only. A supported one-alias command (`oms commit`) SHALL resolve to at most one alias. A supported multi-alias command (`oms record`) SHALL resolve to a set of aliases and SHALL treat an explicit alias list or `--all` as the explicit argument that suppresses current path inference. When the alias is omitted, the system SHALL decide by the number of valid candidates and SHALL require an interactive terminal only when more than one candidate exists.

#### Scenario: Alias inferred inside submodule tree
- **WHEN** the user runs a supported alias command without an alias from inside `oms/api/`
- **THEN** the command resolves alias `api`

#### Scenario: Alias inference uses path segment boundaries
- **WHEN** alias `api` exists and the current directory is `oms/api-extra/`
- **THEN** the command does not infer alias `api`

#### Scenario: Alias inferred before command preconditions
- **WHEN** the user runs `oms commit -m "feat: x"` from inside registered but uninitialized `oms/api/`
- **THEN** the command resolves alias `api`
- **AND** the command initializes `api` automatically before evaluating its preconditions

#### Scenario: Explicit whole-workspace selection suppresses inference
- **WHEN** the user runs `oms record --all` from inside `oms/api/`
- **THEN** the command does not narrow the selection to the inferred alias `api`
- **AND** the command selects every declared repo

#### Scenario: Interactive candidate selection
- **WHEN** a supported alias command omits the alias outside any `oms/<alias>/` tree
- **THEN** the command builds its command-specific valid candidate list first
- **AND** the command does not fail solely because stdin is not a terminal until it has established that more than one candidate exists
- **AND** `oms commit` candidates are dirty submodules, presented as a single-select choice
- **AND** `oms record` candidates are moved submodule pointers that record can actually commit, excluding pending removals and staged pointer splits, presented as a multi-select choice
- **AND** the candidate filter is derived from the same recordability judgement `oms record` enforces, so the picker never offers an alias that recording would refuse

#### Scenario: Interactive single candidate auto-selects
- **WHEN** an alias-less command has exactly one valid candidate
- **THEN** the command selects it automatically whether or not stdin is a terminal
- **AND** the command prints a short message explaining the selection
- **AND** the command does not prompt for confirmation

#### Scenario: Interactive no candidates is no-op
- **WHEN** an alias-less `oms commit` has no dirty submodule candidates
- **THEN** the command reports that there is nothing to commit in any submodule and exits 0 whether or not stdin is a terminal
- **WHEN** an alias-less `oms record` has no moved pointer candidates
- **THEN** the command reports that there is nothing to record for any submodule and exits 0 whether or not stdin is a terminal

#### Scenario: Non-interactive alias omission fails
- **WHEN** an alias-less command has more than one valid candidate in an interactive terminal
- **THEN** the command presents the candidates as a choice
- **WHEN** an alias-less command has more than one valid candidate in a non-interactive shell
- **THEN** the command fails with a clear message explaining that an alias is required
- **AND** for a multi-alias command the message names `--all` as the whole-workspace alternative
- **AND** the command does not guess among the candidates

#### Scenario: Sole registered alias auto-selects for per-repo branch commands
- **WHEN** the user runs `oms branch switch` or `oms branch checkout` without an alias
- **AND** exactly one declared alias is a valid candidate for that command
- **THEN** the command selects it automatically whether or not stdin is a terminal
- **AND** the command does not prompt merely to confirm the only available choice

#### Scenario: Destructive selection is excluded from auto-selection
- **WHEN** the user runs `oms branch delete` without an alias or without a branch
- **THEN** the command presents the selector even when exactly one candidate is available
- **AND** the command does not auto-select the candidate whether or not stdin is a terminal
- **AND** a non-interactive shell exits non-zero identifying the missing argument

### Requirement: Submodule-only commits
The system SHALL provide `oms commit <alias> -m <message>` to create commits only inside the selected submodule while respecting the submodule index for partial commits. The command SHALL prepare the selected alias through the shared preparation path, and SHALL never create, stage, or commit root repository topology or pointer changes.

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

#### Scenario: Commit initializes a registered uninitialized alias
- **WHEN** `oms/api` is registered in root HEAD and `.gitmodules` but is not initialized
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command initializes `api` automatically without creating root topology
- **AND** then evaluates the commit preconditions against the initialized working tree

#### Scenario: Commit refuses an unregistered alias
- **WHEN** `api` is declared in `oms.yaml` but has no root gitlink or `.gitmodules` registration
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command exits non-zero without creating root topology
- **AND** explains that an unregistered alias has no source changes to commit
- **AND** names `oms sync api` as the command that registers it

#### Scenario: Commit attaches a free detached submodule HEAD
- **WHEN** `oms/api/` is in detached HEAD and a local branch points at exactly the current HEAD commit
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command switches to that branch without changing the working tree contents
- **AND** creates the commit on that branch

#### Scenario: Commit rejects detached submodule HEAD
- **WHEN** `oms/api/` is in detached HEAD and no local branch points at the current HEAD commit
- **AND** the user runs `oms commit api -m "feat: add login flow"` in a non-interactive shell
- **THEN** the command fails without creating a commit
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

### Requirement: Branch list scope and actionable failures
`oms branch list` SHALL keep all automatic mutations within preparation and remote-tracking refresh for the selected submodule, and SHALL fail terminally only when a useful local inventory cannot be produced safely. Preparation for `oms branch list` SHALL include attaching a detached submodule `HEAD` where doing so cannot move the working tree, so that the shared preparation path is not weakened for one command.

#### Scenario: Listing preserves branch and root state
- **WHEN** branch listing completes in fresh or degraded mode
- **AND** the user did not delegate preparation to the existing sync workflow
- **THEN** it does not delete, merge, or push a branch
- **AND** the only branch it switches or creates is the attachment of a detached `HEAD` performed by preparation
- **AND** that attachment leaves the checked-out commit unchanged, so it never moves the submodule off the recorded pointer
- **AND** does not change, stage, or commit a root gitlink or root file
- **AND** does not print an `oms record` hint

#### Scenario: Local ref inspection fails
- **WHEN** OMS cannot inspect local refs in the prepared selected repository
- **THEN** OMS exits 2
- **AND** identifies the failed inspection and preserved repository state
- **AND** provides a bounded diagnostic or repair action

#### Scenario: Credential-bearing diagnostics are redacted
- **WHEN** a preserved Git diagnostic contains URL userinfo, an embedded token, or another credential-bearing URL component
- **THEN** OMS redacts the credential before displaying the diagnostic
- **AND** retains non-sensitive failure context and actionable guidance

#### Scenario: Degraded remote freshness is not a terminal failure
- **WHEN** local branch inspection succeeds
- **AND** one or more declared remotes are stale or unavailable after automatic retry
- **THEN** OMS prints the usable inventory and explicit degraded states
- **AND** exits 0

### Requirement: Pull and push submodule-only synchronization
The system SHALL keep `oms pull` and `oms push` focused only on synchronizing submodules, while existing root gitlink pointer-update staging and commits are created only by `oms record <alias>`. Sync and unsync root commits are a separate topology workflow. `oms pull` and `oms push` SHALL prepare their selected aliases through the shared preparation path before operating.

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

#### Scenario: Pull and push attach a free detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD and a local branch points at exactly the current HEAD commit
- **AND** the user runs `oms pull api` or `oms push api`
- **THEN** the command switches to that branch without changing the working tree contents
- **AND** performs the requested pull or push on that branch

#### Scenario: Push rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD and no local branch points at the current HEAD commit
- **AND** the user runs `oms push api` in a non-interactive shell
- **THEN** the command fails and suggests `oms branch switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Pull rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD and no local branch points at the current HEAD commit
- **AND** the user runs `oms pull api` in a non-interactive shell
- **THEN** the command fails and suggests `oms branch switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Pull and push prepare a registered uninitialized alias
- **WHEN** `oms/api` is registered in root HEAD and `.gitmodules` but is not initialized
- **AND** the user runs `oms pull api` or `oms push api`
- **THEN** the command initializes `api` automatically without creating root topology
- **AND** then performs the requested pull or push

#### Scenario: Pull and push differ on an unregistered alias
- **WHEN** `api` is declared in `oms.yaml` but not registered in the root repository
- **AND** the user runs `oms push api`
- **THEN** the command exits non-zero without creating root topology
- **AND** names `oms sync api` as the command that registers it
- **WHEN** the user runs `oms pull api` in an interactive terminal
- **THEN** the command offers to register `api` and continue

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
