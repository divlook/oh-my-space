## Context

OMS has two selection surfaces for submodule-set commands:

| Command | No arguments | `--all` | Argument |
| --- | --- | --- | --- |
| `sync`, `fetch`, `pull`, `unsync` | interactive multi-select | every declared repo | `[aliases...]` |
| `status` | every declared repo | every declared repo (same result) | `[aliases...]` |
| `push` | commander usage error | not accepted | `<aliases...>` |
| `record` | infer from cwd, else single-select picker | not accepted | `[alias]` |

`selectRepos()` (`scripts/lib/prompts.ts:201`) is the shared resolver for the first group and already implements `if (options.all) return repos`. `push` already calls it through `runManage()` (`scripts/lib/manage-ops.ts:107`), and `runManage`'s signature is already `SourcesOptions & PushOptions & RemoteOptions` with an `options.all` read at line 122. The only thing blocking `push --all` is the command declaration in `scripts/oms.ts:240-243`.

`record` is different. `runRecord()` (`scripts/lib/commit.ts:98`) is written against exactly one alias: it resolves one alias, derives one path, evaluates a chain of preconditions against that path, and finishes with a path-limited `git add -- <path>` + `git commit -m <msg> -- <path>` (`commit.ts:176-181`). It deliberately does not use the temporary-index transaction in `root-tx.ts` that `sync`/`unsync` use, because a path-limited commit already isolates the selected path from the rest of the index.

### Measured non-interactive behavior

The current behavior of an omitted selection in a non-interactive shell was measured directly (`stdin` from `/dev/null`), because it determines whether this change can safely make `push`'s alias list optional:

| Command | Result | Exit |
| --- | --- | --- |
| `sync`, `fetch`, `pull`, `unsync` | renders the prompt, then Node's `Detected unsettled top-level await` warning | **13** |
| `record`, `commit` | `No alias given and stdin is not a TTY. Pass an alias: "oms record <alias>".` | 1 |
| `push` (today) | `error: missing required argument 'aliases'` | 1 |

Two consequences follow. `record` already satisfies `cli-automation-policy`'s non-interactive requirement through the guard at `prompts.ts:253`, so it needs only a wording update. And `push` currently exits 1 with a clear message, so making its alias list optional without a guard would **regress** it into the exit-13 path — a defect introduced by this change rather than a pre-existing one.

### Prompt seam state

`prompt-adapter.ts` is the fail-closed test seam for prompts: under `OMS_TEST_MODE=1` a JSON queue in `OMS_TEST_PROMPT_RESPONSES` drives prompts deterministically, and `promptQueueActive()` exists specifically so interactive flows can use it "in place of TTY detection".

The seam is only partly adopted:

| Location | Prompt source | Non-interactive predicate |
| --- | --- | --- |
| `branch-delete.ts:28`, `branch-list.ts:31` | `guardedSelect` / `guardedConfirm` | `Boolean(process.stdin.isTTY) \|\| promptQueueActive()` |
| `prompts.ts` (all 5 prompt functions) | raw `@clack/prompts` | bare `!process.stdin.isTTY` |

The seam also has no `multiselect` support — `ResponseEntry` covers only `select`, `confirm`, and `cancel`. Consequently every interactive path in `prompts.ts` is unreachable from tests, which is why `tests/cli-commit.test.js` contains zero prompt injections.

### Existing conventions this change follows

- `topologyCommitMessage()` (`scripts/lib/topology-commit.ts:15`) names a single alias and omits names in the plural form (`chore(oms): add api submodule` vs `chore(oms): add submodules`).
- `unrelatedStagedTopologyPaths()` (`scripts/lib/topology-commit.ts:23`) is the set-based form of the unrelated-staged check that `runRecord` currently implements for one path (`commit.ts:157`).
- `manage-ops.ts` reports a per-alias problem with `log.error`, continues the loop, and lets `exitFromResults()` produce exit 2. Every clack `log.*` call writes to **stdout**; only `--json` code paths write to stderr, to keep stdout pure JSON.
- Documented exit codes (`help.ts:1`): `0 ok | 1 usage/config error | 2 one or more git operations failed`.

## Goals / Non-Goals

**Goals:**

- Give `push` the same selection model as `fetch`/`pull`/`sync`/`unsync`, with no new selection code.
- Let one `oms record` invocation record several moved pointers, including every moved pointer via `--all`.
- Keep every currently valid invocation (`oms push api`, `oms push api web`, `oms record api`) byte-identical in output and exit code.
- Keep multi-alias root commits consistent with the existing topology-commit convention.
- Make the new interactive selection paths reachable from tests.
- Close the exit-13 non-interactive defect on the shared selection path.

**Non-Goals:**

- Adding `--all` to `commit`, `branch switch`, `branch checkout`, `branch list`, or `branch delete`. Those were considered and deferred: `commit --all` would apply one `-m` message to several repos and collides with `git commit -a`; the `branch` subcommands need a per-repo branch-existence policy that this change does not define.
- Replacing `record`'s path-limited commit with the `root-tx.ts` temporary-index transaction.
- Changing `record`'s scope: it still refuses adds and removals and never touches `.gitmodules`.
- Migrating `resolveRemotes`, `resolveInitializedAlias`, or `pickBranch` to the prompt seam (see Decision 8).
- Removing the redundancy of `status --all`.

## Decisions

### 1. `push` becomes `[aliases...]` with `--all`, inheriting the interactive path

Commander rejects `oms push --all` while the variadic argument is declared `<aliases...>` (required), so `--all` forces the argument to become `[aliases...]`. Once it is optional, `selectRepos()` routes an empty alias list to `selectInteractive()`, so the interactive multi-select prompt arrives with no additional code.

Suppressing that prompt to preserve today's "aliases are mandatory" behavior would require *adding* a guard, and would leave `push` as the only submodule-set command with a bespoke selection model. The chosen direction is to accept the prompt.

*Alternative considered*: keep `<aliases...>` required and add a guard that errors when the alias list is empty and `--all` is absent. Rejected — it is more code for less consistency, and the "push is outward-facing so be strict" argument is undercut by `unsync --all`, which is far more destructive and already exists.

**Consequence to document**: `oms push` with no arguments changes from commander's "missing required argument" to a prompt. This is a behavior change on an invocation that previously always failed, not a removal of capability.

### 2. `record` becomes `[aliases...]` with `--all`

`--all` presupposes a set, so leaving the argument singular would allow only "exactly one" or "every one" and would make the `--all` path a separate code path from the argument path. Widening the argument to `[aliases...]` keeps one resolution path and matches the other set commands.

The cwd-inference rule is unchanged in substance and restated in set terms: inference applies only when neither an explicit alias list nor `--all` is supplied. An explicit selection continues to win over inference.

The interactive picker keeps its command-specific candidate filter (moved pointers, excluding pending removals) and changes from single-select to multi-select. Because the candidate list is already filtered to recordable aliases, the picker cannot surface an alias that would fail a per-alias precondition.

### 3. One root commit for several aliases, with the plural message omitting names

Following `topologyCommitMessage()`:

```
1 alias   →  chore(oms): update <alias> submodule to <short-sha>   (unchanged)
N aliases →  chore(oms): update submodules
```

The single-alias message embeds a short SHA, which cannot generalize to N aliases in a subject line. Omitting the names in the plural form is what `sync`/`unsync` already do, and the per-alias SHAs remain visible in the commit itself (`git show --stat`).

*Alternatives considered*: a subject plus a body listing `alias -> sha` preserves more information, but no `chore(oms)` commit in this project has a body, so it would introduce a convention that `sync`/`unsync` would then need to match. One commit per alias avoids a new message format entirely, but diverges from the established one-commit topology behavior and introduces a partial-failure/rollback question that a single commit does not have.

The commit stays a path-limited `git add -- <paths...>` + `git commit -m <msg> -- <paths...>`, extended from one path to N. No temporary-index transaction is introduced.

### 4. Per-alias failures: explicit selection errors, `--all` selection skips

`runRecord` currently ends the invocation on any precondition failure. With `--all`, a single unrecordable alias would block every other alias, so the failure modes are split by **how the alias entered the selection**:

```
explicitly named on the command line  →  hard error, today's message and exit code
included by --all                      →  skipped, reported in the summary
```

The conditions are also split by **scope**:

| Scope | Condition | Behavior |
| --- | --- | --- |
| Root-wide | conflicted gitlink, in-progress root Git operation (`commit.ts:126`) | abort the whole invocation |
| Root-wide | root detached HEAD (`commit.ts:131`) | abort the whole invocation |
| Root-wide | staged paths outside the selected set (`commit.ts:157`) | abort the whole invocation |
| Per-alias | no recorded gitlink in root HEAD (`commit.ts:137`) | error if named, skip if `--all` |
| Per-alias | pending removal, path absent (`commit.ts:145`) | error if named, skip if `--all` |
| Per-alias | staged pointer differs from working tree (`commit.ts:149`) | error if named, skip if `--all` |
| Per-alias | pointer has not moved (`commit.ts:166`) | already a no-op; a benign skip |
| Per-alias | submodule has uncommitted source changes (`commit.ts:171`) | warn and continue (unchanged) |

This keeps every existing single-alias error message and exit code intact, so the change to error handling is confined to the `--all` path. A skipped alias still carries its recovery guidance into the summary line (for example, a missing gitlink points at `oms sync <alias> --commit`).

*Alternative considered*: always skip, for one uniform rule. Rejected — `oms record api` would stop reporting a specific, actionable failure and would return exit 0, which changes existing exit codes and weakens the response to an explicit request.

### 5. The unrelated-staged check is scoped to the selected set, not the committed set

This is where decisions 3 and 4 interact, and getting it wrong silently defeats decision 4.

```
oms record --all
  api  = staged pointer differs from working tree  → skipped (decision 4)
  web  = moved  → recorded
  core = moved  → recorded

staged root paths = [oms/api, oms/web, oms/core]

If the check is "staged paths minus the COMMITTED set [oms/web, oms/core]":
  oms/api is flagged as an unrelated staged path → whole invocation aborts
  → the alias that decision 4 wanted to skip blocks web and core instead

If the check is "staged paths minus the SELECTED set [oms/api, oms/web, oms/core]":
  oms/api passes the check
  the path-limited commit covers only oms/web and oms/core
  oms/api stays staged and untouched, exactly as before the command ran
```

The check therefore uses the selected alias set. The original intent — reject staged changes outside `oms/`, or inside `oms/` but outside the user's selection — is preserved, following the `unrelatedStagedTopologyPaths()` pattern.

### 6. The non-interactive guard goes on the shared selection path

`push`'s guard is mandatory, not optional: without it, making the alias list optional replaces today's exit-1 usage error with the exit-13 unsettled-await path measured above.

The guard goes in `selectRepos()`, immediately before the `selectInteractive()` call, because that is the single point every set command already passes through. This makes fixing all five commands *less* code than fixing `push` alone, which would need a `push`-specific branch in `runManage` while leaving the defect in place for the other four:

```
selectRepos(repos, aliases, options, actionLabel)
  if (options.all) return repos;
  if (aliases.length === 0) {
    if (non-interactive) { actionable error; return null; }   ← one guard
    return selectInteractive(repos, actionLabel);
  }
```

`sync`, `fetch`, `pull`, and `unsync` therefore move from exit 13 plus a Node internals warning to exit 1 plus a message naming `--all` or an explicit alias. Exit 13 is a crash artifact rather than specified behavior, so this is a defect fix; the changeset records it.

`record`'s existing guard (`prompts.ts:253`) already produces the correct outcome and only needs `--all` added to its message.

### 7. Extend the prompt seam to `multiselect`

The spec asserts that an omitted alias list prompts interactively for both `push` and `record`. Those scenarios are unverifiable today: `prompts.ts` calls raw `@clack/prompts`, and its guards use bare `process.stdin.isTTY`, so tests (which run without a TTY) can never reach a prompt.

Making them verifiable needs both halves:

- the non-interactive predicate becomes `Boolean(process.stdin.isTTY) || promptQueueActive()`, matching `branch-delete.ts:28` and `branch-list.ts:31`
- `prompt-adapter.ts` gains a `multiselect` entry type and a `guardedMultiselect()` function, extending the existing union rather than replacing the seam:

```
type ResponseEntry =
  | { type: "select";      value: string }
  | { type: "confirm";     value: boolean }
  | { type: "multiselect"; values: string[] }    ← added
  | { type: "cancel" }
```

This is the riskiest part of the change by blast radius, since the seam is fail-closed infrastructure. The existing protections carry over unchanged: a malformed entry, a type that does not match the requested prompt, and unconsumed responses at completion all still exit 1 without opening a real prompt.

`record`'s single-select-to-multi-select move is the newest behavior in this change, so shipping it unverified is the outcome this decision exists to avoid.

*Alternative considered*: leave the seam alone and rely on bare `isTTY`. Rejected — it would ship two new spec scenarios that no test can exercise. An intermediate option (change only the predicate, so the auto-select-single-candidate and zero-candidate paths become testable while the real prompt stays unreachable) was also considered and rejected for leaving the multi-select prompt itself unverified.

### 8. The seam migration is scoped to the two functions this change touches

`prompts.ts` has five prompt functions. Only two are on this change's paths:

| Function | Prompt | Migrated? |
| --- | --- | --- |
| `selectInteractive` | multiselect | **yes** — `push`'s interactive path |
| `resolveCommandAlias` | select → multiselect for `record` | **yes** — `record`'s picker |
| `resolveRemotes` | select + multiselect | no |
| `resolveInitializedAlias` | select | no |
| `pickBranch` | select + text | no |

`resolveRemotes` is deliberately excluded. Its guard at `prompts.ts:173` is a **default** (`if (!process.stdin.isTTY) return ["origin"]`), not a decision gate — it is the automation policy's "only one safe routine choice exists, select it automatically" case. Adding `|| promptQueueActive()` there would make every `push`/`fetch`/`pull` test with an active queue prompt for remotes once per repo, adding queue bookkeeping to tests that are not about remote selection.

One cross-cutting correctness point: `prompts.ts` currently imports `isCancel` from `@clack/prompts`, which returns false for the adapter's `PROMPT_CANCEL` sentinel. Mixing a guarded prompt with clack's `isCancel` would silently treat an injected cancel as a real selection. The adapter's `isCancel` handles both clack's symbol and the sentinel, so the import switches **file-wide**; it is a strict superset and changes nothing for the functions that keep raw prompts.

### 9. `resolveCommandAlias` splits by capability instead of branching

`resolveCommandAlias` is shared by `commit` (single-select) and `record` (now multi-select). Rather than widen its return type to express both shapes and thread a `command` branch through every step, the candidate builder is extracted and the resolvers split:

```
commandCandidates(repos, repoRoot, command)     shared candidate + message selection
  commit → initialized && dirty
  record → gitlinkState.pin === "moved"

resolveCommandAlias(...)  → AliasResolution      commit; signature and return type unchanged
resolveRecordAliases(...) → AliasSetResolution   record; new, guardedMultiselect
```

This follows the project's preference for extension over modification and leaves `commit`'s code path — and therefore its existing tests — untouched. Widening the shared function would have pulled `commit` into this change's regression surface for no benefit.

### 10. Skips are reported through the existing set-command machinery

`record` adopts `OperationResult` / `printSummary()` / `exitFromResults()` rather than growing a bespoke summary, because the mapping falls out cleanly and produces the exit codes decided below for free:

| Outcome | `OperationResult` | Log level | Exit contribution |
| --- | --- | --- | --- |
| pointer recorded | `"recorded"` (added to the union) | `log.success` | 0 |
| problem skip — missing gitlink, pending removal, staged split | `"failed"` | `log.error` | 2, via `exitFromResults` |
| benign skip — pointer has not moved | not pushed to results | silent | 0 |

The `log.error`-then-continue shape is exactly what `manage-ops.ts` already does for a per-alias failure that must not stop the loop. Output goes to stdout because every clack `log.*` does; `record` has no `--json` mode, so the stderr exception for machine-readable stdout does not apply.

The two skip classes must stay distinct. Treating a benign skip as a failure would make `oms record --all` exit 2 whenever any declared repo happened to be unchanged, which is the normal case and would render the flag unusable. Treating a problem skip as success would let CI report green while pointers went unrecorded.

**Exit-code split.** The same underlying condition yields different exit codes depending on the path, and this matches the documented meanings in `help.ts:1`:

```
oms record api    → exit 1   usage/config error: the named request was rejected, nothing ran
oms record --all  → exit 2   one or more of the set did not complete; the commit for the rest exists
```

This mirrors `sync`, which commits the aliases that succeeded and lets the caller surface the overall non-zero exit (`topology-commit.ts:118`).

### 11. Aggregate the `record` follow-up hint

`printRootFollowup()` (`scripts/lib/status.ts:581`) prints one hint per alias, so `oms pull --all` moving three pointers prints three `oms record <alias>` hints. When more than one pointer moved in the same invocation, the hint collapses to a single `oms record --all`. This is a presentation change only; the underlying `rootFollowupHint()` classification is untouched.

## Risks / Trade-offs

- **`oms push` with no arguments now prompts instead of failing.** → Interactive users get a strictly better result. Non-interactive callers still exit non-zero, now with an actionable message instead of exit 13. The changeset and README call the change out explicitly.
- **Extending `prompt-adapter.ts` touches fail-closed test infrastructure.** → The change is additive: one new union member and one new guarded function, alongside the existing `guardedSelect`/`guardedConfirm`. Every fail-closed path (malformed queue, type mismatch, unconsumed responses) is unchanged and already covered by the "Invalid test response configuration fails closed" scenario.
- **Four commands unrelated to `--all` change their non-interactive exit code (13 → 1).** → Exit 13 is Node's unsettled-top-level-await artifact, not a documented outcome, and both values are non-zero. The improvement is a clearer message on the same failure.
- **`prompts.ts` ends with guarded and raw prompts side by side.** → Accepted to keep the change scoped. `isCancel` is unified file-wide so the one genuinely dangerous mixing mode cannot occur; the remaining difference is which prompt function each call site uses.
- **The plural commit message drops alias names.** → Accepted for consistency with `chore(oms): add submodules`. `git show --stat` lists the affected gitlinks, so no information is lost from the commit, only from the subject line.
- **`record` gains two behaviors for the same precondition (error vs skip).** → Test surface grows: each per-alias condition needs a named-alias case and an `--all` case. Mitigated by driving both from one precondition evaluator that returns a per-alias verdict, with only the caller deciding whether a negative verdict aborts or is collected.
- **A partially-successful `oms record --all` still creates a commit.** → Matches `sync --all`. The exit code is 2 and the skipped aliases are named, so the remaining work is visible.
- **`--all` on `record` makes it easier to record several pointers without reviewing them.** → `record` only ever commits pointers that already moved in the working tree; it cannot move a pointer itself. The pre-existing dirty-submodule warning still fires per alias.

## Migration Plan

No data or config migration. The change is additive for every currently valid invocation; only `oms push` with no arguments behaves differently, and that invocation previously always failed. A minor version bump covers it, and the changeset states the `push` no-argument change explicitly.

## Open Questions

None outstanding. The two questions raised during design — the scope of the non-interactive guard, and the output stream for the skip summary — were resolved into Decisions 6 and 10 respectively, the second by the project's existing stdout convention for commands without a `--json` mode.
