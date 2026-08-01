## Why

`cli-automation-policy` says OMS should complete routine preparation itself rather than failing and asking the user to reproduce the steps. `oms branch list` implements that fully: it classifies an alias's registration, initializes a registered-but-uninitialized one automatically, offers `sync and continue` for an unregistered one, and only then lists branches. Every other command stops at a hard error.

```
                        auto-init    unregistered handling
  branch list              yes       offers sync and continue
  branch delete       explicit alias only   error
  commit / fetch / pull / push / branch switch / branch checkout
                            no       error
```

The result is six variants of `Run "oms sync <alias>" first` (`commit.ts:65`, `manage-ops.ts:11`, `:28`, `:57`, `prompts.ts:75`, `branch-delete.ts:76`) for a state OMS can very often resolve on its own.

Two further defects are not covered by the policy's grandfathering clause at all, because that clause is attached only to the "Automation-first command completion" requirement. They violate "Guided human decisions", which carries no such clause.

**The TTY gate runs before the candidate count.** `resolveCommandAlias` checks `!process.stdin.isTTY` at `prompts.ts:306` and only computes candidates at `:311`; `resolveRecordAliases` does the same at `:364` and `:371`. So `oms commit` with exactly one dirty submodule auto-selects in a terminal and exits 1 in a pipe — identical repository state, opposite verdicts, decided by stdin. With zero candidates it is worse: exit 0 in a terminal, exit 1 in a pipe, while `oms commit api` on that same clean submodule already exits 0 (`commit.ts:84-88`). The policy says a workflow needs human intent only when more than one materially different safe action exists; with zero or one candidate there is no intent to supply, so the gate should not apply.

**Two commands implement "only one safe choice" in opposite directions.** `branch list` auto-selects the sole declared alias (`branch-list.ts:165`), while `resolveInitializedAlias` (`prompts.ts:81-102`) and `resolveDeleteAlias` (`branch-delete.ts:105-113`) always prompt even with exactly one candidate, and fail non-interactively rather than selecting it.

Finally, the grandfathering clause itself is the reason this drift is legitimate. It reads:

> Existing workflows that are not changed remain outside this requirement until they are subsequently changed.

`openspec/config.yaml` already states the project rule without any such carve-out — *"Automation-first: automate safe, deterministic steps; ask only when a choice needs user intent."* The clause is a standing exemption that guarantees each new command re-litigates the question, which is exactly how the three-tier split above formed.

## What Changes

- **Remove the grandfathering clause** from `cli-automation-policy`, making the automation-first requirement apply to every command.
- **Add a policy requirement, "Bounded automatic preparation"**, that fixes where automatic preparation stops so future commands do not have to guess:
  - preparation that does not alter root topology is performed automatically, always
  - preparation that creates root topology is offered only when the request could actually be satisfied afterwards, and is never performed silently
  - a request that presupposes local state a fresh registration cannot contain is a terminal error naming `oms sync <alias>`
- **Extract the shared preparation module** from `branch-list.ts` into `scripts/lib/alias-preparation.ts`: `aliasRegistration()` (the four-way classification), `prepareAlias()`, a batch entry point, and `attachDetachedHead()`. `branch list` and `branch delete` move onto it, so this is an extraction rather than a second implementation.
- **Apply auto-initialization to all eight commands.** A registered-but-uninitialized alias is initialized with `git submodule update --init`, which changes no root index or HEAD state, then the command continues.
- **Apply the sync offer to five commands only** — `fetch`, `pull`, `branch list`, `branch switch`, `branch checkout`.

  `syncRepo` (`repo-ops.ts:222`) refuses to sync over a non-empty `oms/<alias>/`, and otherwise runs `git submodule add` followed by `attachBranch` (`:254`, `:263`). A newly registered alias is therefore always a clean checkout at baseline, with no uncommitted changes, no unpushed commits, and no branch other than the baseline. `commit`, `push`, and `branch delete` each presuppose one of those, so for them the offer would create a root topology commit and then report that there is nothing to do. Those three exit non-zero with a message naming `oms sync <alias>`.
- **Decide selection by candidate count, not by stdin.** Zero candidates is a no-op exit 0; exactly one auto-selects with the existing explanatory message; two or more prompt in a terminal and exit 1 in a non-interactive shell naming the missing selection. This applies to `commit`, `record`, `branch switch`, and `branch checkout`, aligning them with `branch list`.
  - `oms branch delete` is deliberately **excluded**. "Interactive branch delete input selection" already requires it to collect omitted inputs "without inferring or auto-selecting destructive targets", and to present the selector even when only one candidate exists. That is the policy's dangerous-action rule applied to an irreversible operation, so it stays as written and its selection behavior does not change.
- **Batch the sync offer.** Preparation is hoisted out of the per-repo loop in `runManage` (`manage-ops.ts:110`), so `oms pull --all` with three unregistered aliases asks once and produces one topology commit rather than three prompts and three commits.
- **Default the batch prompt by how the selection was made.** An explicitly named alias — including the sole candidate auto-selected under the rule above, where no ambiguity existed — defaults to `sync and continue`. A `--all` or multi-select selection defaults to skipping, because the user named nothing and a reflexive Enter would otherwise clone several repositories and commit topology.
- **Attach a detached submodule HEAD when it is free.** When a local branch points at exactly the current HEAD commit, OMS switches to it — the working tree does not move, only the label. When none does, an interactive user chooses between creating a branch at HEAD and moving to the baseline branch, and a non-interactive shell exits non-zero naming `oms branch switch`. This replaces the flat detached-HEAD refusals in `commit.ts:78`, `manage-ops.ts:34`, and `:63`, and generalizes the anchored-HEAD allowance already in `branch-delete.ts:143`.
- Add `"skipped"` to `OperationResult`. `exitFromResults` (`operation-results.ts:24`) only tests for `"failed"`, so a user-chosen skip currently cannot be reported without forcing exit 2. Following the precedent set for `record`, a skip the user chose does not affect the exit code, while an alias that could not be prepared non-interactively is `"failed"` and exits 2.
- Rewrite the help text for all eight commands so the preparation behavior each one performs is documented where the user reads it.

## Capabilities

### New Capabilities

None. Preparation behavior that exists on `oms branch list` becomes shared; no new command or capability is introduced.

### Modified Capabilities

- `cli-automation-policy`: one requirement modified, one added.
  - **MODIFIED** "Automation-first command completion" — the grandfathering sentence is removed; the three scenarios are unchanged.
  - **ADDED** "Bounded automatic preparation" — where automatic preparation stops, and the discriminator that decides whether a topology-creating preparation is offered or refused.
- `ai-submodule-workflow`: three requirements modified, one added.
  - **MODIFIED** "Current submodule alias resolution" — the auto-select, no-op, and omission scenarios stop being conditioned on an interactive terminal and become conditioned on the candidate count.
  - **MODIFIED** "Submodule-only commits" — the detached-HEAD scenario becomes the attach-or-choose behavior, and the uninitialized and unregistered cases are split.
  - **MODIFIED** "Pull and push keep root pointer updates explicit" — its two detached-HEAD refusal scenarios become attach-or-choose scenarios, and preparation scenarios are added. Every pointer and topology scenario is restated unchanged from the form `change-topology-commit-default` leaves them in.
  - **ADDED** "Shared alias preparation across commands" — the registration classification, the per-command preparation matrix, batching, prompt defaults, and detached-HEAD attachment.
  - "Submodule branch inventory" is **not** modified. Its preparation scenarios (`spec.md:245-293`) describe the behavior being extracted, and the extraction preserves them exactly.
  - "Interactive branch delete input selection" is **not** modified. It requires the selector even for a sole candidate and forbids auto-selecting destructive targets, which this change honors by leaving `oms branch delete`'s selection untouched.
  - The `oms branch` group requirement (`spec.md:729-776`) is **not** modified. It governs subcommand routing and the 0.14.0 rename, and carries no selection or preparation clause for `switch` and `checkout`. Its two "behaves exactly as the former top-level command" scenarios describe explicit `<alias> <branch>` invocations, which this change leaves unchanged; only the uninitialized and unregistered paths gain preparation.

## Impact

- **Code**: new `scripts/lib/alias-preparation.ts`; `scripts/lib/branch-list.ts` and `scripts/lib/branch-delete.ts` lose their local copies; `scripts/lib/commit.ts`, `scripts/lib/manage-ops.ts` (preparation hoisted out of the loop), `scripts/lib/branch-ops.ts`, `scripts/lib/prompts.ts` (`resolveInitializedAlias`, `resolveCommandAlias`, `resolveRecordAliases` — the gate moves after the candidate count), `scripts/lib/types.ts` (`OperationResult` gains `"skipped"`), `scripts/lib/operation-results.ts`, `scripts/lib/help.ts`.
- **Specs**: `openspec/specs/cli-automation-policy/spec.md` is amended by this change, not merely satisfied by it.
- **Docs**: `README.md` command reference rows for all eight commands, plus the preparation matrix.
- **Tests**: `tests/cli-commit.contracts.js:233` changes — `workspaceWithApi()` builds a clean submodule, so the non-interactive `oms commit` with zero dirty candidates moves from exit 1 with `/not a TTY/` to exit 0 with `Nothing to commit in any submodule.`, matching what `oms commit api` on that same submodule already does. Two non-TTY tests stay as written: `tests/cli-sync.contracts.js:650`, where two declared repos with nothing named is genuinely ambiguous, and `tests/cli-branch.contracts.js:352`, which covers `oms branch delete` — excluded from auto-selection above, so its non-TTY failure is unchanged. New coverage is needed for each cell of the preparation matrix, the batch prompt and its two defaults, and the three detached-HEAD paths.
- **Users**: several invocations that previously failed now succeed. `oms commit` in a pipe with one dirty submodule commits it; `oms pull api` on an uninitialized alias initializes and pulls; `oms branch switch api feat/x` on an unregistered alias offers to sync. Three commands keep failing on an unregistered alias, with a clearer reason. Minor bump; no migration document, since nothing that previously succeeded changes its result.
- **Sequencing**: this change depends on `change-topology-commit-default`. Without it, every new prepare-sync path inherits the topology-commit prompt, so accepting `sync and continue` would ask a second question immediately afterwards.
