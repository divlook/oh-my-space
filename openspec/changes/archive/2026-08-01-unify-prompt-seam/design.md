## Context

### Seam adoption, after the two preceding changes

| Site | Predicate | Prompt | Kind | Action |
| --- | --- | --- | --- | --- |
| `prompts.ts:12` | `canPrompt()` | — | duplicate helper | delete, import shared |
| `branch-delete.ts:28` | `interactive()` | — | duplicate helper | delete, import shared |
| `branch-list.ts:31` | `interactive()` | — | duplicate helper | delete, import shared |
| `prompts.ts:118` `pickBranch` | raw `isTTY` | raw `select` + `text` | decision gate | migrate |
| `agent.ts:95` `resolveAgentTarget` | raw `isTTY` | raw `select` | decision gate | migrate |
| `alias-preparation.ts:296` `resolveDetachedHead` | shared predicate already | raw `text` | decision gate | migrate |
| `prompts.ts:182` `resolveRemotes` | raw `isTTY` | raw `select` + `multiselect` | **default** | leave |
| `update.ts:213` `runUpdate` | raw `isTTY` | `confirmUpdate` | **safety gate** | leave |

`topology-commit.ts:90` is absent from this table because `change-topology-commit-default` deletes it. `prompts.ts:86` and `:306` are absent because `unify-alias-preparation` rewrites those resolvers. This is why the seam work sequences last: migrating them earlier would be work thrown away.

`alias-preparation.ts:296` is the one row that arrived rather than disappeared: `unify-alias-preparation` wrote that prompt behind the shared predicate and left it on clack's raw `text`, deferring the migration here by comment because the seam had no `text` entry to move it onto yet. Its predicate needs nothing; only the prompt does.

### Why the two exemptions are not oversights

`resolveRemotes` reaches its `isTTY` check only after two earlier returns (`prompts.ts:164`, `:181`): an explicit `--remote` list wins, and a repo declaring exactly one remote needs no decision. What remains is a repo with several declared remotes and no explicit choice, where the code returns `["origin"]` non-interactively. That is `cli-automation-policy`'s "only one safe routine choice exists, select it automatically" — a default, not a refusal to decide.

Adding `|| promptQueueActive()` would convert it into a prompt for every test with an active queue, once per repo. `add-all-flag-push-record` decision 8 examined and rejected exactly this. The conclusion has not changed.

`runUpdate` gates a command that rewrites the OMS installation itself. `cli-automation-policy` requires that an action which could cross the command's documented scope not be performed silently, and requiring `--yes` is that guard. Its exit 0 is also right: `oms update` in CI reports what it would run and takes no action, which is not a failure.

### What the `text` gap costs today

`pickBranch`'s create-a-branch path is three prompts deep — `select` reaches `CREATE_NEW_BRANCH`, then `text` collects the name, then `:143` rejects an empty one. With no `text` entry in the seam, the whole path is unreachable from tests, including that rejection.

### Existing conventions this change follows

- `guardedSelect`/`guardedMultiselect`/`guardedConfirm` (`prompt-adapter.ts:142-172`) share one shape: consume, return `PROMPT_CANCEL` on an injected cancel, otherwise defer to clack. `guardedText` follows it exactly.
- `validateEntry` (`:43`) throws `PromptQueueError` on a bad shape, and `consume` (`:109`) throws on type mismatch or exhaustion. Both stay the fail-closed path.
- `branch-list.ts:217` is the bounded-retry precedent: `let fetch = runSub(...); if (!fetch.success) fetch = runSub(...)` — one retry, same arguments, no backoff.

## Goals / Non-Goals

**Goals:**

- One definition of "can a prompt be completed here".
- Every decision gate honors the test queue, so no interactive path is unreachable from tests.
- `oms fetch` performs the bounded recovery the policy already requires of it.
- Both exemptions documented as decisions rather than left looking like misses.

**Non-Goals:**

- Changing `resolveRemotes`'s origin default or `runUpdate`'s `--yes` requirement.
- Retrying `oms pull` or `oms push`. A failed `git pull --ff-only` usually means diverged history, which a retry does not fix, and re-pushing after a rejected push can mask a real non-fast-forward.
- Adding backoff, jitter, or a configurable retry count. One retry, matching the existing precedent.
- Any behavior change beyond the fetch retry.

## Decisions

### 1. `canPrompt()` lives next to `promptQueueActive()`

It goes in `prompt-adapter.ts`, since it is a statement about whether the seam or a real TTY can answer, and the seam owns half of that. Putting it in `env.ts` beside `useColor` was considered and rejected: `env.ts` has no dependency on the queue, and adding one would invert the module direction.

### 2. `text` mirrors `select` exactly

```
{ "type": "text", "value": "feature/login" }
```

`value` must be a string; anything else throws `PromptQueueError`. An **empty string is a valid entry**, because the behavior worth testing is `pickBranch`'s rejection of an empty name at `prompts.ts:143`. Validation checks the type, not the content.

### 3. Migration is gate and prompt together

For each migrated site the predicate and the prompt move in the same step. Moving only the predicate would let a queue-active run open a real clack prompt that never settles — the exact unsettled-await failure `add-all-flag-push-record` fixed on the selection path.

`pickBranch` has two prompts, so both `guardedSelect` and `guardedText` are needed for it to work at all; migrating one alone leaves the path broken in a way tests would immediately hit.

### 4. Fetch retries once per remote, silently

`fetchRepo` (`manage-ops.ts:14-21`) loops over remotes and returns `"failed"` on the first failure. The retry goes inside that loop, per remote, copying `branch-list.ts:217`:

```
let r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true)
if (!r.success) r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true)
```

The first failure is not reported when the retry succeeds. Reporting a recovered transient failure trains users to ignore warnings, and the policy's bounded-recovery scenario asks OMS to complete the outcome, not to narrate the attempt. A failure that survives the retry reports exactly as it does today.

Unlike `branch list`, `oms fetch` has no cached-results fallback to degrade to — its whole purpose is the network call — so an exhausted failure stays a failure.
