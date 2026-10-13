# Proposal

## Why

Workspace inspection repeats Git subprocesses that do not contribute additional requested information: JSON status recollects each selected alias's pointer state, and managed-tree inventory always inspects every healthy tree's working files. Before the v2 stable release, reduce these costs in small, independently verifiable increments without weakening mutation safeguards or changing CLI contracts.

## What Changes

- Reuse one invocation-local `GitlinkState` per selected alias between JSON repository entries and root pointer summaries; retain fresh observations on later invocations.
- Separate managed-tree discovery from working-file inspection inside the existing tree module. Migrate discovery-only consumers one at a time: doctor diagnostics, tree-add duplicate checks, and unsync tree-presence guards.
- Apply alias filtering before working-file inspection for both JSON and human-readable status. Continue discovering undeclared, broken, and foreign entries across the whole managed namespace.
- Deliver five end-to-end implementation slices. Every slice includes its caller migration, relevant behavioral verification, actual bundled-command smoke, and before/after subprocess evidence before the next slice begins. No extraction-only milestone or deferred wiring.
- Preserve existing flags, output fields, ordering, exit behavior, preparation rules, tree-removal safeguards, and `tree list` dirty reporting.
- Exclude root Git batching, long-lived caches, inspection-module extraction, branch cleanup, registration/baseline redesign, test-suite optimization, release/version changes, and the separately identified read-failure and remote-reconciliation defects.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This is an implementation-only optimization under the existing `ai-submodule-workflow` and `temporary-worktrees` contracts. The change declares `skip_specs: true`; no delta specifications are created and no durable requirement is weakened.

## Impact

- Implementation: `scripts/lib/status.ts`, `scripts/lib/tree-ops.ts`, `scripts/lib/doctor.ts`, and `scripts/lib/repo-ops.ts` only where the scoped callers need different inspection depth.
- Verification: existing status/tree integration coverage, tree unit coverage, and sync/tree/tools production-bundle journeys. Add permanent coverage only for a consumer-visible invariant not already covered; record any contract migration in the existing test inventory.
- Performance evidence: reproducible, non-gating CLI measurements under `tests/performance/`, separate from suite/owner timings. Record exact source/environment and per-command counts; do not claim the earlier missing-alias microbenchmark is a complete workspace benchmark.
- Documentation: after smoke proof, a concise contributor explanation in `docs/development.md` and an English patch Changeset describing reduced inspection work with unchanged command behavior.
- No new runtime dependencies, network requests, public commands, schema versions, or persistent cache state.
