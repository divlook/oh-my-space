# Delta: workspace-context

## MODIFIED Requirements

### Requirement: Submodule root Git identity

Before `status`, `commit`, `record`, `branch switch`, `branch checkout`, `branch list`, `branch delete`, `fetch`, `pull`, `push`, `unsync`, `tree add`, `tree list`, `tree remove`, or mutating `sync` inspects or mutates submodule state, the system SHALL verify that the selected manifest directory and Git's root top-level are the same canonical filesystem directory. A missing, mismatched, or indeterminate Git root SHALL fail before submodule topology, root index, manifest, or managed-directory side effects. `doctor` SHALL perform the same identity check as a diagnostic without treating a failed check as a valid root.

#### Scenario: Matching root permits submodule command

- **WHEN** `oms.yaml` is located at the root Git top-level
- **AND** the user runs a command that requires root submodule state
- **THEN** the Git-root precondition succeeds

#### Scenario: Nested manifest is rejected before mutation

- **WHEN** `oms.yaml` is located below the enclosing root Git top-level
- **AND** the user runs a mutating submodule command
- **THEN** the command fails before changing the root index, `.gitmodules`, `oms/`, or `oms.yaml`
- **AND** the diagnostic identifies both the manifest directory and the actual Git top-level
- **AND** the diagnostic explains how to establish a valid workspace root

#### Scenario: Tree commands are rejected at a nested manifest

- **WHEN** `oms.yaml` is located below the enclosing root Git top-level
- **AND** the user runs `oms tree add`, `oms tree list`, or `oms tree remove`
- **THEN** the command fails before creating, reading, or removing anything under `.oms-tree/`
- **AND** the diagnostic identifies both the manifest directory and the actual Git top-level

#### Scenario: Equivalent symlink paths match

- **WHEN** the manifest directory and Git top-level use different path spellings that resolve to the same canonical directory
- **THEN** the Git-root precondition succeeds

#### Scenario: Required Git root is missing

- **WHEN** a valid `oms.yaml` exists outside a Git repository
- **AND** the user runs a command that requires submodule state
- **THEN** the command fails before submodule topology, manifest, or managed-directory side effects

#### Scenario: Git root identity is indeterminate

- **WHEN** Git inspection or filesystem canonicalization cannot determine whether the manifest directory is the root Git top-level
- **AND** the user runs a command that requires submodule state
- **THEN** the command fails before submodule topology, root index, manifest, or managed-directory side effects
- **AND** the diagnostic explains that workspace identity could not be verified and suggests retrying after the path and Git repository are accessible

#### Scenario: Manifest-only listing does not require Git

- **WHEN** a valid `oms.yaml` exists outside a Git repository
- **AND** the user runs `oms sync --list`
- **THEN** the declared repositories are listed without requiring a root Git top-level

#### Scenario: Doctor reports root mismatch

- **WHEN** the selected manifest directory is below an enclosing Git top-level
- **AND** the user runs `oms doctor`
- **THEN** doctor reports the root mismatch directly
- **AND** doctor does not report the manifest directory as a valid root Git repository
