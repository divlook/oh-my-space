## ADDED Requirements

### Requirement: Nearest manifest workspace discovery
The system SHALL discover a workspace by walking from the current directory toward the filesystem root and selecting the nearest `oms.yaml` regular file. A symbolic link SHALL qualify as a regular-file candidate only when its target is a regular file. The first encountered `oms.yaml` entry SHALL be authoritative, and the system SHALL NOT fall back to a more distant manifest when that entry is broken, does not resolve to a regular file, or its contents are invalid.

#### Scenario: Command runs from a workspace descendant
- **WHEN** the user runs a workspace-aware command below a directory containing a valid `oms.yaml`
- **THEN** the command resolves that manifest directory as the workspace root

#### Scenario: Nearest nested workspace wins
- **WHEN** both an inner directory and one of its ancestors contain valid `oms.yaml` files
- **AND** the user runs a workspace-aware command within the inner workspace
- **THEN** the command selects the inner manifest

#### Scenario: Non-file manifest candidate fails closed
- **WHEN** the nearest `oms.yaml` entry exists but is not a regular file
- **THEN** workspace discovery fails with an actionable manifest-type error
- **AND** the command does not fall back to an ancestor manifest

#### Scenario: Manifest symbolic link targets a regular file
- **WHEN** the nearest `oms.yaml` entry is a symbolic link whose target is a regular file
- **THEN** workspace discovery selects that manifest candidate

#### Scenario: Invalid manifest symbolic link fails closed
- **WHEN** the nearest `oms.yaml` entry is a broken symbolic link or resolves to a non-file target
- **THEN** workspace discovery fails with an actionable manifest-type error
- **AND** the command does not fall back to an ancestor manifest

#### Scenario: Invalid nearest manifest fails closed
- **WHEN** the nearest `oms.yaml` file cannot be parsed or validated
- **THEN** workspace loading fails with the validation error
- **AND** the command does not fall back to an ancestor manifest

### Requirement: Current configured submodule context
The system SHALL resolve current submodule context separately from workspace discovery. A current alias SHALL be present only when the current directory is within `oms/<alias>/` for an alias declared by the selected manifest, and existing command-specific alias selection SHALL continue to give an explicit alias precedence over inferred context.

#### Scenario: Current alias inside a configured submodule
- **WHEN** alias `api` is declared by the selected manifest
- **AND** the user runs a context-aware command within `oms/api/` or one of its descendants
- **THEN** the current submodule alias resolves to `api`

#### Scenario: Unconfigured path does not become current alias
- **WHEN** the current directory is within `oms/unknown/`
- **AND** `unknown` is not declared by the selected manifest
- **THEN** workspace discovery can still resolve the workspace
- **AND** no current submodule alias is inferred

#### Scenario: Explicit alias overrides current context
- **WHEN** the current submodule alias is `api`
- **AND** the user supplies configured alias `web` to a command that supports current-path alias inference
- **THEN** the command selects `web`

### Requirement: Submodule root Git identity
Before `status`, `commit`, `record`, `branch switch`, `branch checkout`, `branch list`, `branch delete`, `fetch`, `pull`, `push`, `unsync`, or mutating `sync` inspects or mutates submodule state, the system SHALL verify that the selected manifest directory and Git's root top-level are the same canonical filesystem directory. A missing, mismatched, or indeterminate Git root SHALL fail before submodule topology, root index, manifest, or managed-directory side effects. `doctor` SHALL perform the same identity check as a diagnostic without treating a failed check as a valid root.

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
