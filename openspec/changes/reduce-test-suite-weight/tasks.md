# Tasks

## 1. Inventory and validator policy extension

- [x] 1.1 Extend the migration record schema in `scripts/test-inventory-lib.mjs` and `scripts/validate-test-inventory.mjs` so a record may mark a contract deleted (`deleted` with a reason) instead of pointing at a replacement, and make the validator require exactly one of replacement or deletion per migrated contract; verify with `npm run test:unit` and `node scripts/validate-test-inventory.mjs`
- [x] 1.2 Add a black-box budget to `tests/test-inventory.json` (e.g. `execution.budgets.blackbox`, initial value = current black-box count so nothing regresses) and make the inventory check fail when the registered black-box count exceeds it; verify the check passes on the current inventory and fails on an intentionally over-budget fixture copy
- [x] 1.3 Update `tests/unit/test-inventory.test.ts` to cover deletion-record validation and budget enforcement; verify with `npm run test:unit`

## 2. Census

- [x] 2.1 Classify every black-box contract in `tests/test-inventory.json` as delete / move-down / keep-as-journey and record the decision table at `openspec/changes/reduce-test-suite-weight/census.md` (delete+move+keep counts reconcile to the registered black-box total); verify by cross-checking counts against the inventory

## 3. Feature group migrations (order: measured cost, heaviest first)

- [x] 3.1 Migrate `tests/cli-tools.test.js` (67 contracts): move decision-boundary cases to `tests/unit` or `tests/integration`, keep the command journey floor, append migration records; verify `npm test` stays green and the black-box count drops by the census' tools move+delete count
- [x] 3.2 Migrate `tests/cli-sync.contracts.js` (86 contracts) the same way; verify `npm test` stays green and migration records cover every moved or deleted sync contract
- [x] 3.3 Migrate `tests/cli-commit.contracts.js` (75 contracts) the same way; verify `npm test` stays green and migration records cover every moved or deleted commit contract
- [x] 3.4 Migrate `tests/cli-scaffold.test.js` (33 contracts) the same way; verify `npm test` stays green
- [x] 3.5 Migrate `tests/cli-branch.contracts.js` and `tests/cli-branch-list.contracts.js` (48 contracts) the same way; verify `npm test` stays green
- [x] 3.6 Migrate `tests/cli-preparation.contracts.js` (14 contracts) the same way; verify `npm test` stays green
- [x] 3.7 Migrate `tests/cli-tree.contracts.js` (14 contracts) the same way; verify `npm test` stays green
- [x] 3.8 Review the 90 `process-integrity-or-recovery` contracts: move injected-failure cases that need no real Git state to `tests/integration`, keep real-state integrity cases in blackbox, append migration records for every move; verify `npm test` stays green

## 4. Journey consolidation and shard shrink

- [x] 4.1 Merge remaining per-case fixture setup into explicitly declared journey walks in the slowest owners (preparation, commit, sync shards first), one fixture walk per journey with each journey independently owned; verify `npm run test:blackbox` stays green and owner wall-time drops against the pre-change baseline
- [x] 4.2 Shrink the shard layout (`tests/*.test.js` owners), `ownerOrder`, and layer concurrency in `tests/test-inventory.json` to match the consolidated file set; verify `npm test` stays green with the new shard union covering every retained contract exactly once

## 5. Budgets, evidence, and cleanup

- [x] 5.1 Collect benchmark evidence (`node scripts/benchmark-test-suite.mjs --runs 3 --label post-migration`) and set the final black-box cap and local/CI performance budgets in `tests/test-inventory.json`; if measurement contradicts the 30 s / 40 s spec budgets, update this change's delta spec to the evidenced values; verify three recorded warm runs
- [x] 5.2 Update `docs/development.md` (and any README test reference that drifts) to describe the risk-tiered retention policy, the black-box budget, and how to choose a layer for a new test; verify by reading the rendered sections
- [x] 5.3 Add a changeset summarizing the test-suite reduction for the changelog; verify `npx changeset status` lists it
- [x] 5.4 Delete `openspec/changes/reduce-test-suite-weight/census.md` once every census decision is captured as a migration record or retained-contract entry; verify the working artifact is gone and `node scripts/validate-test-inventory.mjs` passes
- [x] 5.5 Final verification: `openspec validate reduce-test-suite-weight` passes and `npm test` passes within the recorded budgets
