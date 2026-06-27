## ADDED Requirements

### Requirement: Root topology actions share a consistent safety preflight
The system SHALL provide one shared root-topology safety preflight in the status spine and route the root-touching commands through it, so the guard set evolves in one place rather than being re-implemented per command. The preflight SHALL classify, for a selected alias, whether the root gitlink is conflicted, whether the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar operation in progress, and whether `oms/<alias>` is occupied by a non-submodule file or directory. Each routed command SHALL apply the subset of these checks that is meaningful for it, refuse before mutating Git state when an applied check fails, fail with a deterministic OMS message instead of leaking a raw Git error, and return a non-zero exit code.

The checks applicable to each command are:
- `oms unsync` SHALL apply all three checks (conflicted gitlink, in-progress root operation, and occupied non-submodule path), reaching parity with `oms sync`'s existing data-loss protection.
- `oms record` SHALL apply the conflicted-gitlink and in-progress-root-operation checks. The occupied-non-submodule-path check does not apply because `record` neither creates nor occupies `oms/<alias>`; its existing record-specific checks and message ordering are preserved.
- `oms sync` already refuses on an occupied non-submodule path (its `!registered` branch) and on unsafe pending-removal restore states (conflicted gitlink or in-progress root operation while restoring). Its observable behavior is unchanged by this change; it consumes the same shared spine primitives (`gitlinkState`, `gitOperationInProgress`, `readAliasDirEntries`) that the preflight composes.

Commands that operate only inside an initialized submodule working tree (`oms commit`, `oms switch`, `oms checkout`, `oms fetch`, `oms pull`, `oms push`) are unaffected and remain gated only by their existing initialization precondition.

#### Scenario: Conflicted gitlink and in-progress root operations are refused consistently by unsync and record
- **WHEN** the selected alias has a conflicted root gitlink or the root repository has an in-progress root Git operation
- **AND** the user runs `oms unsync` or `oms record` for that alias
- **THEN** the command refuses before mutating Git state
- **AND** the command fails with a deterministic OMS message rather than a raw Git error
- **AND** the command returns a non-zero exit code

### Requirement: Unsync preserves unsafe topology guardrails
The system SHALL guard `oms unsync` with the same root-topology safety checks as `oms sync`, refusing to remove a submodule before any `git submodule deinit` or `git rm` runs when the alias state cannot be mutated safely. `oms unsync` SHALL NOT delete, overwrite, or otherwise mutate a non-submodule path occupying `oms/<alias>`, and SHALL NOT report a successful removal in any guarded state.

#### Scenario: Unsync refuses and preserves a non-submodule occupied path
- **WHEN** `oms/api` is occupied by a non-submodule file or directory and `api` is not a registered submodule
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the occupying file or directory at `oms/api` is left untouched
- **AND** the command does not report `api` as unsynced
- **AND** the command returns a non-zero exit code
- **AND** the message explains that `oms/api` is occupied by a non-submodule path and must be resolved manually

#### Scenario: Unsync refuses during an in-progress root operation
- **WHEN** the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar operation in progress
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the message explains that the in-progress root operation must be resolved, continued, or aborted first
- **AND** the command returns a non-zero exit code

#### Scenario: Unsync refuses a conflicted root gitlink
- **WHEN** the selected alias has a conflicted root repository gitlink
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the message explains that the root gitlink conflict must be resolved first
- **AND** the command returns a non-zero exit code

#### Scenario: Unsync continues to remove a normal registered submodule
- **WHEN** `api` is a registered, initialized submodule with no unsafe root topology state
- **AND** the user runs `oms unsync api`
- **THEN** the command removes the submodule as before
- **AND** the command follows the existing unsync topology finalization policy
