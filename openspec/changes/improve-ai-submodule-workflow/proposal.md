## Why

Users working in an `oms` workspace need AI coding agents to distinguish root-repository changes from submodule changes reliably. Today a broad request such as "commit this" or "create a branch" can lead an agent to operate in the wrong Git repository, especially when root pointer changes and submodule source changes are both present.

## What Changes

- Add a machine-readable `oms status --json` mode so agents can inspect workspace root, current alias, root repository status, and per-submodule state before making branch or commit decisions.
- Add `oms commit <alias> -m <message>` for committing only inside the selected submodule, with alias inference when the command runs from inside `oms/<alias>/` and Git index-aware behavior for partial commits.
- Add `oms record <alias>` to record existing root gitlink pointer updates explicitly after submodule commits.
- Keep `oms pull` and `oms push` focused only on submodule branch synchronization without staging root gitlinks, and remove the root-pointer shortcut by rejecting `oms push --commit` before pushing with guidance to use `oms record <alias>`.
- Stop leaving automatically staged root index changes after `oms sync` and `oms unsync` by default; topology changes may be committed through an interactive prompt or explicit `--commit`.
- Use Conventional Commit formatting for automatic root pointer-update commits and sync/unsync topology commits.
- Add `oms agent install` and `oms agent uninstall` to manage `AGENTS.md` and/or `CLAUDE.md` instruction blocks with `<!-- OMS START -->` and `<!-- OMS END -->` markers.

## Capabilities

### New Capabilities
- `ai-submodule-workflow`: Covers machine-readable workspace state, scoped submodule commit and pointer-record commands, and agent instruction management for AI-assisted `oms` workflows.

### Modified Capabilities
- None.

## Impact

- CLI command surface in `scripts/oms.ts`.
- README command reference and workflow documentation.
- CLI tests in `tests/cli.test.js`.
- New OpenSpec capability for AI-assisted submodule workflow behavior.
