## Why

`--all` is the established non-interactive whole-workspace selector on `oms sync`, `oms status`, `oms fetch`, `oms pull`, and `oms unsync`, but `oms push` and `oms record` do not accept it. `push` goes further and requires `<aliases...>`, so it is the only submodule-set command with neither an interactive selection path nor a whole-workspace flag. `record` accepts a single `[alias]`, so recording the pointers that `oms pull --all` just moved takes one invocation per alias even though `oms sync --all --commit` already proves the codebase can finalize several aliases in one root commit.

Both gaps are selection-surface inconsistencies rather than missing capability: `push` already routes through the same `selectRepos()` helper that reads `options.all`, and `record` already commits through a path-limited `git commit -- <path>` that extends naturally to several paths.

## What Changes

- Change `oms push` from `<aliases...>` (required) to `[aliases...]` (optional) and add `--all`, giving it the same selection model as `fetch`/`pull`/`sync`/`unsync`. Omitting aliases in an interactive terminal opens the existing multi-select prompt.
  - **Behavior change** (not a capability removal): `oms push` with no arguments currently fails with commander's "missing required argument" and will instead prompt. Non-interactive invocations without aliases and without `--all` still exit non-zero with an actionable message.
- Change `oms record` from `[alias]` to `[aliases...]` and add `--all`, so one invocation can record several moved pointers.
- Record several aliases in a **single** path-limited root commit, following the existing `sync`/`unsync` topology-commit convention:
  - one alias keeps today's message, `chore(oms): update <alias> submodule to <short-sha>`
  - several aliases use `chore(oms): update submodules` (names omitted, mirroring `chore(oms): add submodules`)
- Split `record`'s per-alias precondition failures by how the alias was selected:
  - an **explicitly named** alias keeps today's hard error and its recovery guidance (unchanged exit codes and messages)
  - an alias included by `--all` is **skipped and reported** in a summary, so one bad alias no longer blocks the rest
  - root-wide conditions (conflicted gitlink, in-progress root Git operation, root detached HEAD, unrelated staged paths) still abort the whole invocation
- Scope `record`'s unrelated-staged-paths check to the **selected** alias set rather than the committed set, so a skipped alias whose gitlink happens to be staged does not get misread as an unrelated staged path and abort the invocation.
- Keep the interactive `record` picker's candidate filter (moved pointers, excluding pending removals) and widen it from single-select to multi-select.
- Report `record` outcomes through the existing set-command machinery: add `"recorded"` to `OperationResult`, map a problem skip to the existing `"failed"` result, and reuse `printSummary()` / `exitFromResults()`. A skip whose only cause is an unmoved pointer is benign and does not affect the exit code; any other skipped condition is reported and makes the command exit 2.
- **Fix an existing defect on the shared selection path.** An omitted selection in a non-interactive shell currently renders the prompt and then dies with Node's `Detected unsettled top-level await` warning and **exit 13** — measured for `sync`, `fetch`, `pull`, and `unsync`. Adding the guard in `selectRepos()` (the single point every set command passes through) turns that into exit 1 with a message naming `--all` or an explicit alias. This is also what keeps `push` from regressing into that path when its alias list becomes optional.
- Extend the fail-closed prompt test seam so the new interactive selection paths are verifiable: add a `{"type":"multiselect","values":[...]}` queue entry and a `guardedMultiselect()` function to `prompt-adapter.ts`, and switch `selectInteractive` and the `record` picker onto the seam with the established `Boolean(process.stdin.isTTY) || promptQueueActive()` predicate. `resolveRemotes`, `resolveInitializedAlias`, and `pickBranch` stay on raw prompts.
- Split `resolveCommandAlias` by capability rather than branching inside it: extract the shared candidate builder, keep `resolveCommandAlias` unchanged for `commit`'s single-select path, and add `resolveRecordAliases` for `record`'s set path.
- Promote the post-`pull`/post-`push` follow-up hint to `oms record --all` when more than one pointer moved in the same invocation.

## Capabilities

### New Capabilities

None. This widens the selection surface of two existing commands; it introduces no new capability.

### Modified Capabilities

- `ai-submodule-workflow`: one requirement is modified and two are added.
  - **MODIFIED** "Current submodule alias resolution" — it currently scopes omitted-alias resolution to "supported one-alias commands", and `record` leaves that category. The requirement now distinguishes one-alias resolution (`commit`) from multi-alias resolution (`record`), states that an explicit alias list or `--all` suppresses current-path inference, and describes `record`'s candidate picker as multi-select.
  - **MODIFIED** "Guarded deterministic prompt responses" — its scenario enumerates the accepted queue entry types, so adding a `multiselect` entry changes it. The fail-closed guarantees are unchanged.
  - **ADDED** "Whole-workspace selection for submodule-set commands" — the optional alias list, `--all`, interactive resolution of an omitted list, and the non-interactive failure that now applies to every set command.
  - **ADDED** "Multi-alias root pointer records" — the single path-limited commit, the singular/plural message split, the named-alias-fails vs `--all`-skips split with its exit codes, the benign-versus-problem skip distinction, and the selected-set scoping of the unrelated-staged-paths check.
  - The existing "Explicit root pointer records" and "Pull and push keep root pointer updates explicit" requirements are **not** modified. Every one of their scenarios is written against a single explicitly named alias (`oms record api`, `oms push api`, `oms push api web`), and this change preserves those invocations exactly, so each scenario remains true as written.

## Impact

- **Code**: `scripts/oms.ts` (`push` and `record` argument/option declarations), `scripts/lib/types.ts` (`PushOptions` gains the `SourcesOptions` selection fields; `OperationResult` gains `"recorded"`), `scripts/lib/commit.ts` (`runRecord` becomes set-based), `scripts/lib/prompts.ts` (the `selectRepos` guard, `selectInteractive` onto the seam, and the new `resolveRecordAliases` beside the extracted candidate builder), `scripts/lib/prompt-adapter.ts` (`multiselect` entry type and `guardedMultiselect`), `scripts/lib/operation-results.ts` (`printSummary` counts the new result), `scripts/lib/status.ts` (`printRootFollowup` aggregation for the `--all` hint), `scripts/lib/help.ts` (`pushHelp`, `recordHelp` examples). `scripts/lib/manage-ops.ts` already reads `options.all` for `push`'s summary; it changes only to collect moved-pointer aliases for the aggregated hint.
- **Reuse**: `runRecord`'s set-based unrelated-staged check follows the existing `unrelatedStagedTopologyPaths()` pattern in `scripts/lib/topology-commit.ts`; the plural message follows `topologyCommitMessage()` in the same file; the per-alias `log.error`-then-continue reporting follows `scripts/lib/manage-ops.ts`; the non-interactive predicate follows `scripts/lib/branch-delete.ts:28`.
- **Docs**: `README.md` command reference rows for `oms push` and `oms record`; `skills/oms-pointer/SKILL.md` and `skills/oms-workspace/SKILL.md` where the pointer loop is written as `oms record <alias>`.
- **Tests**: `tests/cli-commit.test.js` (record selection, plural commit message, skip-vs-fail split with exit codes, benign-skip exit 0, staged-set scoping, multi-select picker via the queue), `tests/cli-tools.test.js` (push optional aliases, `--all`, interactive selection via the queue, non-interactive omission for every set command).
- **Users**: Additive for every existing invocation. `oms push api`, `oms push api web`, and `oms record api` behave exactly as before. Two invocations change: `oms push` with no arguments moves from a commander usage error to a prompt (interactive) or an actionable OMS error (non-interactive); and `oms sync` / `oms fetch` / `oms pull` / `oms unsync` with no arguments in a non-interactive shell move from exit 13 with a Node internals warning to exit 1 with an actionable message. Pre-1.0, so a minor bump covers it; the changeset must state both.
- **Automation policy**: this brings the shared selection path into compliance with the existing `cli-automation-policy` requirement that a non-interactive shell with no explicit selection exits non-zero naming the missing decision. No policy requirement changes — the code was out of compliance with a requirement that already existed.
