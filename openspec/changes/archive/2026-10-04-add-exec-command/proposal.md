# Proposal

## Why

OMS selects source repositories for Git operations. Users still need separate loops to run tests, builds, and inspections across those repositories. A command runner can reuse workspace aliases without requiring remote access.

## What Changes

- Add `oms exec [aliases...] [--all] -- <command> [args...]` for initialized canonical checkouts.
- Define a canonical checkout as the declared source repository at `oms/<alias>/`.
- Pass the executable and arguments without shell interpretation. Users must invoke a shell explicitly for shell syntax, for example, `sh -c`.
- Run commands sequentially. Explicit aliases retain their order after OMS removes duplicates. `--all` uses manifest order.
- Use the existing interactive selector when users omit a selection. Require explicit aliases or `--all` in non-interactive sessions.
- Continue after an individual command or target fails. Identify each alias in its output section and the final summary.
- Return a non-zero OMS exit code if any selected target fails.
- Stop the invocation on Ctrl+C. Interrupt the active command. Do not start commands for the remaining targets.
- Do not initialize, register, fetch, switch branches, or record pointers as preparation. Report unavailable targets with `oms sync <alias>` guidance.
- Exempt `exec` from automatic preparation in the shared automation policy. Preserve the preparation requirements for existing commands.
- Explain that user commands may change repositories or access the network. OMS performs no additional repository or network operations.

## Capabilities

### New Capabilities

- `workspace-command-execution`: Execute user commands across selected canonical checkouts. Define argument handling, sequential execution, results, and interruption.

### Modified Capabilities

- `cli-automation-policy`: Exempt `oms exec` from automatic initialization and registration. Preserve the preparation requirements for existing commands.

## Impact

- Register the command and handle its arguments in `scripts/oms.ts`.
- Add command help in `scripts/lib/help.ts`.
- Add an execution module beside `scripts/lib/manage-ops.ts`. Reuse `selectRepos`, workspace discovery, and read-only registration checks.
- Do not use the Git-only process helpers for arbitrary commands.
- Add behavioral tests in the existing unit, integration, and black-box layers. Register the tests in `tests/test-inventory.json`.
- Update `docs/commands.md` and the relevant scope descriptions in `docs/how-oms-works.md`.
- Add an English Changeset for the new CLI command.
- Do not change the manifest schema or add runtime dependencies.
- Exclude parallel execution, task configuration, dependency graphs, automatic retry, timeouts, rollback, and a fail-fast option.
