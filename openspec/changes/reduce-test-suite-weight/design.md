# Design

## Context

The suite executes through `scripts/test.mjs`: build, inventory validation, unit layer, then integration and blackbox layers concurrently. Every contract is registered in `tests/test-inventory.json` (376 today: 337 blackbox, 9 integration, 30 unit) with a `boundary` classification and a `processBoundaryRationale`; `scripts/validate-test-inventory.mjs` enforces the mapping, and migration records (359 entries) already exist to map pre-change contracts to replacements. Blackbox owners run with shared immutable fixture templates (`tests/helpers.js` → `prepareSharedFixtures`) and deterministic shard ownership. Motivation and scope: see proposal.md — Why.

Constraint that shapes everything: the validator and inventory are the enforcement tools, and they stay. This change re-tunes the policy they enforce; it does not remove the machinery.

## Goals / Non-Goals

**Goals:**

- A risk-tiered replacement policy: protected classes never silently dropped; everything else may be consolidated or deleted with a recorded migration entry.
- Down-layer migration of decision-boundary contracts out of blackbox.
- Journey-level fixture reuse to cut the dominant per-case setup cost.
- A machine-enforced black-box cap so accretion has a deliberate gate.
- Local `npm test` median comfortably below the current ~95 s (target evidence-driven; working aim ≤ 30 s).

**Non-Goals:**

- No change to CI triggering, verification memoization/fingerprints, or the prepack gate.
- No change to production source or the bundled CLI.
- No test-framework swap; `node --test` and the layered layout stay.
- The inventory system itself is not removed — it becomes the enforcement point for the new policy.

## Decisions

**D1 — Two-tier policy replaces blanket preservation.**
`process-integrity-or-recovery` and `production-bundle-wiring` contracts are protected: they may be consolidated only with an equivalent replacement, never deleted for weight. `production-cli-journey` contracts are discretionary: consolidations and deletions are allowed when the same observable outcome is already asserted elsewhere or the assertion only pins incidental behavior. Every move, consolidation, or deletion appends a migration record. Alternative considered: keep full preservation and only re-home (rejected — leaves maintenance weight and growth unaddressed; this is the explicitly accepted risk).

**D2 — Budget as mechanism, number as data.**
The spec mandates that a black-box budget exists and is enforced; the concrete cap lives in `tests/test-inventory.json` (e.g. `execution.budgets.blackbox`), and `validate-test-inventory.mjs` fails when the blackbox contract count exceeds it. Raising the cap is a reviewed data change, not a spec edit. Alternative considered: a hard-coded number in the spec (rejected: churns the spec for every adjustment) and a ratio rule (rejected: harder to audit than a plain cap).

**D3 — Move semantics.**
A down-layer move rewrites the assertion host, not the assertion: decision contracts (parsing, classification, planning, redaction, diagnostics, JSON shape) call `scripts/lib` functions directly in `tests/unit/*.test.ts`, or run against an owned fixture in `tests/integration/*.test.ts` when real file/Git semantics matter. The migration record maps old contract id → replacement id, and the replacement asserts the same observable outcome. Migration record schema is extended to carry deletion records (`deleted: true` + reason); current records are append-only data, so the extension is additive.

**D4 — Journey consolidation model.**
Per feature file (sync, commit, tools, scaffold, branch, preparation, tree), contracts that exercise one lifecycle are grouped into explicitly declared journeys sharing one fixture walk in a defined order; each journey stays independently owned and disposable, reusing the existing shared immutable templates. The slowest owners (preparation ~48 s; commit/sync shards ~24–27 s) are the first targets. Shard count may shrink; `ownerOrder` in `run-test-layer.mjs` shrinks with it. Alternative considered: keep per-case fixtures and only shrink assertions (rejected: fixture preparation, not assertion time, dominates the measured owner durations).

**D5 — Command wiring floor.**
Every public command keeps at least one representative journey through the bundled CLI, alongside the 13 existing `production-bundle-wiring` contracts. This floor is what makes down-layer moves safe: the CLI argument/exit surface of every command stays exercised end-to-end.

**D6 — Performance re-baseline procedure.**
After migration, run the existing `scripts/benchmark-test-suite.mjs` (3 warm local runs on the documented environment; CI evidence from the existing workflow step) and set the new local median/max and CI budgets from those measurements. The spec re-baselines acceptance numbers; functional tests keep asserting no wall-clock values.

## Risks / Trade-offs

- [Moved contracts stop exercising CLI argument handling] → D5 wiring floor plus one journey per command; the moved assertion keeps identical observable outcomes.
- [Deleted tests hide a real regression] → Protected tier survives; every deletion is recorded with a reason in migration records; Git history retains the removed tests.
- [Shared journeys couple contract order to state] → journeys are explicitly declared, ordered, and independently owned; each journey's fixtures stay disposable (existing requirements retained in the delta).
- [Budget cap too tight for future legitimate process tests] → the cap is data, raised by reviewed change; a deliberate gate is the intended behavior.
- [Benchmark numbers vary by machine] → budgets are set from measured evidence with margin, and functional tests never depend on wall-clock assertions (existing requirement retained).

## Migration Plan

1. Extend `validate-test-inventory.mjs` + `test-inventory.json` schema: budget enforcement and deletion-capable migration records (additive; suite stays green).
2. Census: classify all 337 blackbox contracts into delete / move-down / keep-as-journey; the resulting table is reviewed as part of this change.
3. Migrate feature group by feature group (tools, sync, commit, scaffold, branch, preparation, tree), keeping the full suite green after each group.
4. Journey consolidation pass over the remaining blackbox owners; shrink shard layout accordingly.
5. Collect benchmark evidence; set the blackbox cap and performance budgets in data; validate the spec delta.

Rollback: revert the change's commits; inventory data and schema edits are contained to this change, and migration records are append-only within it.

## Open Questions

- None blocking. The exact cap and budget numbers are deliberately produced by the change's own benchmark evidence (D2, D6) rather than decided here.
