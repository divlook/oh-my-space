# Spec Delta

## MODIFIED Requirements

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
