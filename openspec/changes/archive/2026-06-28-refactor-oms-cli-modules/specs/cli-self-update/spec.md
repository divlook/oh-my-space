## ADDED Requirements

### Requirement: Internal refactors preserve self-update behavior
The system SHALL preserve self-update behavior when install-context detection and update helpers are moved between internal modules.

The baseline for preservation SHALL be the behavior covered by the existing OpenSpec requirements, the pre-refactor `npm test` result, and the focused update/doctor CLI behavior checks captured before implementation.

#### Scenario: Update check behavior remains stable after module refactor
- **WHEN** install-context helper code is moved out of the doctor command implementation
- **AND** the user runs `oms update --check`
- **THEN** the command continues to compare the installed version with the npm registry latest version
- **AND** the command does not mutate the installation
- **AND** registry retrieval and parse failures still fail with clear errors before any package-manager command runs

#### Scenario: Installation context classification remains stable after extraction
- **WHEN** install-context detection is extracted into a neutral helper module
- **THEN** global, project-local, temporary runner, development, and unknown installation contexts are classified using the same runtime evidence as before the extraction
- **AND** selected update commands and warning messages remain equivalent for each context

#### Scenario: Automatic update safety remains unchanged
- **WHEN** the user runs `oms update` or `oms update --yes` after the refactor
- **THEN** automatic mutation is still allowed only for confident global installations with an available update command
- **AND** non-global contexts continue to receive guidance without mutating package manifests, lockfiles, runner caches, or development checkouts

#### Scenario: Doctor and update share neutral install-context helpers
- **WHEN** `oms doctor` and `oms update` need installation context or update-command formatting after the refactor
- **THEN** both commands use the same neutral internal helper module rather than one command module importing implementation details from the other
- **AND** this internal dependency change does not alter user-visible output semantics, exit-code behavior, or safety guidance compared with the established baseline
