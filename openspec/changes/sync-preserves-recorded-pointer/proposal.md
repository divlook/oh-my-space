## Why

`oms sync` can move a submodule off the commit the root repository recorded for it, silently, on a
path users hit routinely. README documents the opposite: sync "Reproduces the recorded pointer on a
fresh clone."

`attachBranch` (`submodule-config.ts:23-35`) attaches a detached submodule `HEAD` by switching to the
baseline branch when that branch already exists locally — without checking where its tip is. A
submodule clone creates that branch at the *remote tip*. Whenever someone pushed to a source repo
without running `oms record`, the remote tip is ahead of the recorded pointer, so the switch is not a
relabel: it moves the working tree forward and dirties the root gitlink.

Reproduced against `oms sync api` on a fresh clone whose recorded pointer is one commit behind
`origin/main`: exit 0, submodule `HEAD` moved from the pinned commit to the remote tip, root reports
`M oms/api`. Nothing warns, and the pointer the clone was supposed to reproduce is gone.

Two things make this worth fixing rather than documenting away:

- **It defeats the purpose of a recorded pointer.** The pointer exists so a clone reproduces a known
  good combination of submodule commits. A sync that silently advances one submodule hands the user a
  workspace that never existed, and the only evidence is a dirty gitlink they did not create.
- **The safe rule already exists in the codebase.** `unify-alias-preparation` established it for the
  eight preparing commands: attach only where doing so cannot move the checkout. `sync` is now the
  one caller of `attachBranch` that does not follow it, so the inconsistency is visible to anyone
  comparing `oms sync api` with `oms fetch api` on the same clone.

The spec already leans this way without covering the case. "Reconciliation preserves current working
branch" protects a submodule that is *attached* to another branch, and "Root-gitlink-anchored
detached HEAD is safe across retries" says OMS "does not attach or move HEAD" when detached `HEAD`
equals the recorded gitlink — but that scenario is scoped to `oms branch delete`. No requirement
covers sync attaching a *detached* `HEAD` to a baseline whose tip has moved.

## What Changes

- Give `attachBranch` the same safety rule the shared preparation path uses: attach when the baseline
  branch does not exist locally (create it at `HEAD`), or when it already points at exactly `HEAD`
  (a pure relabel). Do not switch to a baseline whose tip differs from `HEAD`.
- Decide and specify what sync reports when it declines to attach. A submodule left detached at the
  recorded pointer is the correct state, not a failure, so the likely answer is a note naming the
  divergence and `oms pull <alias>` or `oms branch switch <alias> <branch>` as the way forward — but
  this is the change's main open question, because sync's job is arguably to advance the checkout.
- Audit the four `attachBranch` call sites in `repo-ops.ts` (`:200` restored removal, `:265` fresh
  add, `:279` initialize registered, `:313` update existing) and state which are reachable with a
  drifted baseline. The fresh-add path cannot be, since it has no recorded pointer yet.
- Fix the README claim either way: if sync stops moving the pointer, "Reproduces the recorded
  pointer on a fresh clone" becomes true; if the decision goes the other way, that sentence must go.
- **Not in scope**: the eight preparing commands. `unify-alias-preparation` already fixed them, and
  this change should converge `sync` onto that rule, not revisit it.

## Capabilities

### New Capabilities

None. This corrects one existing behavior and specifies a case the current requirements leave open.

### Modified Capabilities

- `ai-submodule-workflow`: one requirement modified.
  - **MODIFIED** "Existing submodule metadata reconciliation" — extend the working-branch protection
    beyond the attached case. Sync attaches a detached submodule `HEAD` only where the attachment
    cannot change the checked-out commit, so it never moves an initialized submodule off the recorded
    root pointer, and it reports a baseline that has diverged instead of silently following it.

    The delta must restate every scenario name this requirement already carries, or `openspec
    archive` reads an omission as a deletion and aborts.

## Impact

- **Code**: `scripts/lib/submodule-config.ts` (`attachBranch` gains the tip check),
  `scripts/lib/repo-ops.ts` (the four call sites, plus whatever reporting the decision above
  requires). `scripts/lib/alias-preparation.ts` can then drop its own inline tip check and rely on
  `attachBranch`, removing the duplication that fix introduced.
- **Tests**: a sync against a clone whose recorded pointer is behind the baseline tip must leave
  `HEAD` at the pointer and the root clean. Existing sync tests build fixtures where the pointer
  equals the remote tip, so they exercise only the relabel path and none of them fail today — the new
  fixture is the whole regression gate.
- **Users**: behavior change on a path that currently succeeds. A `sync` that used to advance the
  submodule and dirty the gitlink now leaves it at the recorded commit. Users who relied on `sync` to
  pull their submodules forward will need `oms pull`. Minor, with the changeset naming the reversal
  explicitly; no migration, since no persisted state changes.
- **Docs**: README `oms sync` row, and the `oms sync` help text if it repeats the claim.
- **Sequencing**: after `unify-alias-preparation`, whose narrow fix established the rule this change
  generalizes and whose inline duplicate this change removes.
