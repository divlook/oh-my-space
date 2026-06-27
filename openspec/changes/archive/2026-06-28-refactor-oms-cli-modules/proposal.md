## Why

The OMS CLI implementation has grown around a few broad modules, making command responsibilities and shared safety logic harder to reason about. Refactoring the module boundaries now will reduce future change risk while preserving the existing CLI behavior and safety guarantees.

## What Changes

- Split broad implementation modules into clearer responsibility-focused modules.
- Remove small internal duplication where it can be done without adding abstraction noise.
- Decouple update/install-context detection from the `doctor` command module.
- Keep `oms.ts` focused on command wiring and dispatch.
- Preserve all existing command behavior, help text semantics, exit codes, and root/submodule safety checks.
- No breaking changes.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `ai-submodule-workflow`: preserve the existing submodule/root safety workflow while reorganizing internal modules.
- `cli-self-update`: preserve update detection and execution behavior while moving install-context helpers out of `doctor.ts`.

## Impact

- Affected code: `scripts/oms.ts`, `scripts/lib/commit.ts`, `scripts/lib/doctor.ts`, `scripts/lib/manifest.ts`, `scripts/lib/repo-ops.ts`, `scripts/lib/status.ts`, `scripts/lib/update.ts`, and any new internal helper modules under `scripts/lib/`.
- Affected behavior: intended to be behavior-preserving only.
- APIs: no public CLI API changes.
- Dependencies: no new runtime dependencies expected.
- Tests: existing CLI, status, update, and topology safety tests should continue to pass; targeted tests may be adjusted only for changed internal module paths.
