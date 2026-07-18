## MODIFIED Requirements

### Requirement: README Identifies Tool Category Immediately
The README SHALL identify `oh-my-space` as a small CLI for managing multi-repo workspaces with Git submodule and worktree modes before introducing detailed configuration or Git mechanics.

#### Scenario: First-time reader opens README
- **WHEN** a reader starts at the top of `README.md`
- **THEN** the opening content states the tool category and the two repository modes
- **AND** does not require prior knowledge of `oms.yaml`, gitlink pointers, or linked-worktree metadata

### Requirement: README Prioritizes Reader Journey
The README SHALL present first-time-reader onboarding and mode selection before detailed reference content.

#### Scenario: Reader scans the document structure
- **WHEN** a reader scans README headings from top to bottom
- **THEN** definition, mode trade-offs, use cases, compact usage flows, and layout context appear before exhaustive command reference material

#### Scenario: Reader visualizes submodule layout
- **WHEN** a reader reviews the submodule layout
- **THEN** it shows `oms.yaml`, `.gitmodules`, and submodules under `oms/`
- **AND** connects root commits with reproducible gitlink pointers

#### Scenario: Reader visualizes worktree layout
- **WHEN** a reader reviews the worktree layout
- **THEN** it shows `.oms/repos/<alias>.git` and named worktrees under `oms/<alias>/`
- **AND** states that generated checkout state is local and not pinned by parent history

#### Scenario: Reader reviews setup prerequisites
- **WHEN** a reader reaches the early Requirements section
- **THEN** it lists Node and Git 2.48 requirements without mixing in local development setup commands

### Requirement: README Provides Compact Usage Flow
The README SHALL include concise mode-specific examples that demonstrate normal OMS workflows without listing every command.

#### Scenario: Reader follows submodule quick start
- **WHEN** a reader chooses submodule mode
- **THEN** the example shows init or an omitted mode, manifest configuration, sync, source work, push, and pointer recording

#### Scenario: Reader follows worktree quick start
- **WHEN** a reader chooses worktree mode
- **THEN** the example shows `oms init --mode worktree`, sync, worktree add/list, target-scoped source work, and push
- **AND** does not suggest `oms record`

#### Scenario: Reader compares branch workflows
- **WHEN** a reader reviews typical branch work
- **THEN** submodule mode shows switching the single checkout and recording pointer movement
- **AND** worktree mode shows concurrent named checkouts addressed as `alias/name`

### Requirement: Package Metadata Matches README Positioning
The package metadata description SHALL use the same mode-neutral multi-repo workspace framing as the README opening.

#### Scenario: Reader sees package listing before README
- **WHEN** a reader encounters package metadata
- **THEN** it identifies OMS as a CLI for multi-repo workspaces
- **AND** does not describe Git submodules as the only supported storage model
