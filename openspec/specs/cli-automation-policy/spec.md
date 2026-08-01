# cli-automation-policy Specification

## Purpose
TBD - created by syncing change add-branch-list. Update Purpose after archive.

## Requirements
### Requirement: Automation-first command completion
OMS command workflows SHALL automatically perform routine, deterministic, and bounded preparation or recovery that OMS can complete safely, rather than failing and requiring the user to reproduce those steps manually. This requirement applies to every command; a command is not exempt because it predates the requirement.

#### Scenario: Routine preparation is available
- **WHEN** a command encounters a normal prerequisite that OMS can satisfy safely within the command's documented scope
- **THEN** OMS performs that prerequisite automatically
- **AND** continues toward the requested outcome without requiring a separate manual command

#### Scenario: Bounded automatic recovery succeeds
- **WHEN** an operation encounters a recoverable transient failure
- **AND** the workflow defines a safe bounded retry or fallback
- **THEN** OMS performs that recovery automatically
- **AND** completes the requested outcome without asking the user to execute recovery steps

#### Scenario: Automated fallback produces a degraded result
- **WHEN** OMS cannot produce the preferred result after bounded recovery
- **AND** a safe and useful fallback remains available
- **THEN** OMS uses the fallback automatically
- **AND** clearly identifies which part of the result is degraded or uncertain

### Requirement: Bounded automatic preparation
OMS SHALL prepare a workspace target automatically through every step that does not alter root repository topology, and SHALL treat a preparation step that would create root topology as requiring informed consent. OMS SHALL offer that consented preparation only when the request does not presuppose local state that a newly created target cannot contain, and SHALL otherwise stop with a terminal error naming the preparation command.

#### Scenario: Preparation without topology change is automatic
- **WHEN** a command's target is registered in the root repository but not yet materialized in the working tree
- **THEN** OMS materializes it automatically
- **AND** does not create, stage, or commit root topology while doing so
- **AND** continues toward the requested outcome without a separate command

#### Scenario: Topology preparation can satisfy the request
- **WHEN** a command's target is declared but not registered in the root repository
- **AND** the request does not presuppose local state that a newly created registration cannot contain
- **THEN** OMS presents the preparation and its topology consequence as an explicit choice
- **AND** completes the requested outcome after the user accepts
- **AND** leaves root topology unchanged if the user declines

#### Scenario: Topology preparation cannot satisfy the request
- **WHEN** a command's target is declared but not registered in the root repository
- **AND** the request presupposes local state that a newly created registration cannot contain
- **THEN** OMS does not offer or perform the preparation
- **AND** exits non-zero explaining that the target is not registered
- **AND** names the preparation command that would register it

#### Scenario: Topology preparation is unavailable non-interactively
- **WHEN** a command's target requires topology-creating preparation
- **AND** stdin is non-interactive
- **THEN** OMS exits non-zero without creating root topology
- **AND** names the preparation command needed to supply that decision

#### Scenario: Preparation is decided once for a whole selection
- **WHEN** one invocation selects several targets and more than one of them requires topology-creating preparation
- **THEN** OMS presents a single choice covering all of them
- **AND** prepares the accepted targets together so their topology is recorded once
- **AND** does not repeat the choice per target

#### Scenario: Preparation is refused rather than repaired
- **WHEN** a target's root registration is internally inconsistent or has a pending addition or removal
- **THEN** OMS does not attempt automatic preparation or repair
- **AND** exits non-zero identifying the inconsistent registration
- **AND** provides the command that repairs it

### Requirement: Guided human decisions
OMS SHALL request human input only when safe completion depends on intent that cannot be inferred reliably, and SHALL present choices that allow OMS to continue and finish the selected workflow.

#### Scenario: Human intent is required
- **WHEN** more than one materially different safe action can satisfy or prepare the request
- **AND** OMS cannot infer the intended action from explicit arguments or an unambiguous context
- **THEN** interactive OMS presents the available choices and their material consequences
- **AND** continues the workflow after the user chooses

#### Scenario: Only one safe routine choice exists
- **WHEN** exactly one safe routine action can continue the workflow
- **THEN** OMS selects it automatically
- **AND** does not prompt merely for confirmation

#### Scenario: Required decision is unavailable non-interactively
- **WHEN** a workflow requires human intent
- **AND** stdin is non-interactive and no explicit argument supplies that intent
- **THEN** OMS exits non-zero without guessing
- **AND** identifies the missing decision and the exact argument or OMS command needed to supply it

### Requirement: Actionable terminal failures
OMS SHALL emit a terminal error only when it cannot complete the requested workflow safely or produce its documented useful fallback, and SHALL explain the reason, preserved state, and next action.

#### Scenario: OMS cannot complete safely
- **WHEN** automatic preparation and bounded recovery cannot complete the request
- **AND** continuing would be impossible, ambiguous, or unsafe
- **THEN** OMS exits non-zero
- **AND** identifies the failed operation and why OMS stopped
- **AND** states what user state or partial work was preserved
- **AND** provides an actionable OMS command or bounded repair procedure

#### Scenario: Dangerous action is not automated
- **WHEN** continuing automatically could destroy user work, choose unintended repository topology, or cross the command's documented scope
- **THEN** OMS does not perform that action silently
- **AND** either requests an informed interactive choice or exits with the reason and safe next actions
