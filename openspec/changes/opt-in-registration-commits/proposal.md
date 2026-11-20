# Proposal

## Why

`oms sync` and `oms unsync` currently commit source registration changes to the main project by default, even when the user only wants to prepare those changes locally. Making that commit explicit also requires OMS to distinguish a valid pending source registration from a broken one, so users can fetch or list branches without first committing the registration.

## What Changes

- **BREAKING**: `oms sync` and `oms unsync` do not commit by default. With commits disabled, Git operations may change staging, including existing staging on affected paths. OMS does not add a staging-only check, undo staging, or report staging separately at runtime. Help and documentation explain this behavior. Workflows that rely on a commit can pass `--commit` or set `autoCommit: true` in `oms.yaml`.
- Add one optional boolean `autoCommit` setting in `oms.yaml`, defaulting to `false`. It applies to both commands and to sync performed by another command after the user approves registration. On direct invocations, `--commit` and `--no-commit` override the setting for that run; supplying both fails before changes begin. Approval to register does not by itself authorize a commit.
- Define which commands accept a valid pending source registration, both immediately after approved registration and on later invocations. Conflicted or incomplete registrations remain blocked, and each command retains its existing safety checks.
- In delegated batches, continue only for aliases that prepared successfully when failures are alias-specific. A shared root commit or index finalization failure prevents the original command from running for any alias.
- Keep `oms record` limited to source pointer updates for sources already registered in the main project's current revision. It does not commit registration additions, removals, or metadata changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-submodule-workflow`: Make source registration commits opt-in and distinguish valid pending source registrations from broken registrations during shared alias preparation.
- `cli-automation-policy`: Separate consent to prepare a registration from authorization to commit it, and allow eligible commands to continue when a valid registration is pending.

## Impact

- `oms.yaml` validation and schema, `sync` and `unsync` commit selection, shared source registration checks, and command help and recovery guidance.
- User documentation and regression coverage for scripts that rely on the old default, command-line overrides, approved registration without a commit, and existing safety checks.
