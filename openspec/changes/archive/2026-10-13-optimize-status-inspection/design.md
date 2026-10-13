# Design

## Context

See `proposal.md` for motivation and scope. This design is required because performance and multiple internal callers are involved; it does not introduce new requirements.

- `status.ts:491-599` collects `gitlinkState` for each JSON repo and then recollects it for root pointer summaries. `gitlinkState` is shared with mutation workflows, so changing its global lifetime is unsafe.
- `tree-ops.ts:134-233` combines filesystem/porcelain discovery, classification, sorting, and dirty inspection. `status.ts:564-566,668-670` filters after that inspection. Doctor, duplicate creation checks, and unsync consume inventory presence/health, not dirty state.
- LSP references identify callers in status, doctor, repo-ops, and tree add/list/remove. Existing coverage includes `tests/integration/status-json.test.ts`, `tests/integration/tree-inventory.test.ts`, `tests/unit/tree-ops.test.ts`, and sync/tree/tools black-box owners.
- The earlier audit measured missing-alias `gitlinkState`, not complete initialized workspaces. Existing `dist/oms.js` preceded the latest source changes. Neither is an acceptance baseline for this implementation.
- Existing specs require complete namespace discovery, selected-alias status projection, dirty reporting, and unsync refusal for healthy/broken/foreign entries. Existing read-failure behavior has suspected defects; this optimization must not silently redefine errors or claim those defects are fixed.

## Goals / Non-Goals

**Goals:**
- Every implementation slice leaves a usable CLI and has its own before/after observable behavior and cost evidence.
- Keep collection lifetimes and dirty-inspection selection inside existing modules, behind a small interface.
- Eliminate requested-work-independent Git subprocesses without weakening discovery or fresh mutation checks.

**Non-Goals:**
- No atomic cross-repository snapshot guarantee, global cache, Git command batching, new CLI options, generic inspection framework, or module extraction.
- No rewriting of error classification, mutation/preparation logic, removal logic, test scheduling, or release versions.
- No permanent tests tied to exact subprocess counts, private helper names, forwarding, or output source text.

## Decisions

### 1. One JSON invocation owns its alias pointer observations

Inside `printStatusJson`, collect each selected alias's `GitlinkState` once and pass those observations to the private repo/root builders. Retain `gitlinkState` itself and every mutation caller's fresh-read behavior. Keep observations in selected order and never retain them after the invocation.

The shared observation covers pin and root pointer classification only. Branch, tracking, dirty counts, and root non-gitlink changes continue using existing collectors. Human-readable repo status is not redirected through the full JSON collector, which would add unnecessary reads.

Alternative rejected: a process-global memoized `gitlinkState` would need invalidation across initialization, prompts, external Git changes, and transactions. A new inspection module is unnecessary for this bounded cutover.

### 2. One explicit dirty selection at the existing tree seam

Keep `listManagedTrees` as the externally consumed deep module. Give it one explicit inspection argument, such as `{ dirtyAliases: "all" | readonly string[] }`, before the optional `RawGitRunner`. `"all"` requests current complete dirty inspection; an empty array requests discovery/classification only; a nonempty array requests dirty inspection only for those aliases. Convert selected aliases to a Set once inside the implementation.

Discovery still probes the complete union of declared and tree-referenced Git directories and filesystem entries, deduplicates gitdirs, classifies healthy/broken/foreign entries, and preserves sorting. Only the final healthy-tree `git status` loop is selected. Uninspected dirty state remains `null`, never `false`; it is internal and must not escape a caller that promises dirty output. Status filters emitted entries to the same requested aliases. Unfiltered status and tree list request `"all"`.

Migrate every caller and runner-injecting test in the same interface-changing slice, without compatibility overloads or deprecated wrappers. Initially all callers except doctor request `"all"`; later slices narrow their own selection. Tree remove continues requesting `"all"` and retains its current safeguards unchanged.

Alternative rejected: exposing discovery and enrichment phases to every caller would spread ordering knowledge and allow partially populated entries to escape. Independent booleans for discovery, health, and dirty would admit unnecessary combinations.

### 3. Five complete slices, not horizontal scaffolding

| Slice | Changed behavior/caller | Implementation scope | Exit proof |
|---|---|---|---|
| A | JSON status reuses pointer observations | Private status builders only | Stable JSON and selected pointer states; one pointer collection instead of two per alias; next invocation sees a changed pointer |
| B | Doctor avoids tree dirty inspection | Tree inspection argument and all callsite migrations; doctor selects discovery-only | Same broken/foreign/exclude diagnostics; zero healthy-tree status subprocesses from doctor's inventory; tree list/remove still inspect dirty state |
| C | Alias-filtered JSON and text status inspect only selected trees | Status passes its existing alias selection to tree inventory | Same selected output; no dirty inspection of unselected healthy trees; unfiltered status includes undeclared entries |
| D | Duplicate tree-add detection avoids dirty inspection | Only the duplicate guard's selection | Healthy/foreign/broken duplicates still refuse before preparation; no healthy-tree status subprocesses from that guard; normal add remains usable |
| E | Unsync tree-presence guard avoids dirty inspection | Only the unsync inventory selection | Healthy/broken/foreign entries still block, including force; no healthy-tree status subprocesses from that guard; removing entries allows existing unsync flow |

A is independent of B. C, D, and E depend on B but not on one another. Execute A through E serially so performance deltas remain attributable. A completed slice remains a useful optimization even if a later slice fails its gate. Do not continue with a failed gate or call the entire change complete until all five pass.

### 4. Each slice has a complete verification gate

Before source edits, run the current canonical `npm test` once and capture a production-bundle baseline. Do not rerun a known failure merely to confirm it; distinguish an unrelated pre-existing failure from a changed-path regression. Use Node 24 per the development guide.

For each slice, complete its caller/test migration, then run one type-checked production build, compile integration tests once, execute the affected existing test files, and run the newly built actual CLI against a disposable, local-only Git workspace. Use `npm run build`, `npm run test:compile`, and direct `node --test` commands listed in `tasks.md`. Use actual `dist/oms.js` for smoke; direct library tests are not sufficient. Run tests/builds after the slice's coherent edits, not between individual edits.

Permanent tests should cover a plausible consumer-visible omission, stale state, filter leak, wrong dirty state, or broken refusal. Reuse existing coverage where it already proves a case; prefer extending an existing real-Git journey over adding duplicate journeys. Count-only checks stay temporary diagnostics. If an existing incidental implementation/wording assertion must change, remove it instead of pinning the new implementation.

Do not demand a full suite after every small slice. Run `npm test` again once after all slice gates and their documentation/evidence updates. It must pass for completion; retain process-integrity and recovery coverage.

### 5. Use actual workspace evidence, not an absolute latency promise

Use the following fixed fixture rows before edits and recreate the same rows for after measurements. Alias counts are declared, initialized canonical checkouts; tree counts include healthy entries only. All remotes point to immutable local bare seeds. `api` is the selected alias; `web` is unselected where present. No-upstream means a local branch without tracking, not a missing remote.

| Fixture | Declared aliases and tracking | Healthy trees | Additional inventory | Commands and slice use |
|---|---|---|---|---|
| F1 | 1: tracked `api` | 0 | None | Unfiltered/filtered JSON status and doctor; A/B no-tree control |
| F2 | 10: tracked `api`, no-upstream `web`, eight tracked aliases | 0 | None | Unfiltered/filtered JSON status and doctor; A alias-scaling and B no-tree control |
| F3 | 1: tracked `api` | 1: dirty `api/task-1` | None | JSON/text status, doctor, tree list, duplicate add, dirty removal refusal, and blocked unsync; B/D/E single-tree control |
| F4 | 10: tracked `api`, no-upstream `web`, eight tracked aliases | 10: five `api` and five `web`; one dirty tree in each alias, others clean | One broken `api` entry, one nonempty foreign `web` directory, and one healthy tree for an undeclared `orphan` alias, additional to the 10 healthy declared-alias trees | JSON/text status (unfiltered and `api`-filtered), doctor, tree list, duplicate add, dirty removal refusal, and blocked unsync; A–E loaded case |

F4 retains the initialized `orphan` submodule registration/gitdir but omits its alias from the manifest. Its healthy tree must remain discoverable by the existing filesystem/porcelain union. The two-alias distribution and selected/unselected dirty pair apply only to F4; F1/F2 have no healthy trees and F3 has no unselected alias.

For A, use disposable F1/F2 variants with moved, staged, and split `api` pointers and verify a later invocation reads the new state. D/E use the explicit variants below; the fixture column identifies the canonical checkout/template shape, not a completed managed-tree directory to copy or merely trim. Build each variant's entries at the final destination from scratch. All D/E target aliases are `api`, including foreign entries; F4's default foreign `web` entry is not used as evidence for an `api` refusal.

| Variant | Canonical base | Exact inventory created | Actual command and expected result |
|---|---|---|---|
| D-H | F3 | Only healthy dirty `api/task-1` | `tree add api task-1` refuses the duplicate before preparation |
| D-B | F3 | Only broken `api/broken`: create it healthy, verify links, then remove its directory while retaining its worktree record | `tree add api broken` refuses the duplicate before preparation |
| D-F | F3 | Only nonempty foreign `api/stray`, created directly with a sentinel file and no worktree record | `tree add api stray` refuses the duplicate before preparation |
| D-N | F3 | Only healthy dirty `api/task-1`; `api/fresh-task` is absent and its branch does not exist | `tree add api fresh-task` succeeds without moving the canonical checkout |
| E-H | F3 | Only healthy dirty `api/task-1` | `unsync api` and `unsync api --force`, each on a separate fresh replica, refuse and preserve source/gitdir/tree |
| E-B | F3 | Only broken `api/broken`, built as in D-B; no healthy or foreign entries | `unsync api` and `unsync api --force`, each on a separate fresh replica, refuse on the broken entry |
| E-F | F3 | Only nonempty foreign `api/stray`, built as in D-F; no healthy or broken entries | `unsync api` and `unsync api --force`, each on a separate fresh replica, refuse on the foreign entry |
| E-N | F3 | Empty namespace and no remaining managed worktree records; independently verify the empty inventory | `unsync api` follows the existing successful topology flow |

Record the variant and expected entries in every sample. The named D/E rows isolate each guard outcome; also use F4's ordinary healthy `api` duplicate/blocked-unsync case for loaded-cost evidence, without presenting it as broken-only or foreign-only proof. Repeat timings three times only for read-only commands; mutation outcomes and their subprocess counts are measured once per fresh replica.

Create every replica at its final absolute path from a canonical-only template containing no managed trees or worktree administrative records. Copy only the canonical template, then create managed trees at the destination with local Git. Create an intended broken entry only after healthy-link checks, by removing that replica's tree directory while retaining its administrative record; create foreign entries directly in that replica. Never directory-copy a workspace after managed trees exist. Before smoke, verify each root/canonical/tree Git directory resolves inside the destination replica, each healthy tree's administrative `gitdir` back-reference points to its own `.git` file, and the discovered alias/task/state set matches the row/variant. Normalize replica paths when comparing outputs, but keep alias order, field values, errors, and exit results. Shared immutable upstream seeds may be outside the replica; mutable indexes, refs, and worktree records must not be shared. Discard and recreate a failed-isolation replica instead of repairing links to a measured fixture.

Run doctor with a fresh empty temporary `HOME` and `XDG_STATE_HOME`, and no project skill directories or locks. Verify `os.homedir()` resolves to that temporary home in the child environment. Clear inherited `OMS_TEST_*`, `OMS_NPX_BIN`, and prompt overrides for measured production-bundle commands; do not mock package versions, skill references, or registry replies. Use the same isolated environment before and after and record it in the sample. The diagnostic preload also counts attempted `fetch` calls and rejects an unexpected request before network access; any attempt invalidates the doctor sample even if the command catches the rejection and exits 0. Empty skill state should avoid channel lookup through the existing `findings.length === 0` path. This controls the measurement environment without changing production doctor or skill implementation.

Use a temporary Node preload instrumenting `child_process.spawnSync` (and `syncBuiltinESMExports` for named ESM imports) to log cwd, argument categories, and elapsed time to a separate diagnostic channel. Validate its coverage with one known Git read. Count calls in the actual production bundle, not a fake runner; do not capture URLs, credentials, or source-file contents. Limit attribution to the relevant pointer collection or managed-tree inventory phase; other doctor Git status-like commands are not subject to a blanket zero-call claim. Remove this instrumentation after measurement.

Acceptance is structural and deterministic:
- A removes the second pointer collection per selected alias without removing root source/count reads.
- B/D/E execute zero healthy-tree working-file status reads in their inventory phase.
- C inspects healthy trees of selected aliases only; unfiltered output still inspects all reported healthy trees.
- Discovery probes, complete inventory, outputs/exit results, and unrelated mutation safeguards remain intact.

Record three comparable elapsed-time runs per read-only scenario with median, range, subprocess categories, source content fingerprint, Node/Git/platform/architecture, fixture dimensions, and cache/load notes. Elapsed time is diagnostic, not a flaky CI threshold or a promised percentage improvement. Do not sum owner durations into a CLI estimate or rewrite historical suite/owner measurements.

After each slice's smoke proof, append its evidence to `tests/performance/status-inspection.json` and update the concise reproduction/interpretation note in `docs/development.md`. Create one patch Changeset after A and extend the same Changeset after each subsequent verified slice. Keep only these records, not throwaway instrumentation/fixtures; recreate temporary instrumentation when needed. This is a bounded evidence record, not a new benchmark framework.

## Risks / Trade-offs

- Invocation-local observations are not atomic across all Git reads -> promise reuse only, not transactional consistency. Subsequent invocations always recollect state.
- Dirty selection accidentally restricts discovery -> apply selection only in the final healthy-tree status loop; verify undeclared, broken, and foreign entries remain discoverable.
- Uninspected `dirty: null` is rendered as clean -> only presence/health consumers request discovery-only; all dirty-output callers request full or matching-alias inspection.
- Interface migration alters queued-runner sequencing -> migrate all references in B and preserve behavior assertions, not exact implementation call sequences.
- Optimizing unsync bypasses protection -> change inspection depth only; retain selected-entry presence and force refusal, topology preflight, transaction, and recovery behavior.
- Existing error-to-clean and remote reconciliation defects complicate smoke -> report independently; do not fold their repairs into these slices or weaken the existing specs to match them.
- Host contention obscures latency -> compare the same runtime and fixture shape, retain deterministic counts, and label timing conditions.

## Migration Plan

No persisted data or public schema migration is needed. Land each complete slice with its own gate; the task checklist records which ones are verified. If a slice fails, repair or revert only that slice before continuing, preserving earlier verified slices and user-owned changes. Final release packaging proceeds through the unchanged project gates; this change does not publish or advance a version.
