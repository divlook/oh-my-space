## ADDED Requirements

### Requirement: Internal refactors preserve submodule workflow behavior
The system SHALL preserve all existing root/submodule workflow behavior when internal CLI modules are reorganized.

The baseline for preservation SHALL be the behavior covered by the existing OpenSpec requirements, the pre-refactor `npm test` result, and the focused CLI behavior checks captured before implementation.

#### Scenario: Status JSON remains stable after module refactor
- **WHEN** `scripts/lib/` modules are reorganized and the user runs `oms status --json`
- **THEN** the command emits the same schemaVersion 1 payload contract as before the refactor
- **AND** root repository changes and submodule source changes remain separated according to the existing workflow requirements

#### Scenario: Root topology safety remains centralized and consistent
- **WHEN** internal modules are reorganized around command or helper boundaries
- **THEN** root topology safety checks for conflicted gitlinks, in-progress root Git operations, occupied paths, unreadable paths, pending add topology, and pending removal topology continue to use the existing shared safety semantics
- **AND** commands that mutate root topology refuse unsafe states before destructive Git or filesystem operations

#### Scenario: Commit, record, sync, unsync, pull, and push preserve scope boundaries
- **WHEN** the user runs `oms commit`, `oms record`, `oms sync`, `oms unsync`, `oms pull`, or `oms push` after the refactor
- **THEN** each command mutates only the same repository scope it mutated before the refactor
- **AND** root pointer commits remain explicit through `oms record <alias>`
- **AND** sync and unsync topology commits remain separate from submodule source commits

#### Scenario: Alias and remote resolution behavior is unchanged
- **WHEN** the user omits aliases or remotes in interactive and non-interactive contexts after the refactor
- **THEN** alias inference, candidate selection, interactive prompts, non-interactive failures, remote defaulting, and remote validation behave as before the refactor

#### Scenario: Help and exit-code semantics are preserved
- **WHEN** the user invokes OMS commands after the refactor
- **THEN** command help continues to describe the same workflow boundaries
- **AND** success, usage/config failure, and git-operation failure exit codes retain their existing meanings
