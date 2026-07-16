## Context

`oms` currently exposes branch management across three top-level surfaces: `oms switch`, `oms checkout`, and the `oms branch` group (which owns `list` and `delete`). The `switch`/`checkout` implementations live in `scripts/lib/branch-ops.ts` (`runSwitch`, `runCheckout`); the `branch` group and its interactive action selector live in `scripts/lib/branch-delete.ts` (`runBranch`, `runBranchDelete`) and `scripts/lib/branch-list.ts` (`runBranchList`). Command registration is centralized in `scripts/oms.ts`.

The project is pre-1.0 (current `0.13.0`). Prior CLI breaks (0.5→0.6, 0.7→0.8, 0.9→0.10, 0.11→0.12) were shipped as immediate breaking changes documented under `docs/migrations/`, with no deprecated aliases. This change follows that established convention and ships as a 0.14.0 minor bump.

## Goals / Non-Goals

**Goals:**
- Host `switch` and `checkout` as subcommands of `oms branch`, making the group the single namespace for the full branch lifecycle (`list` → `switch`/`checkout` → `delete`).
- Remove the top-level `oms switch` / `oms checkout` commands entirely (immediate removal, no deprecated aliases).
- Extend the interactive `oms branch` selector to offer all four actions.
- Keep every user-facing hint that references branch switching pointing at a command that still exists.
- Document the break in a migration doc.

**Non-Goals:**
- Changing the behavior of `runSwitch` / `runCheckout` themselves. This is a relocation, not a redesign.
- Introducing a deprecation/alias window.
- Reworking `oms branch list` / `oms branch delete`.

## Decisions

### Decision 1: Reuse `runSwitch` / `runCheckout` unchanged; only re-register them
Register `switch` and `checkout` as children of the existing `branchCommand` in `scripts/oms.ts`, wired to the same `runSwitch` / `runCheckout` functions. The command bodies, options (`--from`), and argument shapes are identical to today — only their parent command changes.

- **Alternative considered**: Move the implementation code into `branch-delete.ts` or a new `branch-switch.ts`. Rejected — the functions already live in a cohesive `branch-ops.ts`; moving them adds churn and risk for no benefit. Commander does not care where the action handler is defined.

### Decision 2: Immediate removal, no deprecated aliases
Remove the top-level `switch`/`checkout` command registrations and drop `switch`/`checkout` from the `commandNames` set in `scripts/oms.ts`. After this, `oms switch ...` falls through to the existing unknown-command guard and exits non-zero.

- **Alternative considered**: Keep top-level commands as deprecated aliases that print a warning and forward to the branch subcommands, removed at v1. Rejected — no deprecated-alias precedent exists in this repo (migration docs are the deprecation-communication mechanism), v1 has no timeline, and the 1:1 mapping is trivial to document. Confirmed with the user.

### Decision 3: Interactive selector order = list → switch → checkout → delete
Extend the `guardedSelect` options in `runBranch` (`scripts/lib/branch-delete.ts`) to four entries in lifecycle order, dispatching switch/checkout to `runSwitch(undefined, undefined, {})` / `runCheckout(undefined, undefined)` so the subcommands' own interactive alias/branch pickers run.

- **Alternative considered**: Alphabetical order. Rejected — lifecycle order (discover → start/track → clean up) matches how users reason about branches and mirrors the README narrative.

### Decision 4: Update every branch-switch hint string in both code and spec
Every code hint suggesting `oms switch <alias> <branch>` becomes `oms branch switch <alias> <branch>`: `manage-ops.ts` (pull/push detached), `doctor.ts`, `commit.ts`, `branch-delete.ts`, and the checkout-not-found hint in `branch-ops.ts`.

The spec delta reconciles the same hint everywhere it is asserted, so the archived main spec never points users at a removed command. The main spec references `oms switch` in exactly five requirements; the delta `MODIFIES` all five: "Interactive branch action selection", "Protected branch and repository state", "Root topology actions share a consistent safety preflight", "Submodule-only commits", and "Pull and push keep root pointer updates explicit". Inside the two large, orthogonal reproduced blocks the only edits are the hint lines — one in "Submodule-only commits", two in "Pull and push keep root pointer updates explicit" (the detached-HEAD hints in its push and pull scenarios).

- **Rationale**: The change's own goal is to keep every user-facing hint valid. Leaving `oms switch` prose in the archived spec would contradict that goal. OpenSpec `MODIFIED` requires reproducing the full requirement block; the two large blocks were reproduced verbatim from the current main spec with only the hint line changed, and re-validated with `openspec validate`.
- **Alternative considered**: Update the two large requirements' hints in code only and skip their spec deltas (to avoid full-block reproduction). Rejected — it knowingly archives an inaccurate spec, contradicting the goal. Transcription risk is mitigated by copying verbatim and validating.

## Risks / Trade-offs

- [Muscle memory / scripts break: users and CI calling `oms switch`/`oms checkout` fail immediately] → Migration doc with a 1:1 mapping table; the unknown-command error is deterministic and non-destructive; minor version bump (0.14.0) signals the break.
- [Transcription error while reproducing the two large requirement blocks verbatim] → Blocks were copied from the current main spec and re-checked with `openspec validate`; only the single hint line differs from the original in each.
- [Interactive selector dispatch bug: switch/checkout invoked from the selector must run their own pickers] → Dispatch with empty alias/branch so the subcommand's existing interactive resolution runs; covered by the four new selector scenarios.
- [Stale references elsewhere: README, SKILL.md, migration index] → Enumerated as explicit tasks; grep-verified against `oms switch` / `oms checkout` before completion.

## Migration Plan

1. Register `oms branch switch` / `oms branch checkout`, remove top-level commands, update `commandNames`.
2. Extend the interactive selector.
3. Update all hint strings and docs (README, `skills/oms-branch/SKILL.md`).
4. Update tests under `tests/` that invoke `oms switch` / `oms checkout` to the new paths.
5. Add `docs/migrations/0.13.x-to-0.14.0.md` with the mapping table and link it from the README migrations list.
6. Add a changeset (minor bump, 0.13.0 → 0.14.0) describing the breaking relocation.

**Rollback**: Revert the commit(s). No data or on-disk state is touched by this change, so rollback is code-only.

## Open Questions

- None. Deprecation strategy (immediate removal) and v1 timeline (none planned) were confirmed with the user.
