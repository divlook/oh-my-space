## ADDED Requirements

### Requirement: Mode-aware current repository context
The system SHALL resolve current repository context separately from nearest-manifest workspace discovery. In worktree mode it SHALL infer both alias and managed worktree name only inside `oms/<alias>/<name>/`, while explicit repository or `alias/name` arguments retain precedence.

#### Scenario: Current managed worktree resolves
- **WHEN** the selected manifest declares alias `api` in worktree mode
- **AND** the current directory is inside `oms/api/login/`
- **THEN** current alias resolves to `api`
- **AND** current worktree resolves to `login`
- **AND** current target resolves to `api/login`

#### Scenario: Alias directory alone is not a worktree
- **WHEN** the current directory is `oms/api/` but not inside a registered managed worktree
- **THEN** current alias may resolve to `api`
- **AND** current worktree and current target are null

#### Scenario: External worktree has no managed target
- **WHEN** the command runs inside a linked worktree outside the selected workspace
- **THEN** nearest-manifest discovery does not invent an OMS target for that external path

#### Scenario: Explicit target overrides current target
- **WHEN** current target is `api/login`
- **AND** the user supplies target `web/home`
- **THEN** the command selects `web/home`

### Requirement: Worktree workspace Git independence
A worktree-mode workspace SHALL operate when its manifest directory is outside Git, equals a Git top-level, or is nested below an enclosing Git top-level. The enclosing Git repository SHALL be contextual status and local-exclude scope, not a worktree-mode topology owner.

#### Scenario: Plain directory workspace
- **WHEN** a valid worktree-mode manifest exists outside every Git work tree
- **THEN** workspace commands may manage common repositories and worktrees
- **AND** status reports `root: null`

#### Scenario: Nested worktree workspace
- **WHEN** a valid worktree-mode manifest is below an enclosing Git top-level
- **THEN** the manifest directory remains the workspace root
- **AND** worktree-mode mutations do not require it to equal the enclosing Git root
- **AND** status reports the enclosing Git path with ancestor relation

#### Scenario: Submodule precondition remains mode-specific
- **WHEN** the same nested manifest selects submodule mode
- **THEN** existing submodule Git-root identity checks reject topology commands before mutation
