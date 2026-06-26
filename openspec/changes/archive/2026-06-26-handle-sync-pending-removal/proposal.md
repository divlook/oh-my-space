## Why

Running `oms sync` after an uncommitted `oms unsync <alias>` can surface Git's low-level `fatal: '<path>' already exists in the index` error. This is confusing because the user's intent is to make the selected alias present again, not to debug root index topology left by a pending removal.

## What Changes

- Teach `oms sync` to detect when the selected alias is in pending removal topology from a previous uncommitted `oms unsync`.
- Restore the selected submodule instead of invoking `git submodule add` when the alias is still recorded in root `HEAD` but its working tree and/or `.gitmodules` entry are removed.
- Preserve the existing topology-commit policy: restored topology remains subject to the normal interactive `--commit` prompt or explicit `--commit` behavior.
- Replace Git's `already exists in the index` failure with deterministic OMS behavior and clearer messages for unsafe restore states.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `ai-submodule-workflow`: `oms sync` behavior changes for aliases with pending removal topology left by an uncommitted `oms unsync`.

## Impact

- Affects `scripts/lib/repo-ops.ts` sync handling and topology state checks.
- May affect `scripts/lib/commit.ts` only if topology finalization needs safer staged-path handling after restore.
- Requires CLI regression coverage for `sync -> unsync without commit -> sync` using both explicit aliases and interactive-equivalent selection paths where practical.
