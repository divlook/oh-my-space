## ADDED Requirements

### Requirement: Documentation Is Organized by Reader Intent
The user-facing documentation SHALL separate detailed guidance into focused documents with one primary owner for each subject rather than repeating full explanations across the README and multiple guides.

#### Scenario: New user needs a complete first workflow
- **WHEN** a reader follows the documentation link for getting started
- **THEN** `docs/getting-started.md` covers setup, first synchronization, and a complete branch, commit, push, and record workflow

#### Scenario: User needs to understand workspace behavior
- **WHEN** a reader follows the documentation link for how OMS works
- **THEN** `docs/how-oms-works.md` explains workspace layout, repository boundaries, recorded commits, synchronization, status, safety behavior, failures, and recovery

#### Scenario: User needs command or configuration guidance
- **WHEN** a reader follows the relevant documentation link
- **THEN** `docs/commands.md` explains command selection and affected repositories, while `docs/configure-your-workspace.md` explains `oms.yaml` with examples

#### Scenario: Specialized reader needs focused guidance
- **WHEN** a reader needs AI coding tool, contributor, release-channel, or migration guidance
- **THEN** the README links to the corresponding focused document or migration index under `docs/`, and that owner preserves the currently documented guidance for its subject

### Requirement: User Documentation Uses Accessible Language
The README and linked user guides SHALL use concise, task-oriented English that explains user-visible outcomes before implementation details and introduces unavoidable Git terminology in plain language.

#### Scenario: Reader encounters a technical term
- **WHEN** a Git or OMS term is necessary to understand output, make a decision, or recover from a failure
- **THEN** the documentation explains the concept in familiar language before or alongside the exact term

#### Scenario: Reader follows a normal workflow
- **WHEN** a section includes both a common workflow and exceptional behavior
- **THEN** the common actions appear before separately identified edge cases or recovery details

#### Scenario: Reader encounters the recorded repository state
- **WHEN** documentation refers to the submodule commit stored by the main project
- **THEN** it consistently uses “the commit recorded by the main project” or “recorded commit” instead of switching among implementation-specific synonyms

#### Scenario: Safety behavior needs explanation
- **WHEN** documentation describes a command restriction or protected state
- **THEN** it states the user-visible restriction and why it protects the user's work

### Requirement: Command Documentation Has a Single Exact Reference
User guides SHALL explain which command to choose, which repository it affects, its normal workflow, and its major safety behavior, while treating `oms <command> --help` as authoritative for exact arguments, options, and exit codes.

#### Scenario: User needs exact command syntax
- **WHEN** a reader needs the complete arguments, options, or exit-code contract for a command
- **THEN** the command guide directs the reader to that command's built-in help instead of maintaining a duplicated exhaustive contract

#### Scenario: User needs to choose a command safely
- **WHEN** a reader reviews `docs/commands.md`
- **THEN** the guide provides enough purpose, repository-boundary, and safety information to choose the appropriate command before consulting exact syntax

### Requirement: Published README Links Reach Detailed Documentation
Documentation links in the README SHALL work when the README is viewed on GitHub or rendered from the npm package without requiring `docs/` to be included in the published package.

#### Scenario: npm reader opens detailed guidance
- **WHEN** a reader follows a documentation link from the README rendered on npm
- **THEN** the link opens the corresponding document in the GitHub repository's `main` branch

#### Scenario: Reader follows links within documentation
- **WHEN** a reader follows a link between files under `docs/`
- **THEN** the relative link resolves within a local checkout and on GitHub

#### Scenario: Existing migration guide links to moved content
- **WHEN** a README section referenced by a migration guide moves into a focused document
- **THEN** the migration guide links to the new owning document and section rather than the removed README anchor

## MODIFIED Requirements

### Requirement: README Prioritizes Reader Journey
The README SHALL function as a concise product landing page and SHALL move detailed operational and reference material into linked documents.

#### Scenario: Reader scans the document structure
- **WHEN** a reader scans the README headings from top to bottom
- **THEN** the document presents the product definition, intended audience or representative use cases, and benefits; requirements and installation; a minimal quick start; purpose-based documentation links; and the license, without an exhaustive command reference

#### Scenario: Reader reviews setup prerequisites
- **WHEN** a reader reaches the early requirements or installation content
- **THEN** it lists runtime and user requirements without mixing in contributor setup or local development commands

#### Scenario: Existing user looks for detailed behavior
- **WHEN** a reader needs workspace mechanics, command behavior, configuration details, AI coding guidance, migration instructions, or contributor information
- **THEN** the README points to the focused document that owns that subject instead of embedding the complete reference

### Requirement: README Provides Compact Usage Flow
The README SHALL include a concise first-use example that reaches a synchronized workspace and visible status without listing the complete daily development workflow or every command.

#### Scenario: Reader follows new-workspace setup
- **WHEN** a reader follows the README Quick Start
- **THEN** it shows `oms init`, a minimal one-repository `oms.yaml` with the schema comment and optional `branch` note, `oms sync --all`, and `oms status`

#### Scenario: Reader continues to everyday work
- **WHEN** a reader wants to switch branches, commit, push, or record a new repository commit after completing the README Quick Start
- **THEN** the README directs the reader to the getting-started guide for the complete workflow

### Requirement: README Preserves Reference Coverage
The README SHALL keep all existing user-facing reference subjects discoverable through purpose-based links while each detailed subject remains in its focused documentation owner.

#### Scenario: Existing user looks up command behavior
- **WHEN** an existing user needs details about commands, requirements, synchronization behavior, `oms.yaml`, or migrations
- **THEN** the README provides a direct description and link for the relevant focused document

#### Scenario: Reader needs safety or recovery details
- **WHEN** a reader needs protected-branch rules, commit-identity rechecks, preparation classifications, OMS-managed metadata updates, partial-success behavior, preserved-state information, or a recovery command
- **THEN** the focused workspace or command documentation preserves that user-visible contract even though it is no longer embedded in the README
