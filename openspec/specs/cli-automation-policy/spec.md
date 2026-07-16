# cli-automation-policy Specification

## Purpose
TBD - created by syncing change add-branch-list. Update Purpose after archive.

## Requirements
### Requirement: Automation-first command completion
OMS new and changed command workflows SHALL automatically perform routine, deterministic, and bounded preparation or recovery that OMS can complete safely, rather than failing and requiring the user to reproduce those steps manually. Existing workflows that are not changed remain outside this requirement until they are subsequently changed.

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
