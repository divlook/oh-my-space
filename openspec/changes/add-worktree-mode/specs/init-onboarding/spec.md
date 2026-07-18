## MODIFIED Requirements

### Requirement: Init validates its Git workspace target before writing
Before creating or overwriting `oms.yaml`, `oms init` SHALL validate `--mode` as `submodule` or `worktree`. Submodule init SHALL proceed only at the canonical Git top-level or outside a Git work tree, while worktree init SHALL also permit a directory below an enclosing Git top-level. If Git inspection or filesystem canonicalization cannot determine the target relationship needed by the selected mode, init SHALL fail before any write.

#### Scenario: Default init at Git top-level succeeds
- **WHEN** the user runs `oms init` at the canonical root Git top-level
- **THEN** `oms.yaml` is scaffolded with the backward-compatible submodule template
- **AND** normal onboarding guidance is printed

#### Scenario: Explicit worktree init records mode
- **WHEN** the user runs `oms init --mode worktree`
- **THEN** the scaffolded manifest contains top-level `mode: worktree`
- **AND** its next-step guidance describes worktree sync rather than root submodule recording

#### Scenario: Submodule init outside Git remains supported
- **WHEN** the user runs default or `--mode submodule` init outside any Git work tree
- **THEN** `oms.yaml` is scaffolded
- **AND** output retains guidance to initialize Git before submodule sync

#### Scenario: Worktree init outside Git requires no Git root
- **WHEN** the user runs `oms init --mode worktree` outside any Git work tree
- **THEN** `oms.yaml` is scaffolded without Git-init guidance as a prerequisite

#### Scenario: Nested submodule init fails before writes
- **WHEN** the user runs default or `--mode submodule` init below an existing Git top-level
- **THEN** init fails before creating or overwriting `oms.yaml`
- **AND** does not modify Git ignore or exclude files
- **AND** identifies the actual Git top-level

#### Scenario: Nested worktree init succeeds
- **WHEN** the user runs `oms init --mode worktree` below an existing Git top-level
- **THEN** the current directory becomes the workspace root
- **AND** the enclosing Git repository is treated only as optional context

#### Scenario: Force respects selected-mode validation
- **WHEN** the selected mode's target validation fails
- **AND** the user supplies `--force`
- **THEN** init fails before overwriting an existing manifest

#### Scenario: Init fails when target identity is indeterminate
- **WHEN** required Git inspection or filesystem canonicalization is indeterminate
- **THEN** init fails before creating or overwriting `oms.yaml`
- **AND** does not modify Git ignore or exclude files
