## Why

`oms sync` and `oms unsync` finish their topology work and then stop short of recording it. The default is to leave `.gitmodules` and the selected gitlinks as unstaged working-tree changes; a root topology commit happens only when `--commit` is passed or an interactive prompt is accepted. That default produces three problems.

**The outcome depends on the terminal, not the repository.** `finalizeTopology` (`scripts/lib/topology-commit.ts:90`) gates its prompt on `process.stdin.isTTY`. In a terminal the prompt appears and defaults to Yes, so the commit is normally created. In a non-interactive shell the prompt is skipped entirely, `createCommit` stays false, the topology is unstaged, and the command exits 0. Identical repository state, opposite results, decided by whether stdin is a TTY. `cli-automation-policy` addresses this directly: when a workflow needs human intent and stdin is non-interactive, OMS must exit non-zero naming the missing decision — not silently pick an answer.

**The job is left half-finished.** After a non-interactive `oms sync api`, the submodule is initialized but the root has uncommitted topology. `oms status` then prints `Run "oms sync api --commit" to create the topology commit`. The user ran one command, got exit 0, and still has a required follow-up.

**It breaks the automation-first path that already exists.** `oms branch list` prepares an unregistered alias by delegating to `runSync([alias], {})` (`scripts/lib/branch-list.ts:97`). Because that call passes no `commit` option and the delegated sync runs with a consumed prompt queue, the topology is left unstaged and the alias lands in the `partially registered` classification. The next `oms branch list api` therefore fails with exit 1. `tests/cli-branch-list.contracts.js:241-243` asserts exactly this: the command succeeds once, then fails when run again immediately. The command built to be automation-first leaves the workspace in a state that breaks its own next invocation.

The interactive prompt already defaults to Yes, which is the codebase stating that committing is the expected outcome. `cli-automation-policy` says OMS must not prompt merely for confirmation when one safe routine choice exists.

## What Changes

- Make the root topology commit the default for `oms sync` and `oms unsync`. Both commands create the path-limited topology commit whenever pending topology or reconciled metadata exists and the existing safety conditions hold.
- Add `--no-commit` to `oms sync` and `oms unsync` to opt out and keep the previous leave-unstaged behavior.
- Remove `confirmTopologyCommit` and the interactive prompt it drives. Committing is no longer a question; declining is an explicit flag.
- Keep `--commit` accepted as a no-op so existing invocations, scripts, and documentation examples continue to work unchanged.
- Resolve the default inside `finalizeTopology` as `commit ?? true`, **not** in the commander option declaration.
  - **Verified**: declaring both `--commit` and `--no-commit` for the same key is accepted by commander without error, but with neither flag present `opts()` returns `{}`, so `options.commit` is `undefined`. Placing the default only at the flag layer would leave every programmatic caller that passes an empty options object — `runSync([alias], {})` at `scripts/lib/branch-list.ts:97` today, and the additional prepare-sync callers that `unify-alias-preparation` adds — silently falling into the leave-unstaged path this change exists to remove.
- **Fix the `oms branch list` re-run defect.** With the delegated sync now committing its topology, a prepared alias is fully registered, so an immediately repeated `oms branch list api` succeeds instead of failing with `partially registered`. This is a behavior fix, and the contract assertions that pin the current failure are updated rather than preserved.
- Preserve every existing safety branch in `finalizeTopology` unchanged. Only the default answer moves:
  - partial removal topology is still rejected before committing (exit 2)
  - a `remove` commit still refuses unrelated staged root paths (exit 2)
  - a partially failed `unsync` still skips the commit and leaves successful topology unstaged
  - a partially failed `sync` still finalizes only the successful aliases through the temporary index
  - the recovery preflight, temporary-index isolation, and `oms.yaml` consumption disclosure are untouched

## Capabilities

### New Capabilities

None. This changes the default answer to a decision the workflow already makes; it adds no capability.

### Modified Capabilities

- `ai-submodule-workflow`: one requirement is modified.
  - **MODIFIED** "Pull and push keep root pointer updates explicit" — this requirement owns the sync/unsync topology finalization scenarios. Its two leave-unstaged scenarios become `--no-commit` scenarios; its four prompt scenarios (interactive sync, interactive unsync, and the two pending-state re-prompt scenarios) are replaced by unprompted commit scenarios; the two `--commit` bypass scenarios become no-op-flag scenarios. Every safety scenario — partial removal rejection, unrelated staged rejection, partial multi-alias behavior, commit-failure preservation, and all pull/push pointer scenarios — is restated unchanged.
  - The "Submodule branch inventory" requirement's delegated-sync scenario (`spec.md:289`) states that branch list delegates the commit-or-unstage decision to the sync workflow. That remains true: the delegated decision simply now resolves to commit. The requirement is **not** modified.

## Impact

- **Code**: `scripts/lib/topology-commit.ts` (`finalizeTopology` resolves `commit ?? true`; `confirmTopologyCommit` and its `select` import removed), `scripts/oms.ts` (`--no-commit` on `sync` and `unsync`; `--commit` retained), `scripts/lib/types.ts` (`SyncCommitOptions` / `UnsyncOptions` carry an optional tri-state `commit`), `scripts/lib/help.ts` (`syncHelp`, `unsyncHelp`).
- **Docs**: `README.md:137` (the one-finalization paragraph), `README.md:219` (the `oms sync` row), `README.md:230` (the `oms unsync` row), and a new `docs/migrations/0.14.x-to-0.15.0.md`.
- **Tests**: `tests/cli-sync.contracts.js` — 29 `--commit` references plus the two help-text assertions at `:1190` and `:1195` that match `/left unstaged by default/`, and the staging assertions at `:620`, `:730`, and `:1063`. `tests/cli-commit.contracts.js` — 25 `--commit` references plus the pending-topology fixture at `:1196`. `tests/cli-branch-list.contracts.js` — the delegated-sync test at `:230`, whose `pendingAdd` assertions at `:241-243` flip from exit 1 to exit 0. Across the suite, `sync` is invoked without `--commit` 89 times and `unsync` 26 times; each call site needs review for whether it depends on the unstaged result or merely on a synced submodule.
- **Users**: BREAKING. `oms sync <alias>` and `oms unsync <alias>` now create a root commit where they previously did not. A workflow that ran several syncs and then hand-authored one commit will now produce one commit per invocation; `--no-commit` restores the previous behavior, and a single `oms sync api web` still produces one commit. Interactive users lose the confirmation prompt. Pre-1.0, so a minor bump covers it, and the changeset must carry a `BREAKING:` note pointing at the migration document.
- **Automation policy**: this brings topology finalization into compliance with two requirements that already exist — that OMS does not prompt merely for confirmation when one safe routine choice exists, and that a non-interactive shell never gets a silently guessed answer to a decision. No policy requirement changes in this change; `unify-alias-preparation` amends the policy spec separately.
