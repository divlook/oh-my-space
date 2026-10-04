# cli-automation-policy Specification

## Purpose
Define when OMS completes routine preparation and bounded recovery automatically, when repository changes require informed user intent, and how terminal failures report preserved state and actionable next steps.

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
OMS SHALL automatically prepare targets when preparation does not change root topology. Preparation that creates root topology SHALL require informed consent. OMS SHALL offer it only if the request does not require local state absent from a new target. Otherwise, OMS SHALL stop with preparation guidance. `oms exec` SHALL use only existing initialized canonical repositories without preparation or preparation prompts. It SHALL report unavailable targets individually and continue with other targets.

#### Scenario: Preparation without topology change is automatic
- **WHEN** a command other than `oms exec` selects a target with registration in the root repository
- **AND** the target has no initialized checkout
- **THEN** OMS initializes the target automatically
- **AND** OMS does not create, stage, or commit root topology during preparation
- **AND** OMS continues toward the requested outcome without a separate command

#### Scenario: Topology preparation can satisfy the request
- **WHEN** a command other than `oms exec` selects a declared target without registration in the root repository
- **AND** the request does not require local state that a new registration cannot contain
- **THEN** OMS presents preparation and its effect on topology as an explicit choice
- **AND** OMS completes the requested outcome after the user accepts
- **AND** OMS leaves root topology unchanged if the user declines

#### Scenario: Topology preparation cannot satisfy the request
- **WHEN** a command selects a declared target without registration in the root repository
- **AND** the request requires local state that a new registration cannot contain
- **THEN** OMS does not offer or perform preparation
- **AND** OMS exits non-zero with a message that identifies the missing registration
- **AND** OMS identifies the preparation command that registers the target

#### Scenario: Topology preparation is unavailable non-interactively
- **WHEN** a workflow requires preparation that creates root topology
- **AND** stdin is non-interactive
- **THEN** OMS exits non-zero without creating root topology
- **AND** OMS identifies the preparation command needed to supply that decision

#### Scenario: Preparation is decided once for a whole selection
- **WHEN** one invocation selects several targets
- **AND** more than one target requires preparation that creates root topology
- **THEN** OMS presents one choice for all targets that need this preparation
- **AND** OMS prepares accepted targets together
- **AND** OMS records their topology once
- **AND** OMS does not repeat the choice for each target

#### Scenario: Preparation is refused rather than repaired
- **WHEN** a target has inconsistent root registration or a pending addition or removal
- **THEN** OMS does not attempt automatic preparation or repair
- **AND** OMS exits non-zero with a message that identifies the inconsistent registration
- **AND** OMS provides the command that repairs it

#### Scenario: Exec does not prepare unavailable targets
- **WHEN** `oms exec` selects a registered but uninitialized target or a declared but unregistered target
- **THEN** OMS leaves its registration and checkout state unchanged
- **AND** OMS does not prompt for preparation
- **AND** OMS reports that alias as failed with `oms sync <alias>` guidance
- **AND** OMS continues executing in later eligible targets
- **AND** OMS returns a non-zero exit code for the invocation

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
