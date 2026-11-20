# Spec Delta

## MODIFIED Requirements

### Requirement: Bounded automatic preparation
OMS SHALL automatically prepare targets when preparation does not change root topology. Preparation that creates root topology SHALL require informed consent to register. Delegated preparation SHALL commit registration changes only when the workspace explicitly enables registration commits. OMS SHALL offer it only if the request does not require local state absent from a new target. Otherwise, OMS SHALL stop with preparation guidance. `oms exec` SHALL use only existing initialized canonical repositories without preparation or preparation prompts. It SHALL report unavailable targets individually and continue with other targets.

#### Scenario: Preparation without topology change is automatic
- **WHEN** a command other than `oms exec` selects a target with registration in the root repository
- **AND** the target has no initialized checkout
- **THEN** OMS initializes the target automatically
- **AND** OMS does not create, stage, or commit root topology during preparation
- **AND** OMS continues toward the requested outcome without a separate command

#### Scenario: Topology preparation can satisfy the request
- **WHEN** a command other than `oms exec` selects a declared target without registration in the root repository
- **AND** the request does not require local state that a new registration cannot contain
- **THEN** OMS presents preparation as an explicit choice, stating its effect on topology and whether the workspace setting enables a registration commit
- **AND** OMS continues toward the requested outcome after the user accepts and preparation succeeds
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
- **AND** OMS commits their registrations together at most once, and only when the workspace enables the commit and safety checks pass
- **AND** OMS does not repeat the choice for each target

#### Scenario: Alias-specific preparation failure is isolated
- **WHEN** some targets fail registration during delegated preparation but shared root finalization succeeds
- **THEN** OMS continues the requested operation only for eligible targets that prepared successfully or needed no preparation
- **AND** it reports per-target outcomes and exits non-zero for the failed preparation

#### Scenario: Shared root finalization failure blocks all follow-on operations
- **WHEN** delegated preparation cannot complete shared root commit or index finalization
- **THEN** OMS does not run the requested operation for any target
- **AND** it reports the failure and retained state, gives recovery guidance, and exits non-zero

#### Scenario: Valid pending registration needs no further preparation
- **WHEN** an eligible command selects a valid pending source registration and does not require a recorded commit
- **THEN** OMS uses the existing checkout and continues without offering to register again or committing the registration
- **AND** this applies to the command that just prepared the registration and to later invocations

#### Scenario: Preparation is refused rather than repaired
- **WHEN** a target has incomplete or conflicting root registration or a pending removal
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
