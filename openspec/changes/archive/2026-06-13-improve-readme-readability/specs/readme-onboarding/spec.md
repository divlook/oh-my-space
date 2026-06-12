## ADDED Requirements

### Requirement: README Identifies Tool Category Immediately
The README SHALL identify `oh-my-space` as a small CLI for managing multi-repo workspaces with Git submodules before introducing detailed configuration or Git mechanics.

#### Scenario: First-time reader opens README
- **WHEN** a reader starts at the top of `README.md`
- **THEN** the opening content states the tool category and core purpose without requiring prior knowledge of `oms.yaml` or submodule pointer terminology

### Requirement: README Prioritizes Reader Journey
The README SHALL present first-time-reader onboarding content before detailed reference content.

#### Scenario: Reader scans the document structure
- **WHEN** a reader scans the README headings from top to bottom
- **THEN** definition, use cases, a compact usage flow, and layout context appear before exhaustive command reference material

#### Scenario: Reader visualizes workspace layout
- **WHEN** a reader reviews the Layout section
- **THEN** it shows `oms.yaml`, `.gitmodules`, and multiple repositories under `oms/` to connect the declaration file, submodule metadata, and checked-out source repositories

#### Scenario: Reader reviews setup prerequisites
- **WHEN** a reader reaches the early Requirements section
- **THEN** it lists runtime/user requirements without mixing in local development setup commands

### Requirement: README Provides Compact Usage Flow
The README SHALL include a concise usage example that demonstrates the normal `oms` workflow without listing every available command.

#### Scenario: Reader evaluates basic workflow
- **WHEN** a reader reviews the quick-start example
- **THEN** the example shows the flow from initialization or configuration through sync, branch work, push, and recording the resulting pointer update

#### Scenario: Reader follows new-workspace setup
- **WHEN** a reader follows the Quick Start
- **THEN** it shows `oms init`, a minimal one-repository `oms.yaml` with the schema comment and optional `branch` note, `oms sync --all`, and `oms status`

#### Scenario: Reader follows branch workflow
- **WHEN** a reader reviews the Typical branch flow
- **THEN** it shows switching to a local branch, pushing the source repo branch, inspecting parent Git status, and committing the pointer update

### Requirement: README Preserves Reference Coverage
The README SHALL preserve detailed reference information for existing users after the onboarding content.

#### Scenario: Existing user looks up command behavior
- **WHEN** an existing user needs details about commands, requirements, update behavior, `oms.yaml`, or migrations
- **THEN** the README still provides or links to that information after the introductory sections

### Requirement: Package Metadata Matches README Positioning
The package metadata description SHALL use the same product-category framing as the README opening.

#### Scenario: Reader sees package listing before README
- **WHEN** a reader encounters the package description in npm or repository metadata
- **THEN** the description identifies the package as a CLI for managing multi-repo workspaces with Git submodules rather than leading with `oms.yaml` configuration details
