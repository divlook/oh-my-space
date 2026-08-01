## Context

### Current finalization decision

`finalizeTopology` (`scripts/lib/topology-commit.ts:51`) collects pending topology and metadata aliases, then decides whether to commit at `:88-98`:

```
let createCommit = commit
if (!commit && process.stdin.isTTY && allSucceeded && partial.length === 0) {
  const confirmed = await confirmTopologyCommit(message)
  ...
}
```

The resulting matrix:

| Invocation | stdin | Outcome | Exit |
| --- | --- | --- | --- |
| `oms sync api --commit` | any | topology commit | 0 |
| `oms sync api` | TTY | prompt, defaults Yes → commit | 0 |
| `oms sync api` | not a TTY | **no prompt, unstaged** | 0 |

The third row is the defect. It is not a documented fallback chosen for the non-interactive case; it is the absence of a decision. `confirmTopologyCommit` uses `select` imported directly from `@clack/prompts` (`topology-commit.ts:1`), not the guarded seam, so `promptQueueActive()` cannot reach it either — the prompt is unreachable from tests as well as from pipes.

### Why the delegated-sync path fails on re-run

`branch-list.ts:93` delegates preparation:

```
async function syncAndContinue(repo: Repo): Promise<number> {
  ...
  return await runSync([repo.alias], {})     // no commit option
}
```

`runSync` reaches `finalizeTopology` with `commit === false`. In the contract test the queue has already been consumed by the `sync`/`cancel` selector, and stdin is not a TTY under `spawnSync`, so no prompt opens and the topology is unstaged.

`aliasRegistration` (`branch-list.ts:44`) then classifies the alias by comparing three registration snapshots — `HEAD:.gitmodules`, `:0:.gitmodules`, and the working tree — plus three gitlink presence checks. After an uncommitted `submodule add`, the working tree and index register the alias but `HEAD` does not. That is neither "all present" nor "all absent", so it returns `partially registered`, and `prepareAlias` (`:108`) exits 1:

```
api: root gitlink and .gitmodules registration are inconsistent or pending
addition/removal. Repository state was preserved. Repair it with "oms sync api", then retry.
```

`tests/cli-branch-list.contracts.js:230` pins this sequence:

```js
const accepted = run(["branch", "list", "api"], { env: queueEnv([{ type: "select", value: "sync" }]) })
assert.equal(accepted.status, 0)
const pendingAdd = run(["branch", "list", "api"], { cwd: acceptedCwd })
assert.equal(pendingAdd.status, 1)
assert.match(pendingAdd.stdout + pendingAdd.stderr, /inconsistent|pending/)
```

Committing the delegated topology moves the alias to `initialized`, so the second invocation succeeds.

### Commander's tri-state, measured

Declaring `--commit` and `--no-commit` on the same command is accepted; the parsed value is tri-state, not boolean-with-default:

| Argument | `opts()` |
| --- | --- |
| *(neither)* | `{}` — `commit` is `undefined` |
| `--commit` | `{ commit: true }` |
| `--no-commit` | `{ commit: false }` |

`undefined` is falsy, so `if (!commit)` treats "flag omitted" identically to `--no-commit`. Any default expressed only in the option declaration is therefore invisible to programmatic callers, which construct their options object directly.

### Existing conventions this change follows

- `topologyCommitMessage()` (`topology-commit.ts:15`) names one alias and omits names in the plural form.
- Path-limited finalization runs through `finalizeRootCommit` in `root-tx.ts`, which owns the temporary index, the fsynced intent marker, and the atomic index replacement. This change does not touch that transaction.
- Documented exit codes (`help.ts:1`): `0 ok | 1 usage/config error | 2 one or more git operations failed`.

## Goals / Non-Goals

**Goals:**

- Make the topology commit outcome depend on repository state and explicit flags only, never on whether stdin is a TTY.
- Let `oms sync` and `oms unsync` finish their work in one invocation.
- Fix the `oms branch list` re-run failure that the current default produces.
- Keep every existing safety refusal and the root commit transaction byte-identical.
- Keep every currently valid invocation that passed `--commit` working unchanged.

**Non-Goals:**

- Changing `oms record`. Pointer records are a separate workflow with their own explicit-by-design contract.
- Changing which aliases are eligible for a topology commit, or the commit messages.
- Extending preparation to other commands, sharing `prepareAlias`, or amending `cli-automation-policy`. Those belong to `unify-alias-preparation`, which sequences after this change specifically so it inherits a single-prompt preparation flow.
- Removing `--commit`.
- Adding a config-file setting to restore the old default.

## Decisions

### 1. The default lives in `finalizeTopology`, not in the flag declaration

`finalizeTopology` resolves `const createCommit = commit ?? true` and the `commit` parameter becomes `boolean | undefined`.

The alternative — `.option("--no-commit", ...)` alone, letting commander default `commit` to `true` — fails for programmatic callers. `branch-list.ts:97` passes `{}`, and `unify-alias-preparation` adds four more prepare-sync call sites. Every one of them would receive `undefined` and silently take the unstaged path, which is precisely the behavior being removed. Resolving in the function makes the default hold for every caller regardless of entry point.

`--commit` remains declared so the flag keeps parsing; it sets `commit: true`, which `?? true` already produces.

### 2. The prompt is removed rather than inverted

`confirmTopologyCommit` and its `select` import are deleted. `cli-automation-policy` states that when exactly one safe routine action can continue the workflow, OMS selects it and does not prompt merely for confirmation. The prompt already defaulted to Yes, so the question was never resolving genuine ambiguity — it was a confirmation step.

Keeping the prompt for the interactive case and defaulting to commit non-interactively was rejected: it reintroduces a TTY-dependent difference in what the user is asked, and it leaves the double prompt that `unify-alias-preparation` would otherwise inherit on every prepare-sync path.

### 3. Safety branches keep their current answers

The `commit ?? true` resolution changes the default answer only. Every guard that follows continues to run against the resolved value, in the same order:

| Condition | Behavior | Change |
| --- | --- | --- |
| Partial removal topology | error, unstage, exit 2 | none |
| `remove` with unrelated staged paths | error, unstage, exit 2 | none |
| `remove` with a failed alias | skip commit, unstage, exit 0 | none |
| `add` with a failed alias | commit successful aliases via temp index | none |
| `oms.yaml` differs from HEAD | disclosure message | none |
| `finalizeRootCommit` fails | preserve state, name the retry | none |

The `allSucceeded && partial.length === 0` condition that previously gated the prompt disappears with the prompt. It was a precondition for *asking*, not a safety rule; the corresponding safety rules are the rows above and they are evaluated after the resolution, exactly as today.

### 4. `--commit` stays as an accepted no-op

Removing it would break 43 test references and the `oms sync api --commit` / `oms unsync api --commit` examples in `help.ts` and `README.md`, for no behavioral gain. It stays declared and documented as retained for compatibility.

The main spec's several `Run "oms sync api --commit"` recovery hints stay accurate: the flag still creates the topology commit for pending state.

The hints inside the two requirements this change already restates are updated to `oms sync api`, since advising a retained no-op flag reads oddly. Four hints in requirements this change does **not** touch — `spec.md:612` and `:622` in "Explicit root pointer records", `:666` and `:682` in "Multi-alias root pointer records" — keep their `--commit` wording. Restating two large pointer-record requirements to change four strings is not worth the review surface, and the advice they give still works. `unify-alias-preparation` picks up the equivalent hints in "Submodule-only commits", which it restates for other reasons. Any hint still naming `--commit` after all three changes land is cosmetic, and a later pass can normalize it.

### 5. Test call sites are triaged, not bulk-edited

The suite invokes `sync` without `--commit` 89 times and `unsync` 26 times. Most only need a synced submodule and are indifferent to the root commit. Three categories actually depend on the old default and are handled explicitly:

1. **Fixtures that build pending topology** — `cli-commit.contracts.js:1196`, `cli-sync.contracts.js:620`, `:730`, `:1063`. These need `--no-commit` to keep producing the state under test.
2. **Help-text assertions** — `cli-sync.contracts.js:1190`, `:1195` match `/left unstaged by default/`. Retargeted to the new wording.
3. **The `branch list` re-run assertions** — `cli-branch-list.contracts.js:241-243`. Inverted, because the behavior they pin is the defect being fixed.

Anything else that fails is a genuine dependency on the old default and gets the same triage.
