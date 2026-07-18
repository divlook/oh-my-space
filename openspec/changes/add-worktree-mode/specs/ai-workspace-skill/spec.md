## MODIFIED Requirements

### Requirement: Broad-trigger scope-guardrail skill
The `oms-workspace` skill SHALL instruct agents to establish workspace mode, current target, and repository scope from status schema v2 before Git work, rather than acting as a command router.

#### Scenario: Broad-trigger skill targets general workspace Git work
- **WHEN** the skill description is evaluated for relevance
- **THEN** it targets scope-ambiguous Git work in any workspace containing `oms.yaml`
- **AND** covers submodule topology and pointers plus worktree-mode managed checkout lifecycle
- **AND** does not restrict its trigger to enumerated commit or branch commands

#### Scenario: Broad-trigger skill instructs status-first discipline
- **WHEN** an agent loads the skill
- **THEN** it instructs running `oms status --json` before Git work involving `.oms/` or `oms/`
- **AND** requires reading schema version 2, workspace mode, current target, root relation, and repo discriminator
- **AND** instructs never guessing repository scope

#### Scenario: Broad-trigger skill separates mode semantics
- **WHEN** an agent loads the skill
- **THEN** it states that submodule mode has root topology and explicit pointer records
- **AND** states that worktree mode has `alias/name` targets and no root pointer record
- **AND** defers exact flags and fields to command help

### Requirement: Pointer-record workflow skill
The `oms-pointer` skill SHALL guide commit-or-pull then pointer-record workflows only when status reports submodule mode, and SHALL prevent pointer-record guidance in worktree mode.

#### Scenario: Pointer workflow applies to submodule mode
- **WHEN** status schema v2 reports submodule mode
- **AND** a source commit or pull moves a recorded gitlink
- **THEN** the skill instructs using `oms record` after source synchronization
- **AND** warns against committing unrelated root state

#### Scenario: Pointer workflow does not apply to worktree mode
- **WHEN** status schema v2 reports worktree mode
- **THEN** the skill states that source commits and pulls do not create a root pointer update
- **AND** does not instruct running `oms record`

### Requirement: Branch workflow skill
The `oms-branch` skill SHALL guide branch and worktree selection without detached HEAD, distinguishing repository aliases from managed `alias/name` targets.

#### Scenario: Submodule branch workflow remains scoped
- **WHEN** status reports submodule mode
- **THEN** the skill instructs switch for local branches and checkout for remote branches inside the selected alias

#### Scenario: Worktree branch workflow uses named targets
- **WHEN** status reports worktree mode
- **THEN** the skill explains `oms worktree add` for concurrent attached checkouts
- **AND** uses `alias/name` for switch and checkout of an existing managed worktree
- **AND** identifies branch list and delete as alias-scoped operations

### Requirement: Skills are self-sufficient and schema-stable
Each published skill SHALL carry a mode-aware scope-guardrail kernel verbatim, declare schema version 2, and avoid coupling to volatile field or flag detail.

#### Scenario: Each skill carries the mode-aware kernel verbatim
- **WHEN** any one OMS skill is loaded without the others
- **THEN** it states that status v2 determines mode and target scope
- **AND** distinguishes root, alias, and `alias/name` operations
- **AND** limits pointer-record guidance to submodule mode
- **AND** the identical kernel appears in the marker block

#### Scenario: Kernel remains single-sourced and drift-tested
- **WHEN** the project test suite runs
- **THEN** it verifies the canonical mode-aware kernel is a literal substring of the marker block and each skill

#### Scenario: Skills defer schema detail
- **WHEN** a skill references `oms status --json`
- **THEN** its body declares schema version 2
- **AND** points to `oms status --help` for exact mode-discriminated field semantics
- **AND** instructs stopping for updated guidance when another schema version is observed

#### Scenario: Skill bodies remain portable
- **WHEN** a published skill body is inspected
- **THEN** it contains no agent-specific slash-command syntax

#### Scenario: Skills name only normal-path workflow flags
- **WHEN** a skill names a CLI flag
- **THEN** it names only flags required for the documented normal path
- **AND** selection, force, degraded, and recovery details are deferred to command help
