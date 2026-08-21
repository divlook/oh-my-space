# Delta: ai-submodule-workflow

## MODIFIED Requirements

### Requirement: Shared alias preparation across commands

The system SHALL prepare a selected alias through one shared implementation for every command that operates inside a submodule working tree — `oms commit`, `oms fetch`, `oms pull`, `oms push`, `oms branch list`, `oms branch switch`, `oms branch checkout`, `oms branch delete`, and `oms tree add` — classifying its root registration, initializing it automatically when that requires no root topology change, and offering topology-creating registration only for the commands a fresh registration could serve. `oms status`, `oms doctor`, `oms record`, `oms tree list`, and `oms tree remove` SHALL NOT perform this preparation. When automatic initialization cannot attach the resolved baseline because Git refuses the branch operation, preparation SHALL report the failure and exit non-zero instead of continuing the requested command. `oms tree add` SHALL NOT perform detached-HEAD attachment: its start point is the canonical checkout's current HEAD commit, and it leaves a detached canonical checkout detached without prompting.

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

#### Scenario: Baseline attachment failure stops automatic initialization

- **WHEN** a preparing command automatically initializes a registered alias
- **AND** Git refuses to create or switch to the resolved baseline branch
- **THEN** OMS reports the Git diagnostic and names the alias whose attachment failed
- **AND** leaves the initialized submodule at its checked-out commit
- **AND** does not continue the requested command
- **AND** exits non-zero

#### Scenario: Unregistered alias is offered registration for commands a fresh clone can serve

- **WHEN** the selected alias is declared in `oms.yaml` but not registered in the root repository
- **AND** the command is `oms fetch`, `oms pull`, `oms branch list`, `oms branch switch`, `oms branch checkout`, or `oms tree add`
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

#### Scenario: Tree creation skips detached-HEAD attachment

- **WHEN** the user runs `oms tree add api fix-auth`
- **AND** the initialized submodule `api` is in detached HEAD
- **THEN** OMS does not attach, prompt about, or move the canonical checkout
- **AND** the worktree's branch starts at the current HEAD commit
- **AND** the canonical checkout remains in detached HEAD afterwards

#### Scenario: Diagnostic and pointer commands do not prepare

- **WHEN** the user runs `oms status`, `oms doctor`, `oms record`, `oms tree list`, or `oms tree remove`
- **THEN** OMS does not initialize, register, or attach any alias
- **AND** reports the state it observes
- **AND** `oms record` still resolves an omitted selection through the shared alias-resolution rules, which govern selection only and are separate from preparation

### Requirement: Current submodule alias resolution

The system SHALL resolve omitted alias selection for supported alias commands using explicit arguments, current path inference, and interactive selection only. A supported one-alias command (`oms commit`) SHALL resolve to at most one alias. A supported multi-alias command (`oms record`) SHALL resolve to a set of aliases and SHALL treat an explicit alias list or `--all` as the explicit argument that suppresses current path inference. When the alias is omitted, the system SHALL decide by the number of valid candidates and SHALL require an interactive terminal only when more than one candidate exists. When the current directory is inside a managed tree under `.oms-tree/`, a supported alias command SHALL fail with managed-tree guidance before alias resolution, candidate selection, or any repository operation, regardless of whether an alias was supplied explicitly.

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

#### Scenario: Alias command inside a managed tree fails with guidance

- **WHEN** the user runs a supported alias command from inside `.oms-tree/<alias>/<task>/`
- **THEN** the command fails with managed-tree guidance stating that Git is used directly inside a managed tree and that `oms` commands run from the canonical checkout or the workspace root
- **AND** the command does not infer an alias, build a candidate list, or prompt for selection
- **AND** the command performs no repository operation

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
