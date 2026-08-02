# Migration guides

Use the guide for the first target version newer than your installed OMS version, then continue through each later version in order.

- [0.14.x to 0.15.0](0.14.x-to-0.15.0.md) — updates the CLI behavior required for the 0.15.0 workspace format.
- [0.13.x to 0.14.0](0.13.x-to-0.14.0.md) — moves `oms switch` and `oms checkout` under the `oms branch` command group.
- [0.11.x to 0.12.0](0.11.x-to-0.12.0.md) — adds local branch deletion and declarative `.gitmodules` reconciliation with recovery-safe finalization.
- [0.9.x to 0.10.0](0.9.x-to-0.10.0.md) — separates source-repository commands from main-project recorded-commit updates through `oms record`.
- [0.7.x to 0.8.0](0.7.x-to-0.8.0.md) — separates new local branches from existing remote branches.
- [0.6.x to 0.7.0](0.6.x-to-0.7.0.md) — updates the submodule workflow and compatibility behavior.
- [0.5.x to 0.6.0](0.5.x-to-0.6.0.md) — returns the workspace model from bare clones and worktrees to Git submodules.
- [0.3.x to 0.4.0](0.3.x-to-0.4.0.md) — renames `sources.yaml` and `sources/` to `oms.yaml` and `oms/`.
- [0.2.x to 0.3.0](0.2.x-to-0.3.0.md) — historical migration from submodules to bare clones and worktrees.

For current command selection and safety behavior, use the [command guide](../commands.md) and the built-in `oms <command> --help` output rather than older migration examples.
