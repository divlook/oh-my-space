## Purpose

Define how the `oms` CLI checks for and applies safe self-updates from the npm registry.

## Requirements

### Requirement: Check latest CLI version
The system SHALL allow users to check whether the installed `oms` CLI is older than the latest `oh-my-space` version published to the npm registry.

#### Scenario: Installed version is current
- **WHEN** the user runs `oms update --check` and the installed version is equal to the npm registry latest version
- **THEN** the command reports that `oms` is up to date and exits successfully without mutating the installation

#### Scenario: Newer version is available
- **WHEN** the user runs `oms update --check` and the npm registry latest version is newer than the installed version
- **THEN** the command reports the current version, the latest version, and that an update is available without mutating the installation

#### Scenario: Latest version cannot be resolved
- **WHEN** the command cannot retrieve or parse the npm registry latest version
- **THEN** the command fails with a clear error and does not run any package-manager update command

### Requirement: Detect installation context
The system SHALL inspect the running CLI package location and related runtime evidence to classify the current installation context before selecting any update action.

#### Scenario: Confident global installation is detected
- **WHEN** the running CLI is identified as a persistent global `oh-my-space` installation managed by npm, pnpm, Yarn, or Bun
- **THEN** the command reports the detected global scope, package manager, and selected update command

#### Scenario: Project-local installation is detected
- **WHEN** the running CLI is identified as a project-local dependency
- **THEN** the command reports that project-local installations are guidance-only and does not modify the project manifest or lockfile

#### Scenario: Temporary runner installation is detected
- **WHEN** the running CLI is identified as being executed through a one-shot runner such as npx, pnpm dlx, yarn dlx, or bunx
- **THEN** the command reports that there is no persistent installation to update and does not modify runner caches

#### Scenario: Installation context is unknown
- **WHEN** the command cannot confidently classify the installation context
- **THEN** the command reports the uncertainty and does not run any package-manager update command

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

### Requirement: Provide safe update guidance
The system SHALL provide actionable manual update guidance when it cannot or must not update automatically.

#### Scenario: Guidance for unsupported automatic update
- **WHEN** automatic update is not available for the detected context
- **THEN** the command prints one or more manual install commands for updating `oh-my-space` with supported package managers

#### Scenario: Already current installation
- **WHEN** the installed version is already the npm registry latest version
- **THEN** the command exits without prompting for update or running a package-manager command

### Requirement: Provide prerelease channel update guidance
The system SHALL provide clear guidance when the installed CLI version is a prerelease or beta version. When the installation context identifies a package manager, the guidance SHALL use commands for that package manager. When no package manager can be confidently selected, the guidance SHALL provide supported package-manager alternatives.

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

#### Scenario: Prerelease guidance matches detected package manager
- **WHEN** the user runs `oms update --check` from a prerelease installation and the installation context identifies a package manager
- **THEN** the beta and stable guidance uses commands for the detected package manager

#### Scenario: Prerelease guidance without a detected package manager
- **WHEN** the user runs `oms update --check` from a prerelease installation and no package manager can be confidently selected
- **THEN** the beta and stable guidance includes supported package-manager alternatives
