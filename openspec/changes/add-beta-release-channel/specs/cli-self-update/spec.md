## MODIFIED Requirements

### Requirement: Update confident global installations
The system SHALL update the current CLI installation automatically only when the installation is confidently classified as global and a newer npm registry version exists for the selected update target.

#### Scenario: Interactive stable global update
- **WHEN** the user runs `oms update`, the installed version is stable, a newer stable version exists, and a confident global update command is available
- **THEN** the command displays the current version, latest version, detected context, selected `latest` channel, and package-manager command before asking for confirmation

#### Scenario: User confirms stable global update
- **WHEN** the user confirms the interactive update prompt for a stable-channel update
- **THEN** the command runs the selected package-manager global update command for `oh-my-space@latest`

#### Scenario: User declines global update
- **WHEN** the user declines the interactive update prompt
- **THEN** the command exits without running any package-manager update command

#### Scenario: Non-interactive confirmed stable global update
- **WHEN** the user runs `oms update --yes`, the installed version is stable, a newer stable version exists, and a confident global update command is available
- **THEN** the command runs the selected package-manager global update command for `oh-my-space@latest` without prompting

#### Scenario: Prerelease installation targets are explicit
- **WHEN** the user runs `oms update` from a prerelease installation
- **THEN** the command output identifies that the installed version is a prerelease
- **AND** the command output identifies whether the selected automatic update target is the stable `latest` channel or guidance-only beta channel

#### Scenario: Non-global update with yes flag
- **WHEN** the user runs `oms update --yes` from a project-local, temporary, development, or unknown installation context
- **THEN** the command refuses automatic mutation and prints safe guidance instead

## ADDED Requirements

### Requirement: Provide prerelease channel update guidance
The system SHALL provide clear guidance when the installed CLI version is a prerelease or beta version.

#### Scenario: Check update from beta installation
- **WHEN** the user runs `oms update --check` from a prerelease installation
- **THEN** the command reports the installed prerelease version
- **AND** the command reports the current stable `latest` version when it can be resolved
- **AND** the command explains how to install the beta channel manually when beta channel updates are not applied automatically

#### Scenario: Returning from beta to stable
- **WHEN** a beta user wants the stable channel
- **THEN** the update guidance includes a command targeting `oh-my-space@latest`

#### Scenario: Staying on beta manually
- **WHEN** beta channel automatic updates are not supported
- **THEN** the update guidance includes a command targeting `oh-my-space@beta`
