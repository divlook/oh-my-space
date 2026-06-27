## Context

The `handle-sync-pending-removal` change (archived 2026-06-26) hardened `oms sync` against non-trivial root topology states. The safety checks it relies on already live in `scripts/lib/status.ts` as the shared "state spine":

- `gitlinkState(repoRoot, alias)` — HEAD / index / worktree OID classification
- `pendingRemovalTopology` / `partialRemovalTopology` — staged-removal predicates
- `gitOperationInProgress(dir)` — merge/rebase/cherry-pick/revert/bisect detection

`sync` also added `readAliasDirEntries` (in `scripts/lib/repo-ops.ts`) to distinguish "path absent" from "path is a non-submodule file/dir" without throwing on `readdirSync`. This change extends it to also surface "path exists but is unreadable" (a non-`ENOENT` error such as `EACCES`) as a distinct state rather than folding it into the non-submodule-file case.

`runRecord` (`scripts/lib/commit.ts`) independently re-implements the same guard set (conflict, in-progress op, etc.). `unsyncRepo` (`scripts/lib/repo-ops.ts`) implements almost none of them: it branches only on `isRegisteredSubmodule` and `existsSync(aliasDir)`, then unconditionally runs `deinit` / `git rm` / `rmSync`. Empirically reproduced consequences:

- A non-submodule file at `oms/api` is **deleted** by `unsync`, which leaks `fatal: pathspec 'oms/api' did not match any files` yet reports `api: unsynced` with exit 0 — while `sync` refuses and preserves the same file.
- `unsync` runs `deinit`/`rm` while a root merge is in progress; `sync` and `record` both refuse.

The guards exist; they are just not applied consistently. This change makes the consistency structural rather than copy-pasted.

## Goals / Non-Goals

**Goals:**
- One shared preflight that classifies whether the selected alias's root topology is safe to mutate, routed through by `unsync` and `record`. `sync`'s refusal behavior and exit codes are unchanged; it consumes the same lower-level spine primitives (`gitlinkState`, `gitOperationInProgress`, `readAliasDirEntries`) that the preflight composes, and inherits the refined unreadable-path message wording through the shared `readAliasDirEntries` (see Decision 2).
- `unsync` reaches guard parity with `sync`: refuse (deterministic message, non-zero exit) on conflicted gitlink, in-progress root op, or occupied non-submodule path — before any destructive Git/filesystem call.
- Eliminate the data-loss bug where `unsync` deletes a non-submodule path at `oms/<alias>`.
- Eliminate raw Git error leakage from `unsync`.

**Non-Goals:**
- Adding recovery/restore behavior to `unsync` or `record`. Restore is meaningful only for `sync` (`restorePendingRemoval` stays sync-only).
- Changing submodule-internal actions (`commit`, `switch`, `checkout`, `fetch`, `pull`, `push`). They do not mutate root topology and remain gated by their initialization precondition.
- Changing the topology-commit finalization policy (`finalizeTopology`).

## Decisions

### Decision 1: A return-based preflight with caller-selected checks
Add to `scripts/lib/status.ts`:

```ts
export type RootTopologyCheck = "conflict" | "inProgressOp" | "occupiedPath";
export type RootTopologySafety = { safe: true } | { safe: false; reason: string };

/**
 * Whether the selected alias's root topology can be mutated safely.
 * Callers pass the checks that apply to them; checks are always evaluated
 * in the fixed order conflict → inProgressOp → occupiedPath and the first
 * failing applied check determines the returned reason.
 */
export function assertRootTopologySafe(
  repoRoot: string,
  alias: string,
  checks?: RootTopologyCheck[], // defaults to all three
): RootTopologySafety;
```

Each check maps to one spine primitive: `conflict` → `gitlinkState(...).conflict`, `inProgressOp` → `gitOperationInProgress(repoRoot)`, `occupiedPath` → alias-path inspection (occupied-by-non-submodule, scoped to the unregistered case — see Decision 3). The occupied-path inspection classifies the path as `clear`, `occupied`, or `unreadable`, so an `EACCES`/`EPERM`/`EBUSY` path yields a distinct "could not be read" reason instead of the misleading "occupied by a non-submodule path" wording. It evaluates only the requested checks, in the fixed order above, and returns `{ safe: false, reason }` on the first failing one with a human-readable reason fragment; callers wrap it in their own `log.error` and result code.

**Why caller-selected checks:** the applicable check set differs per caller (Decisions 3 and 4) — `unsync` applies all three, `record` applies only `conflict` and `inProgressOp` (it never creates or occupies `oms/<alias>`). A single bundled "always all three" function could not express that, so callers pass the subset that is meaningful. The fixed evaluation order preserves `record`'s existing conflict-before-in-progress reporting (`commit.ts:117-127`), so re-routing `record` does not reorder its messages.

**Why return-based over throwing:** the codebase models command outcomes as `OperationResult` / numeric exit codes and avoids control-flow exceptions in these paths (`syncRepo`, `unsyncRepo`, `runRecord` all return values). A discriminated union keeps each caller's existing message style and exit-code mapping intact. *Alternative considered:* a throwing `assert...` with a typed error caught at the command boundary — rejected as inconsistent with surrounding code and harder to unit-test per state.

### Decision 2: Move `readAliasDirEntries` into `status.ts`
The occupied-path check needs `readAliasDirEntries`, currently private in `repo-ops.ts`. Move it to `status.ts` (the shared spine) and export it so both the preflight and `syncRepo`'s existing `!registered` branch consume one implementation. *Alternative:* keep it in `repo-ops.ts` and import upward into `status.ts` — rejected because `status.ts` is the lower-level module in the dependency direction (`repo-ops.ts` already imports from `status.ts`), so the helper belongs there.

### Decision 3: Scope the occupied-path guard to the unregistered case in `unsync`
The data-loss path is specifically: `api` not registered, but a non-submodule file/dir sits at `oms/api`. A normally registered submodule must still unsync. So `unsync`'s occupied-path refusal applies when the path is **not** a registered/initialized submodule yet is occupied by non-submodule content — mirroring `sync`'s `!registered` branch. The conflict and in-progress-op guards apply unconditionally before `deinit`/`rm`.

### Decision 4: Route `record` through the shared preflight without behavior change
`runRecord` keeps its richer, record-specific checks (headOid, split, unrelated staged paths) but delegates the conflict / in-progress-op portion to `assertRootTopologySafe(repoRoot, alias, ["conflict", "inProgressOp"])` so the three actions stay in lockstep as the guard set evolves. It does not pass `occupiedPath` — `record` neither creates nor occupies `oms/<alias>`. The preflight's fixed conflict → inProgressOp ordering matches `record`'s current reporting order (`commit.ts:117-127`), so observable `record` behavior, messages, and exit codes are preserved (verified by existing record tests).

## Risks / Trade-offs

- **[Reason-string drift]** Each caller wraps the shared `reason` in its own message; wording could diverge from `sync`'s existing strings. → Keep `reason` fragments centralized in the preflight and assert on stable substrings (e.g. `occupied by a non-submodule`, `could not be read`, `in progress`, `conflicted`) in tests rather than full sentences. The unreadable reason is shared via a single `unreadablePathReason` helper consumed by both the preflight and `sync`; `restorePendingRemoval` intentionally embeds only the cause fragment (`<path> could not be read (permission or I/O error)`) inside its existing `cannot restore pending removal safely (…)` wrapper to avoid a doubled "Resolve" clause.
- **[record regression]** Re-routing `record`'s guards risks changing message order or exit codes. → Land it behind the existing `record` test suite; treat any diff in record output as a defect, not an accepted change.
- **[Hidden unsync callers]** `unsync --all` and interactive multi-select run `unsyncRepo` per alias; a per-alias refusal must not abort siblings. → Preflight returns a per-alias `failed` result and the loop continues, consistent with current per-alias independence in `runUnsync`.
- **[Behavioral break]** Users (or scripts) relying on `unsync` clearing a stray non-submodule path now get a failure. → Documented as an intentional behavioral break in the proposal; the prior behavior was silent data loss with a false success, so the break is strictly safer.

## Migration Plan

No data migration. Roll out as a normal patch release with a changeset. Rollback is reverting the change; the shared preflight is additive and the only externally visible change is `unsync` failing (instead of destroying data) in the guarded states.
