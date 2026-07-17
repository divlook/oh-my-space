## ADDED Requirements

### Requirement: Init validates its Git workspace target before writing
Before creating or overwriting `oms.yaml`, `oms init` SHALL determine whether the current directory is inside an existing Git work tree. It SHALL proceed when the current directory is the canonical Git top-level or is outside any Git work tree, and SHALL reject a current directory below an existing Git top-level before creating, overwriting, or modifying workspace files. If Git inspection or filesystem canonicalization cannot determine the target's Git-root relationship, `oms init` SHALL fail before any write.

#### Scenario: Init at Git top-level succeeds
- **WHEN** the user runs `oms init` at the canonical root Git top-level
- **THEN** `oms.yaml` is scaffolded in the current directory
- **AND** the normal onboarding guidance is printed

#### Scenario: Init outside Git remains supported
- **WHEN** the user runs `oms init` in a directory outside any Git work tree
- **THEN** `oms.yaml` is scaffolded in the current directory
- **AND** the output retains guidance to initialize Git for submodule management

#### Scenario: Init below an existing Git top-level fails before writes
- **WHEN** the user runs `oms init` in a child directory of an existing Git work tree
- **THEN** the command fails before creating or overwriting `oms.yaml`
- **AND** the command does not modify `.gitignore` or other workspace files
- **AND** the diagnostic identifies the actual Git top-level and instructs the user to initialize at a valid workspace root

#### Scenario: Force does not bypass nested-root protection
- **WHEN** the user runs `oms init --force` in a child directory of an existing Git work tree
- **THEN** the command fails before overwriting an existing `oms.yaml`

#### Scenario: Init fails when target identity is indeterminate
- **WHEN** Git inspection or filesystem canonicalization cannot determine whether the current directory is a valid workspace target
- **AND** the user runs `oms init` with or without `--force`
- **THEN** the command fails before creating or overwriting `oms.yaml`
- **AND** the command does not modify `.gitignore` or other workspace files
