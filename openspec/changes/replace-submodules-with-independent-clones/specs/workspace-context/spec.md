# Spec Delta

## ADDED Requirements

### Requirement: Current configured source context
The system SHALL resolve current source context separately from workspace discovery. A current alias SHALL be present only when the current directory is within `oms/<alias>/` for an alias declared by the selected manifest, and existing command-specific alias selection SHALL continue to give an explicit alias precedence over inferred context.

#### Scenario: Current alias inside a configured source checkout
- **WHEN** alias `api` is declared by the selected manifest
- **AND** the user runs a context-aware command within `oms/api/` or one of its descendants
- **THEN** the current source alias resolves to `api`

#### Scenario: Unconfigured path does not become current alias
- **WHEN** the current directory is within `oms/unknown/`
- **AND** `unknown` is not declared by the selected manifest
- **THEN** workspace discovery can still resolve the workspace
- **AND** no current source alias is inferred

#### Scenario: Explicit alias overrides current context
- **WHEN** the current source alias is `api`
- **AND** the user supplies configured alias `web` to a command that supports current-path alias inference
- **THEN** the command selects `web`

### Requirement: Workspace root Git identity
Before a command uses canonical checkouts, managed trees, or root-owned checkout ignore rules, OMS SHALL verify that the selected manifest directory is the canonical root Git top-level. Migration SHALL verify that same boundary before inspecting or modifying legacy root registration state. Doctor SHALL report identity failures.

#### Scenario: Matching root permits source commands
- **WHEN** the selected `oms.yaml` is at the canonical root Git top-level
- **THEN** the command can then validate and use the selected independent checkout

#### Scenario: Nested or indeterminate root fails closed
- **WHEN** the nearest manifest has a missing, mismatched, or indeterminate Git top-level
- **THEN** a command requiring a workspace root fails before inspecting or altering managed Git state and reports the identity problem without falling back to an ancestor manifest

#### Scenario: Equivalent symlink paths match
- **WHEN** the manifest root and Git top-level resolve to the same canonical directory
- **THEN** the root identity check succeeds

#### Scenario: Manifest-only listing does not require Git
- **WHEN** the user runs `oms clone --list` with a valid manifest outside Git
- **THEN** OMS lists declarations without requiring a root Git top-level

#### Scenario: Doctor reports root mismatch
- **WHEN** the manifest is below the enclosing Git top-level
- **THEN** `oms doctor` identifies the mismatch without treating the selected directory as a valid root


## REMOVED Requirements

### Requirement: Current configured submodule context
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Current configured source context.

### Requirement: Submodule root Git identity
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Workspace root Git identity.

