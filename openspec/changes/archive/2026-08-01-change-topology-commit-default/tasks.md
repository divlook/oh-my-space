## 1. Resolve the default inside finalization

This group changes behavior for every caller at once, so its tests land with it.

- [x] 1.1 In `scripts/lib/topology-commit.ts`, widen `finalizeTopology`'s `commit` parameter to `boolean | undefined` and resolve `const createCommit = commit ?? true` at the top of the decision block (`topology-commit.ts:88`). Do not express the default in the commander option declaration — with neither flag passed, `opts()` returns `{}` and `options.commit` is `undefined`, so a flag-layer default is invisible to `runSync([alias], {})` at `scripts/lib/branch-list.ts:97`.
- [x] 1.2 Delete `confirmTopologyCommit` (`topology-commit.ts:29`), its `!commit && process.stdin.isTTY && ...` gate (`:90`), and the now-unused `cancel`, `isCancel`, and `select` imports from `@clack/prompts` (`:1`). Keep the `declined` distinction only if it still affects output; otherwise fold the no-commit message into the single `!createCommit` branch.
- [x] 1.3 Confirm every safety branch after the resolution is untouched and still evaluated in the same order: partial removal rejection (`:109`), `remove` unrelated-staged rejection (`:126`), `remove` partial-failure skip (`:119`), `add` partial-failure temp-index finalization, the `oms.yaml` disclosure (`:139`), and the `finalizeRootCommit` failure paths (`:158`).
- [x] 1.4 In `scripts/lib/types.ts`, make `commit` optional on the sync and unsync option types so `undefined` type-checks through `runSync` and `runUnsync` into `finalizeTopology`.
- [x] 1.5 Run `npm run build` and confirm `tsc --noEmit` passes before touching the CLI surface.

## 2. CLI surface

- [x] 2.1 In `scripts/oms.ts`, add `.option("--no-commit", "leave the root topology changes unstaged")` to `sync` and `unsync`, keeping the existing `--commit` declarations. Verify both flags coexist: `--commit` yields `{commit:true}`, `--no-commit` yields `{commit:false}`, and neither yields `{}`.
- [x] 2.2 Reword the `--commit` option descriptions to state that the topology commit is the default and the flag is retained for compatibility.
- [x] 2.3 Update `syncHelp` and `unsyncHelp` in `scripts/lib/help.ts` (`help.ts:47-58`): replace the two "left unstaged by default" paragraphs, keep the `--commit` examples, and add `--no-commit` examples.
- [x] 2.4 Verify by hand in a scratch workspace: `oms sync api` in a pipe creates the commit; `oms sync api --no-commit` leaves it unstaged; `oms sync api --commit` matches the default.

## 3. Triage the existing suite

Run the full suite first and triage from the actual failures rather than editing call sites speculatively. `sync` is invoked without `--commit` 89 times and `unsync` 26 times; most only need a synced submodule.

- [x] 3.1 Run `npm test` and capture the failing set.
- [x] 3.2 Fixtures that deliberately build pending topology get `--no-commit`: `tests/cli-commit.contracts.js:1196`, `tests/cli-sync.contracts.js:620`, `:730`, `:1063`. Confirm each still produces the state its test is about.
- [x] 3.3 Retarget the help-text assertions at `tests/cli-sync.contracts.js:1190` and `:1195`, which match `/left unstaged by default/`, to the new wording.
- [x] 3.4 Triage every remaining failure into "depended on the old default" (add `--no-commit`) or "asserted the old default" (update the assertion). Do not add `--no-commit` to a call site that merely needed a synced submodule — those should now also exercise the new default.
- [x] 3.5 Add tests for the new behavior: `oms sync api` non-interactively creates the topology commit and exits 0; `oms unsync api` non-interactively creates the removal commit; `--no-commit` leaves both unstaged with unrelated staged paths preserved; `--commit` and no flag produce identical results; `oms sync api web` still produces one commit with the plural message.
- [x] 3.6 Add a regression test that no topology prompt is ever emitted: with an active prompt queue containing exactly one entry consumed elsewhere, a sync that finalizes topology must not exhaust the queue or raise `PromptQueueError`.

## 4. Fix the branch list re-run defect

- [x] 4.1 Confirm the mechanism before editing: `branch-list.ts:97` delegates with `runSync([alias], {})`, the uncommitted topology makes `aliasRegistration` (`branch-list.ts:44`) return `partially registered`, and `prepareAlias` (`:108`) then exits 1 on the next invocation. Task 1.1 removes the cause; no change to `branch-list.ts` should be required.
- [x] 4.2 Invert the `pendingAdd` assertions in `tests/cli-branch-list.contracts.js:241-243`: the immediately repeated `oms branch list api` now exits 0 and prints the branch inventory instead of failing with `/inconsistent|pending/`.
- [x] 4.3 Confirm the cancel half of that test (`:245-253`) is unaffected — no `.gitmodules` and no `oms/api/.git` after cancelling.
- [x] 4.4 Review the other `--commit` references in `tests/cli-branch-list.contracts.js` (`:56`, `:203`, `:282`, `:308`, `:359`) and the delegated-sync redaction test at `:256` for dependence on the old default.
- [x] 4.5 Run `npm run test:blackbox` and confirm the whole suite is green.

## 5. Documentation and release

- [x] 5.1 Update `README.md:137` (the one-finalization paragraph), `README.md:219` (the `oms sync` row), and `README.md:230` (the `oms unsync` row) to state that the topology commit is the default and `--no-commit` opts out.
- [x] 5.2 Write `docs/migrations/0.14.x-to-0.15.0.md` following the structure of `docs/migrations/0.13.x-to-0.14.0.md`: the old and new defaults, the `oms sync api` → `oms sync api --no-commit` and `oms unsync api` → `oms unsync api --no-commit` mapping for callers that want the previous behavior, a note that `--commit` still works, and the `oms branch list` re-run fix.
- [x] 5.3 Add the changeset as `minor` with a `BREAKING:` paragraph covering the reversed default, `--no-commit`, `--commit` becoming a no-op, the removal of the interactive prompt, and the `oms branch list` fix, pointing at the migration document.
- [x] 5.4 Run `npm run build` and `npm test` one final time, then `openspec validate change-topology-commit-default --strict`.
