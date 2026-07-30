## 1. Prompt seam and the shared selection guard

This group is a prerequisite for every later group: it closes the exit-13 defect and makes the new interactive paths reachable from tests. No existing test invokes a set command without aliases or `--all`, so adding the guard regresses nothing.

- [x] 1.1 In `scripts/lib/prompt-adapter.ts`, add `{ type: "multiselect"; values: string[] }` to the `ResponseEntry` union, validate it in `validateEntry` (fail closed when `values` is not an array of strings), and widen `consume`'s return value to carry `string[]`.
- [x] 1.2 Add `guardedMultiselect()` beside `guardedSelect`/`guardedConfirm`, returning the injected `values` array or deferring to clack's `multiselect`. Keep every fail-closed path intact: malformed queue, type mismatch against the requested prompt, and unconsumed responses at completion still exit 1 without opening a real prompt.
- [x] 1.3 In `scripts/lib/prompts.ts`, switch the `isCancel` import from `@clack/prompts` to `./prompt-adapter.js` **file-wide**. The adapter's version is a strict superset (it recognizes clack's symbol and the `PROMPT_CANCEL` sentinel), so the functions that keep raw prompts are unaffected. This prevents the silent bug where a guarded prompt's injected cancel is read as a real selection.
- [x] 1.4 Add the non-interactive predicate helper matching `scripts/lib/branch-delete.ts:28` (`Boolean(process.stdin.isTTY) || promptQueueActive()`) and switch `selectInteractive` from raw `multiselect` to `guardedMultiselect`.
- [x] 1.5 Add the guard in `selectRepos` immediately before the `selectInteractive` call: when the alias list is empty, `--all` is absent, and the shell is non-interactive, log an actionable error naming `--all` or an explicit alias and return `null`. This is the single point `sync`, `fetch`, `pull`, `unsync`, and `push` all pass through.
- [x] 1.6 Add tests: each of `oms sync`, `oms fetch`, `oms pull`, `oms unsync` with no alias in a non-interactive shell exits 1 with the actionable message instead of exit 13; a malformed `multiselect` queue entry fails closed with exit 1. Verify with `npm test`.

## 2. Push whole-workspace selection

- [x] 2.1 In `scripts/lib/types.ts`, give `push` access to the shared selection fields — either widen `PushOptions` with `SourcesOptions` or combine them at the action site in `scripts/oms.ts` — so `options.all` type-checks on the `push` path that `runManage` already reads at `scripts/lib/manage-ops.ts:122`.
- [x] 2.2 In `scripts/oms.ts`, change the `push` argument from `<aliases...>` to `[aliases...]` and add `.option("--all", "push every registered source repo")`, matching the wording style of the existing `sync`/`fetch`/`pull`/`unsync` options. The guard from 1.5 already covers the non-interactive omission case.
- [x] 2.3 Update `pushHelp` in `scripts/lib/help.ts` with `oms push --all` and no-argument interactive examples, keeping the existing `--commit`-is-unsupported guidance intact.
- [x] 2.4 Add tests to `tests/cli-commit.test.js` (where the other `push` tests live; `cli-tools.test.js` covers agent/skills/update): `oms push --all` pushes every declared repo and prints a summary; `oms push` with no alias resolves through the multi-select prompt when driven by a `multiselect` queue entry; `oms push` with no alias non-interactively exits 1; `oms push api` and `oms push api web` still produce their existing output and exit codes. Verify with `npm run test:commit`.

## 3. Make record set-capable internally

Each step in this group keeps `runRecord` receiving exactly one alias, so the existing `record` tests stay green throughout.

- [x] 3.1 In `scripts/lib/commit.ts`, extract the per-alias precondition chain (`commit.ts:136-169` — missing recorded gitlink, pending removal, staged pointer split, no pointer movement) into a function returning a per-alias verdict that carries its reason string, its recovery command, and whether the condition is benign (unmoved pointer) or a problem. Keep the message text and evaluation order byte-identical.
- [x] 3.2 Add a record commit-message helper mirroring `topologyCommitMessage()` in `scripts/lib/topology-commit.ts:15`: one alias yields `chore(oms): update <alias> submodule to <short-sha>`, several yield `chore(oms): update submodules`.
- [x] 3.3 Generalize the staging and commit steps from one path to N paths (`git add -- <paths...>`, `git commit -m <msg> -- <paths...>`), and generalize the unrelated-staged check at `commit.ts:157` to compare against a path **set**, following the `unrelatedStagedTopologyPaths()` pattern in `scripts/lib/topology-commit.ts:23`.
- [x] 3.4 In `scripts/lib/types.ts` add `"recorded"` to `OperationResult`, and add its counter to `printSummary` in `scripts/lib/operation-results.ts`.
- [x] 3.5 Run `npm run test:commit` and confirm every existing `record` test passes unchanged — no test edits in this group.

## 4. Expose record's multi-alias surface

- [x] 4.1 In `scripts/lib/prompts.ts`, extract the shared candidate builder from `resolveCommandAlias` (`prompts.ts:236`) — `commit` candidates are initialized dirty submodules, `record` candidates are moved pointers excluding pending removals — leaving `resolveCommandAlias`'s signature and return type unchanged for `commit`'s single-select path.
- [x] 4.2 Add `resolveRecordAliases` returning a set resolution: an explicit alias list or `--all` wins over current-path inference; an omitted selection in an interactive shell shows a `guardedMultiselect` of the candidates; exactly one candidate still auto-selects with its existing message; zero candidates stays a no-op exit 0; a non-interactive omitted selection fails with a message that now also names `--all`.
- [x] 4.3 In `scripts/oms.ts`, change the `record` argument from `[alias]` to `[aliases...]`, add `--all`, and pass the selection options through to `runRecord`.
- [x] 4.4 Implement the failure split in `runRecord`: evaluate root-wide preconditions once and abort the invocation on failure (conflicted gitlink, in-progress root operation, root detached HEAD, staged paths outside the selected set); then apply each per-alias verdict from 3.1 as a hard failure when the alias was named explicitly, and as a collected skip when it was selected by `--all`.
- [x] 4.5 Map outcomes onto the set-command machinery: a recorded alias is `"recorded"`, a problem skip is `"failed"` reported with `log.error` plus its recovery command, and a benign skip (unmoved pointer) is not pushed to the results at all. Let `exitFromResults` produce the exit code, so `--all` with a problem skip exits 2 while a run whose only skips are benign exits 0. Print `printSummary` on the multi-alias path.
- [x] 4.6 Update `recordHelp` in `scripts/lib/help.ts` with multi-alias and `--all` examples.
- [x] 4.7 Add tests to `tests/cli-commit.test.js`: several aliases in one commit with the plural message and exit 0; the singular message preserved for one alias; a named alias with a failed precondition fails with exit 1 and today's message; `--all` skips a missing gitlink, a pending removal, and a staged pointer split while recording the rest and exiting 2; a run whose only skips are unmoved pointers exits 0 and reports no problem; a root-wide precondition aborts everything; a staged gitlink for a skipped alias is not treated as an unrelated staged path and stays staged; a staged path outside the selected set still fails; the multi-select picker selects two aliases when driven by a `multiselect` queue entry. Verify with `npm run test:commit`.

## 5. Aggregated record hint

- [x] 5.1 In `scripts/lib/status.ts`, add an aggregated follow-up path so a single invocation that moved more than one root pointer prints one `oms record --all` hint instead of one `oms record <alias>` hint per alias. Leave `rootFollowupHint()`'s per-alias classification unchanged.
- [x] 5.2 Switch the `pull` and `push` loops in `scripts/lib/manage-ops.ts` to collect moved-pointer aliases and emit the aggregated hint after the loop, preserving the single-alias hint text when only one pointer moved.
- [x] 5.3 Add a test that `oms pull --all` moving two or more pointers prints exactly one aggregated hint, and that a single moved pointer still prints today's `oms record <alias>` hint.

## 6. Documentation

- [x] 6.1 Update the `oms push` and `oms record` rows in the `README.md` command reference table (`README.md:196` and `README.md:199`) to show `/ --all`, matching how the `sync`, `status`, and `unsync` rows are written, and note the multi-alias record commit message.
- [x] 6.2 Update `skills/oms-pointer/SKILL.md` so the commit-or-pull-then-record loop mentions `oms record --all` for the case where several pointers moved, keeping the existing deferral of flag detail to `oms record --help`.
- [x] 6.3 Update the `oms record <alias>` reference in `skills/oms-workspace/SKILL.md:30` so it does not read as single-alias-only.

## 7. Verification and release

- [x] 7.1 Run `npm run build` and `npm test` and confirm the full suite is green.
- [x] 7.2 Manually verify in a scratch workspace with two declared repos: `oms push --all`; `oms push` with no argument both interactively and with stdin from `/dev/null` (expect exit 1, not exit 13); `oms record --all` with one alias in a skipped state (expect exit 2 with the rest recorded); `oms record api` in that same skipped state (expect today's exit 1 and message); `oms sync` with stdin from `/dev/null` (expect exit 1 with the actionable message).
- [x] 7.3 Add a changeset (minor) covering the `--all` additions, the `oms push` no-argument change, and the non-interactive exit-13 fix for `sync`/`fetch`/`pull`/`unsync`.
