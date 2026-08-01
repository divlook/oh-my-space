## 1. Amend the policy spec

Do this first: it is the authority the rest of the change appeals to.

- [x] 1.1 In the change's `specs/cli-automation-policy/spec.md` delta, MODIFY "Automation-first command completion" so the grandfathering sentence is gone and the requirement states it applies to every command, with its three scenarios restated unchanged. The main spec is not edited by hand — `openspec archive` applies this delta.
- [x] 1.2 In the same delta, ADD "Bounded automatic preparation": preparation without topology change is automatic, topology-creating preparation needs informed consent, non-interactive is a terminal error, one decision covers a whole selection, and partial registration is refused rather than repaired.
- [x] 1.3 Confirm the discriminator against all eight commands before committing the wording. A fresh registration is a clean clone at baseline (`repo-ops.ts:254`, `:263`), so `commit`, `push`, and `branch delete` must land on the refuse side and the other five on the offer side. Reject any phrasing that puts `push` on the offer side — `git push -u origin main` on a fresh clone exits 0 with `Everything up-to-date`, so "could produce its documented outcome" is not a valid discriminator. **Applied:** the requirement statement originally carried that invalid phrasing while only its scenarios used the presupposition test; the SHALL sentence now uses the presupposition test too.
- [x] 1.4 Run `openspec validate unify-alias-preparation --strict`, and preflight every MODIFIED block against the current main spec: OpenSpec aborts an archive whose MODIFIED block omits any scenario name the main spec already has, and matching is by name, so a renamed scenario reads as a deletion.

## 2. Extract the shared preparation module

Behavior-preserving for `branch list` throughout, except that it gains the shared detached-`HEAD`
attachment; its contract tests are the regression gate.

- [x] 2.1 Create `scripts/lib/alias-preparation.ts` and move `aliasRegistration` (`branch-list.ts:44`), `snapshotRegisters` (`:35`), `initializeRegisteredAlias` (`:71`), `syncAndContinue` (`:93`), and `prepareAlias` (`:104`) into it. **Applied:** all move unchanged except `initializeRegisteredAlias`, which now attaches the baseline after `git submodule update --init` so a just-initialized alias is not left detached. It attaches only where the checkout cannot move — the branch is absent, so `attachBranch` creates it at HEAD, or the branch is already at HEAD, so the switch is a pure relabel. A baseline branch ahead of the recorded pointer stays detached and falls to the detached-`HEAD` scenarios, because switching to it would move the submodule off the pointer and dirty the root gitlink.
- [x] 2.2 Give `prepareAlias` a capability parameter that says whether this command may offer topology-creating registration, replacing the hardcoded offer. Route `unregistered` to the offer or to the refusal message accordingly.
- [x] 2.3 Add `attachDetachedHead()`: when `currentBranch()` is null, find local branches whose tip equals HEAD via `inspectLocalBranches` (`git.ts`); switch to one silently when found; otherwise return a verdict the caller turns into an interactive choice or a non-interactive failure.
- [x] 2.4 Add a batch entry point that takes several repos, partitions them by classification, and asks at most one preparation question for the whole set.
- [x] 2.5 Rewrite `branch-list.ts` to import from the new module, deleting its local copies. Run `npm run test:blackbox -- tests/cli-branch-list.test.js` (or the matching layer command) and confirm zero behavior change.
- [x] 2.6 Replace `prepareRegisteredAlias` in `branch-delete.ts:68` with the shared classifier, which checks index and HEAD registration snapshots where the local version checked only `state.headOid !== null && state.gitmodulesEntry`. Configure `branch delete` with no topology offer. Run `npm run test:branch`.

## 3. Move the selection gate behind the candidate count

- [x] 3.1 In `scripts/lib/prompts.ts`, reorder `resolveCommandAlias` so the candidate list is built before the terminal check: zero candidates is the existing no-op message and exit 0, one candidate auto-selects with the existing `Selected "<alias>" (the only ...)` message, and only two or more consult `canPrompt()`. Delete the `!process.stdin.isTTY` check at `:306`.
- [x] 3.2 Apply the same reordering to `resolveRecordAliases` (`:364` before `:371`).
- [x] 3.3 In `resolveInitializedAlias` (`:62`), auto-select when exactly one candidate exists instead of always prompting, matching `branch-list.ts:165`.
- [x] 3.4 Leave `resolveDeleteAlias` (`branch-delete.ts:93`) selecting as it does today. "Interactive branch delete input selection" requires the selector even when only one candidate exists and forbids auto-selecting destructive targets, so `oms branch delete` is outside this reordering. Change only its preparation path (task 2.6), not its selection.
- [x] 3.5 Update the one contract test this changes: `tests/cli-commit.contracts.js:233` — `workspaceWithApi()` builds a clean submodule, so the non-interactive `oms commit` with zero dirty candidates now exits 0 with `Nothing to commit in any submodule.` instead of exit 1 with `/not a TTY/`.
- [x] 3.6 Confirm two non-TTY tests still pass unchanged: `tests/cli-sync.contracts.js:650`, where two declared repos with nothing named is genuinely ambiguous; and `tests/cli-branch.contracts.js:352`, which covers `oms branch delete` and is excluded by 3.4.
- [x] 3.7 Add tests covering all three candidate counts for `commit` and `record` in both a terminal and a pipe, asserting the terminal makes no difference at zero or one.

## 4. Route every command through preparation

- [x] 4.1 `oms commit` (`commit.ts:64`): replace the not-initialized error with `prepareAlias` configured without a topology offer, and replace the flat detached-HEAD error at `:78` with `attachDetachedHead`. Keep the in-progress-operation refusal at `:71` ahead of the detached-HEAD handling so a rebase still reports as a rebase.
- [x] 4.2 `oms branch switch` and `oms branch checkout` (`branch-ops.ts`, via `resolveInitializedAlias`): replace the `not synced` error at `prompts.ts:75` with `prepareAlias` configured **with** a topology offer.
- [x] 4.3 `runManage` (`manage-ops.ts:85`): hoist preparation out of the per-repo loop at `:110`. Add a batch phase before the loop that classifies every selected repo, asks at most one preparation question, and delegates one `runSync` for the accepted set. Configure `fetch` and `pull` with a topology offer and `push` without.
- [x] 4.4 Delete the three `not synced` errors at `manage-ops.ts:11`, `:28`, `:57` and the two detached-HEAD errors at `:34`, `:63`, replacing them with the shared preparation and `attachDetachedHead` results.
- [x] 4.5 Implement the prompt default rule: an explicitly named alias and a sole auto-selected candidate default to `sync and continue`; `--all` and multi-select default to `skip them`.
- [x] 4.6 Add `"skipped"` to `OperationResult` in `scripts/lib/types.ts`, count it in `printSummary` (`operation-results.ts:4`), and leave `exitFromResults` (`:24`) testing only for `"failed"` so a user-chosen skip exits 0 while a non-interactive preparation failure exits 2.
- [x] 4.7 Confirm `fetch` actually reaches the batch preparation added in 4.3. `fetchRepo` (`manage-ops.ts:9`) is the only branch of `runManage` with no branch or HEAD logic today, so a hoist written around the `pullRepo`/`pushRepo` shape can leave `fetch` bypassing preparation silently. Assert it explicitly with an uninitialized alias and with an unregistered one.
- [x] 4.8 Hand-verify the load-bearing matrix cells in a scratch workspace; group 5 covers the rest automatically. The cells worth driving by hand are: `commit`, `push`, and `branch delete` against an unregistered alias (the three refusals); the three detached-HEAD paths; and `oms pull --all` with several unregistered aliases (the batch prompt and its skip default).

## 5. Tests

- [x] 5.1 Auto-initialization: each of the eight commands initializes a registered-uninitialized alias and proceeds, creating no root commit and leaving the root index unchanged.
- [x] 5.2 The offer side: `fetch`, `pull`, `branch list`, `branch switch`, `branch checkout` each offer `sync and continue` for an unregistered alias via the prompt queue, complete the command, and produce exactly one root topology commit.
- [x] 5.3 The refusal side: `commit`, `push`, `branch delete` each exit non-zero for an unregistered alias, name `oms sync <alias>`, and leave root HEAD and the root index untouched.
- [x] 5.4 Batching: `oms pull --all` with three unregistered aliases asks once, and accepting produces one topology commit rather than three.
- [x] 5.5 Prompt defaults: the named-alias and sole-candidate cases default to sync; the `--all` case defaults to skip; choosing skip reports the skipped aliases, processes the rest, and exits 0.
- [x] 5.6 Detached HEAD: attaches silently when a branch points at HEAD with the working tree unchanged; offers a choice interactively when none does; exits non-zero naming `oms branch switch` in a pipe.
- [x] 5.7 Partial registration is still refused by every preparing command with sync repair guidance.
- [x] 5.8 `oms status`, `oms doctor`, and `oms record` perform no preparation — verify against a registered-uninitialized alias that the working tree is untouched and `status --json` still emits one JSON object on stdout.
- [x] 5.9 Run `npm test` and confirm the suite is green.

## 6. Documentation

- [x] 6.1 Rewrite the help text for all eight commands in `scripts/lib/help.ts` and the command descriptions in `scripts/oms.ts` so each states what it prepares. For `fetch` and `pull`, state that an accepted registration creates a root topology commit. For `commit`, keep the existing "never the root gitlink" promise — the refusal side of the matrix is what preserves it.
- [x] 6.2 Add the preparation matrix to `README.md` and update the command reference rows for all eight commands.
- [x] 6.3 Note in `design.md` that the bare `oms branch` selector offers a sync for `list` and refuses one for `delete`, and that this follows from the matrix rather than from per-command drift.
- [x] 6.4 Add the changeset as `minor`, listing the invocations that previously failed and now succeed. No migration document: nothing that previously succeeded changes its result.
- [x] 6.5 Run `npm run build`, `npm test`, and `openspec validate unify-alias-preparation --strict`.
