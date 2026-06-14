## ADDED Requirements

### Requirement: Help documents the status JSON field contract
The `oms status --help` text SHALL accurately document the `schemaVersion` 1 `status --json` field contract, so it serves as an authoritative, version-matched reference for consumers that defer to it.

#### Scenario: Help lists the top-level payload keys
- **WHEN** the user runs `oms status --help`
- **THEN** the help text names the `schemaVersion` 1 top-level keys `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`

#### Scenario: Help names the pointer location correctly
- **WHEN** the user runs `oms status --help`
- **THEN** the help text refers to the submodule pointer arrays as `root.submodulePointers`, with its `moved`, `staged`, `split`, and `conflict` arrays
- **AND** it does not present those arrays as a top-level `pointers` key
