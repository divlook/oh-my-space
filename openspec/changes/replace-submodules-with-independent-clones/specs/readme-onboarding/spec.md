# Spec Delta

## ADDED Requirements

### Requirement: Workspace Documentation Uses Accessible Language
The README and linked user guides SHALL use concise, task-oriented English that explains user-visible outcomes before implementation details and introduces unavoidable Git terminology in plain language.

#### Scenario: Reader encounters a technical term
- **WHEN** a Git or OMS term is necessary to understand output, make a decision, or recover from a failure
- **THEN** the documentation explains the concept in familiar language before or alongside the exact term

#### Scenario: Reader follows a normal workflow
- **WHEN** a section includes both a common workflow and exceptional behavior
- **THEN** the common actions appear before separately identified edge cases or recovery details

#### Scenario: Safety behavior needs explanation
- **WHEN** documentation describes a command restriction or protected state
- **THEN** it states the user-visible restriction and why it protects the user's work

## MODIFIED Requirements

### Requirement: README Identifies Tool Category Immediately
The README SHALL identify `oh-my-space` as a small CLI for managing multi-repo workspaces with independent Git clones before introducing detailed configuration or Git mechanics.

#### Scenario: First-time reader opens README
- **WHEN** a reader starts at the top of `README.md`
- **THEN** the opening content states the tool category and core purpose without requiring prior knowledge of `oms.yaml` or source commit pinning terminology

### Requirement: README Provides Compact Usage Flow
The README SHALL include a concise first-use example that reaches a synchronized workspace and visible status without listing the complete daily development workflow or every command.

#### Scenario: Reader follows new-workspace setup
- **WHEN** a reader follows the README Quick Start
- **THEN** it shows `oms init`, a minimal one-repository `oms.yaml` with the schema comment and optional `branch` note, `oms clone --all`, and `oms status`

#### Scenario: Reader continues to everyday work
- **WHEN** a reader wants to switch branches, commit, or push source changes after completing the README Quick Start
- **THEN** the README directs the reader to the getting-started guide for the complete workflow

### Requirement: Documentation Is Organized by Reader Intent
The user-facing documentation SHALL separate detailed guidance into focused documents with one primary owner for each subject rather than repeating full explanations across the README and multiple guides.

#### Scenario: New user needs a complete first workflow
- **WHEN** a reader follows the documentation link for getting started
- **THEN** `docs/getting-started.md` covers setup, first synchronization, and a complete branch, commit, and push workflow with no pointer-recording step

#### Scenario: User needs to understand workspace behavior
- **WHEN** a reader follows the documentation link for how OMS works
- **THEN** `docs/how-oms-works.md` explains workspace layout, repository boundaries, machine-local branches, synchronization, status, safety behavior, failures, and recovery

#### Scenario: User needs command or configuration guidance
- **WHEN** a reader follows the relevant documentation link
- **THEN** `docs/commands.md` explains command selection and affected repositories, while `docs/configure-your-workspace.md` explains `oms.yaml` with examples

#### Scenario: Specialized reader needs focused guidance
- **WHEN** a reader needs AI coding tool, contributor, release-channel, or migration guidance
- **THEN** the README links to the corresponding focused document or migration index under `docs/`, and that owner preserves the currently documented guidance for its subject

#### Scenario: Existing user migrates a multi-computer workspace
- **WHEN** a reader follows the migration guide
- **THEN** the guide explains when to migrate each computer, how to preserve local work, and why a converted root no longer reproduces exact source commits
- **AND** before updating another computer's root, it advises running `oms migrate --dry-run` and safeguarding local working files
- **AND** after the update, it explains that migration can recover only data still present and cannot restore missing uncommitted files

### Requirement: Package Metadata Matches README Positioning
The package metadata description SHALL use the same product-category framing as the README opening.

#### Scenario: Reader sees package listing before README
- **WHEN** a reader encounters the package description in npm or repository metadata
- **THEN** the description identifies the package as a CLI for managing multi-repo workspaces with independent Git clones rather than leading with `oms.yaml` configuration details

## REMOVED Requirements

### Requirement: User Documentation Uses Accessible Language
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Workspace Documentation Uses Accessible Language.

