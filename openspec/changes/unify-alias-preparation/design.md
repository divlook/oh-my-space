## Context

### The reference implementation

`branch-list.ts` already contains the whole preparation contract:

| Piece | Location | Role |
| --- | --- | --- |
| `aliasRegistration()` | `:44` | classifies into `initialized`, `registered-uninitialized`, `partially registered`, `unregistered` |
| `initializeRegisteredAlias()` | `:71` | `git submodule update --init` with the manifest URL overridden for this invocation only |
| `syncAndContinue()` | `:93` | delegates to `runSync` with git diagnostics redacted |
| `prepareAlias()` | `:104` | routes the four classifications |
| `resolveAlias()` | `:151` | sole alias auto-selects, then prepares |

`aliasRegistration` is the load-bearing part. It compares three registration snapshots — `HEAD:.gitmodules`, `:0:.gitmodules`, and the working tree — against three gitlink presence checks, and only reports `initialized` or `registered-uninitialized` when all six agree. Anything in between is `partially registered`, which is refused rather than repaired. This is what makes automatic initialization safe to run unattended, and it is why extraction is the right move rather than reimplementation.

### What a fresh registration contains

`syncRepo` (`repo-ops.ts:205`) handles the unregistered case in a fixed way:

- `:222` — if `oms/<alias>/` exists and is a file or a non-empty directory, sync **fails**; it never syncs over user content
- `:254` — otherwise `git submodule add [-b <baseline>] <origin> <path>`
- `:263` — `attachBranch` to the baseline

So a newly registered alias is a clean clone attached to baseline. It has no uncommitted changes, no commits absent from origin, and no local branch other than baseline (which is checked out, and therefore not deletable).

This is the discriminator the preparation matrix is built on:

| Command | Presupposes | After a fresh registration | Preparation |
| --- | --- | --- | --- |
| `commit` | uncommitted changes | none exist | error |
| `push` | commits absent from origin | none exist | error |
| `branch delete` | a deletable local branch | only baseline, checked out | error |
| `fetch` | nothing local | request satisfied | offer |
| `pull` | nothing local | request satisfied | offer |
| `branch list` | nothing local | request satisfied | offer |
| `branch switch` | nothing local (creates if absent) | request satisfied | offer |
| `branch checkout` | nothing local (from `origin/*`) | request satisfied | offer |

An earlier formulation of this rule — "offer when the preparation could satisfy the command's documented outcome" — was rejected because it does not separate `push` from `pull`. `git push -u origin main` on a fresh clone reports `Everything up-to-date` and exits 0, so `push` trivially satisfies its documented outcome while accomplishing nothing the user asked for. Phrasing the rule in terms of *presupposed local state* separates the eight commands correctly.

### The selection gate, measured against the spec

`cli-automation-policy` distinguishes three cases. Mapping the current code onto them:

| Candidates | Policy | `branch list` | `resolveCommandAlias` | `resolveInitializedAlias` |
| --- | --- | --- | --- | --- |
| 0 | no decision | error, exit 1 | TTY: exit 0 / pipe: exit 1 | error, exit 1 |
| 1 | select automatically | auto-selects | TTY: auto / pipe: exit 1 | **always prompts** |
| 2+ | present choices | prompt or exit 1 | prompt or exit 1 | prompt or exit 1 |

Only the last row is consistent today. The first two rows need human intent in none of the implementations, so the TTY gate has no business running before the count.

`oms branch delete` is the one command that must stay outside this rule. "Interactive branch delete input selection" already states that it collects omitted inputs "without inferring or auto-selecting destructive targets", presents the alias selector "even when only one initialized alias is available", and presents the branch selector even when exactly one deletable branch exists. That is the policy's dangerous-action rule applied to an irreversible operation — a deliberate exception, not drift — so its selection behavior is untouched and only its preparation path moves onto the shared module.

### Existing conventions this change follows

- The interactive predicate `Boolean(process.stdin.isTTY) || promptQueueActive()` is duplicated at `prompts.ts:12`, `branch-delete.ts:28`, and `branch-list.ts:31`. This change keeps using it; `unify-prompt-seam` collapses the copies.
- `manage-ops.ts` reports a per-alias problem with `log.error`, continues the loop, and lets `exitFromResults()` produce exit 2.
- The benign-skip versus problem-skip split, and its exit-code consequence, follow the `record` precedent established in `add-all-flag-push-record`.
- Documented exit codes (`help.ts:1`): `0 ok | 1 usage/config error | 2 one or more git operations failed`.

## Goals / Non-Goals

**Goals:**

- One preparation implementation, used by every command that operates inside a submodule.
- Automatic completion of every preparation step that does not touch root topology.
- Selection decided by repository state, never by whether stdin is a terminal.
- A written rule that tells the next command which side of the matrix it is on.
- No behavior change for `oms branch list`, whose contract this extracts.

**Non-Goals:**

- Auto-syncing an unregistered alias without consent. `cli-automation-policy` names choosing repository topology as a case that must not happen silently, and the offer is the consent point.
- Preparation in `oms status`, `oms doctor`, or `oms record`. The first two are diagnostics and must report state rather than change it, and `status --json` must stay a pure reporter; `record` acts on root pointers, and an unregistered alias has no pointer to record.
- Repairing `partially registered` state. It stays a refusal with sync guidance.
- Collapsing the duplicated interactive predicate, or adding bounded fetch recovery. Those are `unify-prompt-seam`.
- Changing the topology commit default — that is `change-topology-commit-default`, which must land first.

## Decisions

### 1. Extraction, not reimplementation

`aliasRegistration` and `prepareAlias` move to `scripts/lib/alias-preparation.ts` unchanged in behavior, and `branch-list.ts` imports them. `branch delete`'s narrower `prepareRegisteredAlias` (`branch-delete.ts:68`) is deleted in favor of the shared classifier, which is strictly more careful: it checks index and HEAD registration snapshots, where the local version checks only `state.headOid !== null && state.gitmodulesEntry`.

Writing a second implementation for the other six commands was rejected outright — a second copy of the six-way registration comparison is exactly the drift this change exists to remove.

### 2. The preparation matrix is data, not scattered conditionals

Each command declares its preparation capability once, and the shared module routes on it:

```
prepareAlias(repoRoot, repo, { topologyOffer: boolean, ... })

  initialized              → proceed
  registered-uninitialized → auto-init, proceed          (all commands)
  partially registered     → error, sync repair guidance (all commands)
  unregistered             → topologyOffer
                               ? offer sync and continue
                               : error naming oms sync <alias>
```

A per-command `if` chain was rejected: it puts the matrix in eight places and gives the new policy requirement nothing to point at.

### 3. Preparation is hoisted out of the per-repo loop

`runManage` currently prepares nothing and loops at `manage-ops.ts:110`, calling `resolveRemotes` inside the loop — which is why remote prompts can already fire once per repo. Preparation must not follow that pattern: three unregistered aliases under `--all` would produce three prompts and, after `change-topology-commit-default`, three separate topology commits.

The loop is therefore split into a batch preparation phase and the existing per-repo operation phase. Batch preparation collects the unregistered aliases, asks once, and delegates a single `runSync(aliases, {})` so the topology lands in one commit — matching what `oms sync api web docs` already produces.

### 4. Prompt default follows how the selection was made

| Selection | Default | Reason |
| --- | --- | --- |
| alias named on the command line | `sync and continue` | unambiguous intent |
| sole candidate auto-selected | `sync and continue` | there was no ambiguity to resolve |
| `--all` or multi-select | `skip them` | the user named nothing |

The sole-candidate row is the case that needs stating: it is neither user-typed nor bulk. It is treated as explicit because the auto-selection happened precisely because only one safe choice existed.

The reason the default matters at all is that `change-topology-commit-default` removes the topology-commit confirmation, making this prompt the only consent point before a root commit. Defaulting a `--all` sweep to `sync all` would let one reflexive Enter clone several repositories and commit topology.

### 5. Detached HEAD is attached only when the working tree does not move

```
detached at X
  ├── some local branch points at X   → git switch <branch>; worktree unchanged
  ├── none, interactive               → create a branch at X / move to baseline / cancel
  └── none, non-interactive           → exit non-zero naming oms branch switch
```

The distinction is that attaching to a branch already at `X` is a pure relabel, while `git switch main` when `main` is at `Y` moves the working tree from `X` to `Y` and can lose the user's position. Only the first is safe to do unattended.

Adopting `branch delete`'s anchored test (`branch-delete.ts:143`) for all commands was rejected: it permits proceeding while still detached, which for `commit` produces a commit on no branch, and for `pull` does not help at all since `git pull --ff-only <remote> <branch>` needs a branch.

### 6. `skipped` becomes a first-class result

`OperationResult` has no way to express "not attempted, by request" — `exitFromResults` (`operation-results.ts:24`) returns 2 if any result is `"failed"` and 0 otherwise. Adding `"skipped"`, counted by `printSummary` and ignored by `exitFromResults`, lets a user-chosen skip report honestly at exit 0 while a non-interactive preparation failure stays `"failed"` at exit 2. This mirrors the benign-versus-problem skip split `record` already makes.

### 7. Known inconsistency, stated deliberately

From the bare `oms branch` action selector, choosing `list` offers to sync an unregistered alias while choosing `delete` refuses it — two behaviors one keystroke apart. This follows from the matrix: after a fresh registration there is no branch to delete. It is recorded here so it reads as a consequence of the rule rather than as the per-command drift this change removes.
