## ADDED Requirements

### Requirement: Sync restores pending submodule removals
The system SHALL treat `oms sync` for a selected alias with pending removal topology as a request to restore that submodule, not as a request to add a new submodule at the same path.

#### Scenario: Explicit sync restores an uncommitted unsync
- **WHEN** `oms unsync api` previously removed `oms/api` and its `.gitmodules` entry without creating a topology commit
- **AND** root `HEAD` still records `oms/api` as a submodule gitlink
- **AND** the user runs `oms sync api`
- **THEN** the command restores the selected `api` submodule topology instead of running `git submodule add`
- **AND** the command initializes or updates `oms/api` as needed
- **AND** the command does not fail with `already exists in the index`

#### Scenario: Interactive sync restores a selected pending removal
- **WHEN** `oms unsync api` previously removed `oms/api` and its `.gitmodules` entry without creating a topology commit
- **AND** root `HEAD` still records `oms/api` as a submodule gitlink
- **AND** the user runs `oms sync` and selects only `api`
- **THEN** the command restores the selected `api` submodule topology instead of running `git submodule add`
- **AND** the command does not fail with `already exists in the index`

#### Scenario: Sync restore is scoped to the selected alias
- **WHEN** `api` has pending removal topology
- **AND** another alias is present in the manifest and `.gitmodules`
- **AND** the user runs `oms sync api`
- **THEN** the command restores only the selected `api` submodule topology
- **AND** unrelated alias topology and unrelated `.gitmodules` content edits are preserved
- **AND** pre-existing staged state for `.gitmodules` is not guaranteed to be preserved

#### Scenario: Sync preserves unsafe pending removal guardrails
- **WHEN** the selected alias has pending removal topology that cannot be restored safely because the root gitlink is conflicted, the required `.gitmodules` data cannot be recovered from `HEAD`, the current `.gitmodules` entry for the same alias contains edits that would be overwritten, `oms/api` is occupied by a non-submodule file or directory, or the root repository has a merge, rebase, cherry-pick, or similar operation in progress
- **AND** the user runs `oms sync api`
- **THEN** the command fails before running `git submodule add`
- **AND** the message explains that the pending removal must be resolved or committed before syncing

#### Scenario: Sync restore keeps topology commit policy
- **WHEN** `oms sync api` restores a pending removal successfully
- **THEN** the command follows the existing sync topology finalization policy
- **AND** a plain restore back to the topology recorded in root `HEAD` leaves no pending add/remove topology to commit
- **AND** `oms sync api --commit` creates a root topology commit only when pending topology remains after restore
- **AND** interactive sync without `--commit` prompts according to the existing topology prompt behavior only when pending topology remains after restore
- **AND** the restore path does not add a separate confirmation prompt before restoring the selected alias

#### Scenario: Sync restore reports without changing summary semantics
- **WHEN** `oms sync api` restores a pending removal successfully
- **THEN** the command emits a message explaining that pending removal topology was restored
- **AND** the command summary uses the existing initialized or updated result semantics instead of a new restored result

#### Scenario: Sync restore tolerates a macOS metadata-only directory
- **WHEN** `oms unsync api` previously removed `oms/api` and its `.gitmodules` entry without creating a topology commit
- **AND** root `HEAD` still records `oms/api` as a submodule gitlink
- **AND** `oms/api` exists and contains only `.DS_Store`
- **AND** the user runs `oms sync api`
- **THEN** the command removes `oms/api/.DS_Store`
- **AND** the command restores and initializes `oms/api`
- **AND** the restored submodule is not dirty because of `.DS_Store`

#### Scenario: Sync restore reconciles manifest metadata
- **WHEN** `oms sync api` restores a pending removal successfully
- **AND** the restored `.gitmodules` section has a `url` or explicit `branch` value that differs from `oms.yaml`
- **THEN** the command updates that selected alias metadata in `.gitmodules` from `oms.yaml`
- **AND** those metadata edits remain normal unstaged working tree changes rather than new topology commit semantics
- **AND** the restore message indicates that `.gitmodules` metadata was updated
