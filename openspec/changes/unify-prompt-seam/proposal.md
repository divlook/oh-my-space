## Why

The fail-closed prompt seam in `prompt-adapter.ts` exists so interactive flows can be driven deterministically from tests "in place of TTY detection". Adoption is partial, and the gap is a test-coverage hole rather than a style problem.

**The interactive predicate is copied three times.** `prompts.ts:12`, `branch-delete.ts:28`, and `branch-list.ts:31` each define the same `Boolean(process.stdin.isTTY) || promptQueueActive()`. Three copies of one predicate is how the copies eventually stop agreeing.

**Some decision gates still test `process.stdin.isTTY` directly**, so they do not honor `promptQueueActive()` and the prompts behind them cannot be reached from tests at all. After `change-topology-commit-default` deletes the topology prompt and `unify-alias-preparation` reworks the alias resolvers, the remaining raw gates are `pickBranch` (`prompts.ts:118`) and `resolveAgentTarget` (`agent.ts:95`).

**The seam has no `text` entry type.** `ResponseEntry` covers `select`, `confirm`, and `multiselect`. `pickBranch` collects a new branch name with clack's `text` (`prompts.ts:136`), so even after its gate is fixed, the create-a-branch path stays undrivable. That path includes the empty-name rejection at `:143`, which is currently untested.

Separately, `oms fetch` performs no bounded recovery. `oms branch list` retries a failed fetch exactly once before falling back to cached refs (`branch-list.ts:217`), and `cli-automation-policy` requires that a workflow with a defined safe bounded retry perform it automatically. `manage-ops.ts:16` fetches once and reports failure.

Two raw `isTTY` sites are deliberately **not** gates and stay as they are:

- `resolveRemotes` (`prompts.ts:182`) — `if (!process.stdin.isTTY) return ["origin"]` is a default, not a decision gate. This was settled in `add-all-flag-push-record` decision 8: adding `|| promptQueueActive()` would make every `fetch`/`pull`/`push` test with an active queue prompt for remotes once per repo, forcing queue bookkeeping into tests that are not about remote selection.
- `runUpdate` (`update.ts:213`) — requiring `--yes` before OMS rewrites its own installation is a safety gate for a self-mutating action, and reporting the command to re-run at exit 0 is correct for a check that took no action.

## What Changes

- Export one `canPrompt()` from `scripts/lib/prompt-adapter.ts`, beside the `promptQueueActive()` it wraps, and delete the three local copies.
- Add `{ "type": "text", "value": "..." }` to `ResponseEntry`, validated fail-closed like the others, and add `guardedText()`.
- Move the two remaining decision gates onto `canPrompt()`, and their prompts onto the guarded functions: `pickBranch` (`select` plus `text`) and `resolveAgentTarget` (`select`).
- Leave `resolveRemotes` and `runUpdate` behaviorally unchanged, and record in `design.md` why each is exempt so the exemption is not re-litigated as an oversight.
- Retry a failed `oms fetch` exactly once per remote before reporting failure, matching `branch-list.ts:217`.
- Add coverage that the newly reachable paths actually work: the `branch switch` create-a-branch flow including its empty-name rejection, and `oms agent install` / `oms agent uninstall` target selection.

## Capabilities

### New Capabilities

None. This unifies an existing predicate, widens an existing test seam, and applies an existing recovery pattern to one more command.

### Modified Capabilities

- `ai-submodule-workflow`: one requirement modified, one added.
  - **MODIFIED** "Guarded deterministic prompt responses" — the accepted entry types gain `text`, and the requirement states that every command decides prompt availability through one shared predicate. The fail-closed guarantees are unchanged.
  - **ADDED** "Bounded fetch recovery for submodule set commands" — `oms fetch` retries a failed fetch once per remote before reporting failure.

## Impact

- **Code**: `scripts/lib/prompt-adapter.ts` (`canPrompt`, the `text` entry type, `guardedText`), `scripts/lib/prompts.ts` (local `canPrompt` deleted; `pickBranch` moved onto the seam), `scripts/lib/branch-delete.ts` and `scripts/lib/branch-list.ts` (local `interactive`/`canPrompt` deleted), `scripts/lib/agent.ts` (`resolveAgentTarget` moved onto the seam), `scripts/lib/manage-ops.ts` (`fetchRepo` retry).
- **Tests**: new coverage for the create-a-branch path and its empty-name rejection, for agent target selection through the queue, for a `text` entry that fails closed when malformed, and for a fetch that succeeds on its second attempt.
- **Users**: no observable change except that a transient first fetch failure in `oms fetch` now succeeds instead of reporting an error. Patch or minor as the changeset prefers; no migration.
- **Sequencing**: last of the three. `change-topology-commit-default` removes the topology prompt and `unify-alias-preparation` reworks the alias resolvers, so running this change earlier would migrate gates that those changes then delete or rewrite.
