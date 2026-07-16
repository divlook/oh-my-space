## Why

OMS can create and switch submodule branches, but users must leave the OMS workflow and run Git in the correct submodule directory to remove a local branch. A scoped delete command can make branch cleanup safer while preserving Git's merged-branch protection and OMS's baseline-branch invariants.

## What Changes

- Add an `oms branch` command group that presents its supported branch actions interactively when invoked without a subcommand.
- Add `oms branch delete [alias] [branch]` for deleting a local branch inside one initialized submodule without deleting any remote branch.
- Prompt for an initialized alias when `oms branch delete` is invoked without one, then present local branches with current and baseline branches visible but disabled when the branch is omitted.
- When an explicitly named alias is already registered but not initialized, initialize that submodule automatically, revalidate deletion safety, and continue without requiring a separate sync invocation; this preparation may access the registered remote but never creates root topology.
- Use safe branch deletion by default and, when Git rejects deletion and the branch remains, offer one interactive force-deletion retry with the original Git error and branch tip full OID visible.
- Add explicit `-f, --force` options for non-interactive or intentional force deletion.
- Revalidate the full branch OID immediately before every force deletion, abort when the branch moved concurrently, and print a shell-safe recovery command with the full OID before deletion.
- Always protect the current branch and every applicable baseline branch, including an explicit `oms.yaml` branch, drifted `.gitmodules` branch, or detected remote default when no branch is declared; force never bypasses these protections.
- Reject unanchored detached submodule HEAD deletion, while allowing detached HEAD whenever it exactly equals the root gitlink anchor so interrupted automatic preparation can resume without a manual branch attachment.
- Reject deletion while a Git operation is in progress inside the selected submodule, while allowing unrelated dirty submodule or root repository state.
- Reconcile existing submodule `.gitmodules` URL and branch metadata from `oms.yaml` atomically after topology mutation and baseline validation but before root finalization, preserving the current working branch and including validated metadata in the same OMS commit when commit was requested or accepted.
- Refresh `origin/HEAD` during sync when an alias omits `branch`, and fail sync when an explicit or remote-default baseline cannot be validated.
- Protect `.gitmodules` reconciliation from conflicted or mismatched staged ownership, concurrent changes at topology and finalization boundaries, partial writes, and multi-alias partial failure. Every sync commit uses an owner-only temporary index to commit only successful alias topology and OMS-managed `.gitmodules` metadata, consumes a pre-staged OMS path only when it exactly matches the validated result, and intentionally consumes the complete current declarative `oms.yaml`; failed-alias `.gitmodules` metadata and gitlinks are excluded while failed-alias `oms.yaml` declarations are included, and other user index or working-tree changes are preserved.
- Preserve post-topology changes as an unstaged, resumable working-tree result when metadata reconciliation fails, and use durable intent and recovery-index state so an interruption after a temporary-index commit cannot silently lose the user's real index.
- Run a shared durable-recovery preflight before root mutation by `sync`, `unsync`, or `record`; recover verified state automatically and block on mismatched, malformed, or orphaned state rather than overwriting the user's index.
- Retry only side-effect-free atomic metadata file operations and mode restoration once; after the retry, stop only for state that OMS cannot safely resolve or infer.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-submodule-workflow`: Add scoped, interactive local branch deletion with safe defaults, explicit force escalation, protected-branch rules, and declarative baseline metadata reconciliation during sync.

## Impact

- CLI command registration and help output in `scripts/oms.ts`.
- Local branch operations and Git helpers under `scripts/lib/`.
- Interactive prompts for action, alias, branch, and force confirmation.
- Existing-submodule sync metadata reconciliation and remote-default branch resolution.
- Pending-removal restoration, root topology finalization, `.gitmodules` transaction boundaries, partial-success commits, and interrupted-index recovery.
- Shared `sync`, `unsync`, and `record` recovery preflight behavior and diagnostics.
- A reusable `OMS_TEST_PROMPT_RESPONSES` JSON response queue enabled only when `OMS_TEST_MODE=1` is also present for deterministic interactive CLI tests.
- CLI integration tests for safe deletion, forced deletion, protected branches, omitted arguments, cancellation, sync reconciliation, and non-interactive behavior.
- README command documentation and the `oms-branch` skill guidance.
- A `0.11.x` to `0.12.0` migration guide for stricter baseline validation, managed metadata overwrite, staged-path ownership checks, complete working-tree `oms.yaml` inclusion, partial-success commits, and new `record` recovery preflight stops.
- A minor release changeset for the new CLI capability.
