# Spec Delta

## ADDED Requirements

### Requirement: Bounded clone provisioning
OMS SHALL use an existing verified independent checkout without provisioning. Implicitly provisioning a missing checkout SHALL require informed consent and SHALL be offered only for commands that can use a fresh clone. OMS SHALL NOT migrate legacy sources, overwrite occupied paths, or prepare targets for `oms exec`.

#### Scenario: Existing checkout requires no decision
- **WHEN** the selected independent checkout already exists and has no preparation issue
- **THEN** OMS proceeds with the requested command without provisioning or a routine prompt

#### Scenario: Missing source can serve the request
- **WHEN** an eligible interactive operation selects one or more missing clones
- **THEN** OMS offers a single decision explaining which clones would be created and that root Git state is not committed

#### Scenario: Local state is required or consent unavailable
- **WHEN** a missing checkout cannot satisfy the command or the session cannot collect consent
- **THEN** OMS fails before provisioning and gives explicit `oms clone <alias>` guidance

#### Scenario: Alias-specific provisioning failure is isolated
- **WHEN** the user approves several clones and one fails
- **THEN** OMS runs the requested operation only for eligible existing or successfully created clones and reports the partial failure

#### Scenario: Unsafe path or legacy source is present
- **WHEN** an alias cannot be verified as an independent checkout
- **THEN** OMS refuses preparation, preserves the path, and gives repair or migration guidance

#### Scenario: Exec receives a missing or invalid target
- **WHEN** an alias selected by `oms exec` is unavailable
- **THEN** OMS starts no child for that alias and continues for other eligible aliases without any preparation prompt


## REMOVED Requirements

### Requirement: Bounded automatic preparation
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Bounded clone provisioning.

