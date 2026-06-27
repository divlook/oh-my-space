## Why

`oms sync` was recently hardened to classify root topology state and either restore it safely or refuse with a deterministic OMS message — but `oms unsync` was left behind. In the exact state where `sync` now refuses and preserves the working tree (a non-submodule file occupying `oms/<alias>`), `unsync` instead leaks a raw `fatal: pathspec 'oms/api' did not match any files`, **deletes the user's file**, and falsely reports `api: unsynced` with exit 0. `unsync` also runs `deinit`/`rm` while a root merge/rebase is in progress — which `record` refuses outright and `sync` refuses within its pending-removal restore path. The safety guards exist but are not applied consistently across the actions that mutate root topology.

## What Changes

- Extract a shared root-topology preflight (`gitlinkState` + topology predicates + `gitOperationInProgress` + alias-path inspection) into the status spine. Route `unsync` and `record` through it; `sync` keeps its existing (restore-scoped and `!registered`-branch) guards unchanged and continues to consume the same lower-level spine primitives the preflight composes.
- Make `oms unsync` refuse — before any `deinit`/`rm` — when the root gitlink is conflicted, a root Git operation (merge/rebase/cherry-pick/revert/bisect) is in progress, or `oms/<alias>` is occupied by a non-submodule file or directory.
- **BREAKING (behavioral)**: `oms unsync` no longer deletes a non-submodule path occupying `oms/<alias>` and no longer reports success in that state; it fails with a deterministic OMS message and a non-zero exit, leaving the path untouched.
- Replace leaked raw Git errors from `unsync` with deterministic OMS messages, consistent with `sync`/`record`.
- Re-route `record`'s existing conflict / in-progress / occupied-path checks through the shared preflight so all three actions stay in lockstep as the guard set evolves.
- No behavior change for submodule-internal actions (`commit`, `switch`, `checkout`, `fetch`, `pull`, `push`): they operate inside `oms/<alias>` and remain gated only by their initialization precondition.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `ai-submodule-workflow`: `oms unsync` gains the same root-topology safety guards as `oms sync`, and `unsync` and `record` are routed through a single shared preflight contract for unsafe topology states (`sync` keeps its existing guards and consumes only the shared spine primitives).

## Impact

- Affects `scripts/lib/repo-ops.ts` (`unsyncRepo`, `syncRepo`) and `scripts/lib/status.ts` (new shared preflight; `readAliasDirEntries` moves here from `repo-ops.ts`).
- Touches `scripts/lib/commit.ts` (`runRecord`) only to route existing guards through the shared preflight without changing observable behavior.
- Requires CLI regression coverage in `tests/cli.test.js` mirroring the existing sync guardrail tests: `unsync` against an occupied non-submodule path (must preserve and fail), and `unsync` during an in-progress root operation / conflicted gitlink.
