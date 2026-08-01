## 1. Shared predicate

- [x] 1.1 In `scripts/lib/prompt-adapter.ts`, export `canPrompt(): boolean` returning `Boolean(process.stdin.isTTY) || promptQueueActive()`, placed beside `promptQueueActive` so the queue dependency stays inside the seam module.
- [x] 1.2 Delete the local copy in `scripts/lib/prompts.ts:12` and import the shared one.
- [x] 1.3 Delete `interactive()` in `scripts/lib/branch-delete.ts:28` and import the shared one.
- [x] 1.4 Delete `interactive()` in `scripts/lib/branch-list.ts:31` and import the shared one.
- [x] 1.5 Grep for any remaining `process.stdin.isTTY` and confirm only the two documented exemptions survive: `prompts.ts` `resolveRemotes` and `update.ts` `runUpdate`. `topology-commit.ts` should have none after `change-topology-commit-default`, and the alias resolvers none after `unify-alias-preparation`.
- [x] 1.6 Run `npm run build` and `npm test`; this group is pure substitution and must be green with no test edits.

## 2. Text entries in the seam

- [x] 2.1 Add `{ type: "text"; value: string }` to `ResponseEntry` (`prompt-adapter.ts:30`) and `"text"` to `PromptType` (`:28`).
- [x] 2.2 Validate it in `validateEntry` (`:43`): `value` must be a string, and anything else throws `PromptQueueError`. Do **not** reject an empty string — `pickBranch`'s empty-name rejection at `prompts.ts:143` is behavior worth testing.
- [x] 2.3 Add `guardedText()` following the shape of `guardedSelect` (`:142`): consume a `text` entry, return `PROMPT_CANCEL` on an injected cancel, otherwise defer to clack's `text`.
- [x] 2.4 Add a test that a `text` entry whose `value` is not a string fails closed with exit 1 and no real prompt.

## 3. Migrate the two remaining gates

Move each gate and its prompts in the same step. A migrated predicate with an unguarded prompt lets a queue-active run open a real clack prompt that never settles.

- [x] 3.1 `pickBranch` (`prompts.ts:113`): switch the gate at `:118` to `canPrompt()`, the `select` at `:130` to `guardedSelect`, and the `text` at `:136` to `guardedText`. Keep the `CREATE_NEW_BRANCH` sentinel, the trim, and the empty-name rejection exactly as they are.
- [x] 3.2 `resolveAgentTarget` (`agent.ts:95`): switch the gate to `canPrompt()` and the `select` at `:99` to `guardedSelect`. The non-interactive `--target is required` error is already policy-correct and its message does not change.
- [x] 3.3 Confirm `agent.ts` uses the adapter's `isCancel`, not clack's, so an injected cancel is not read as a real selection — the same file-wide import correction `prompts.ts` already carries.
- [x] 3.4 `resolveDetachedHead` (`alias-preparation.ts:296`): its create-a-branch path still called clack's `text` directly behind the migrated gate, a migration `unify-alias-preparation` deferred here by comment. Switch it to `guardedText` and delete that deferral comment, so no prompt behind `canPrompt()` is left unguarded.
- [x] 3.5 Add tests for paths that were previously unreachable: `oms branch switch api` driven through the queue to create a new branch; the same flow with an empty name, asserting the rejection; `oms agent install` and `oms agent uninstall` target selection through the queue; the detached-HEAD create-a-branch path; an injected cancel at each new prompt.

## 4. Bounded fetch recovery

- [x] 4.1 In `fetchRepo` (`manage-ops.ts:14-21`), retry a failed fetch once per remote inside the existing loop, copying `branch-list.ts:217`: same arguments, no backoff, no reporting of a recovered first failure.
- [x] 4.2 Leave `pullRepo` (`:26`) and `pushRepo` (`:55`) without retries. A failed `--ff-only` pull usually means diverged history, and re-pushing after a rejection can mask a real non-fast-forward.
- [x] 4.3 Add a test where the first fetch fails and the second succeeds — for example through a temporary remote URL swap or a PATH git stub — asserting exit 0 with no error output.
- [x] 4.4 Add a test that two failures still report the failure with the Git exit code, still contribute a failed result to the run's exit code, and still let later aliases run.

## 5. Documentation and release

- [x] 5.1 Record the two exemptions in `design.md` with their reasons — `resolveRemotes` is a default settled by `add-all-flag-push-record` decision 8, and `runUpdate` guards a self-mutating action — so neither is re-opened later as an oversight.
- [x] 5.2 If the seam's queue format is documented anywhere user-facing, add the `text` entry type there.
- [x] 5.3 Add the changeset. The only observable change is the fetch retry; size it accordingly.
- [x] 5.4 Run `npm run build`, `npm test`, and `openspec validate unify-prompt-seam --strict`.
