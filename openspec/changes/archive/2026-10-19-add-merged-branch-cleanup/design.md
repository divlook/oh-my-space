# Design

## Context

See `proposal.md` for motivation and `specs/ai-submodule-workflow/spec.md` for the behavior contract.

Existing branch commands are registered in `scripts/oms.ts`; the interactive action selector and single-branch deletion live in `scripts/lib/branch-delete.ts`. `resolveBaselines` in `branch-baseline.ts` protects manifest and reliable `.gitmodules` baselines, including metadata drift. `prepareAlias` already initializes registered sources without offering new registration for destructive workflows. `tree-ops.ts` has a porcelain worktree parser, but its managed-tree inventory filters paths into `.oms-tree/`; cleanup must inspect all worktrees in the source repository.

The existing deletion implementation uses `git branch -d`, which tests the branch's upstream or HEAD rather than an arbitrary cleanup base. Reusing it would also inherit its force prompt. Both conflict with cleanup's contract, so single-branch deletion remains unchanged and cleanup owns its base-relative execution.

## Goals / Non-Goals

**Goals:**
- Keep alias preparation and baseline protection consistent with existing commands.
- Make candidate collection fail closed and deletion conditional on the exact displayed base and branch commits.
- Preserve a small public interface, `runBranchClean(aliasArg, options)`, with planning and execution details local to the cleanup module.

**Non-Goals:**
- No general branch-management framework or rewrite of existing deletion.
- No network refresh or checkout movement after preparation, temporary comparison branches, hosting integration, or automatic worktree removal. Shared initialization may create or attach a baseline branch at the recorded commit and set its upstream; these effects remain after cancellation.
- No `--yes`, `--force`, `--all`, JSON output, or independent preview mode in this change.

## Decisions

### 1. Default to an existing local base; never silently substitute a remote ref

Resolve the default name from the selected repository's `repo.branch`, otherwise from its existing `origin/HEAD`, then require `refs/heads/<name>` after preparation. There is no fixed `main` default. Never substitute a remote ref when the local default is missing. `--base` accepts an existing local or remote-tracking branch, including a full ref name. Resolve short names unambiguously across branch namespaces; reject ambiguous names, tags, raw commit IDs, revision expressions, and symbolic branch refs. Never interpolate a user ref into a shell command.

Display the canonical full ref and full commit ID. A missing local default gets guidance to supply an existing `--base`, not a checkout or implicit fetch. An explicit comparison base does not bypass baseline protection: if manifest `branch` is omitted and `origin/HEAD` cannot be resolved reliably, require declaring the repository's `branch` or repairing `origin/HEAD`. Shared initialization may access the registered remote and create or attach a baseline branch; that is distinct from refreshing the cleanup base. Cached remote refs are identified as not refreshed.

Alternatives: remote-first resolution would change the meaning of the configured base; automatic fetch adds mutation and network failure to branch cleanup. Both are unnecessary when the user can explicitly choose a remote-tracking base.

### 2. Build one immutable confirmation plan

Add `scripts/lib/branch-clean.ts` with the public command entry point and internal plan/result types. A plan contains the alias, canonical base ref and commit, and sorted local branches with full tips and either candidacy or exclusion reasons. Collect refs with `for-each-ref` including full names, object IDs, and symbolic-ref targets; distinguish failure from an empty result. Avoid computing upstream divergence, which is irrelevant here.

Use `resolveBaselines` for protection. Capture the selected repository's declaration, registration information, and recorded source commit after preparation; re-read them before each candidate and stop remaining work if they change or cannot be inspected reliably. The recorded source commit is the selected gitlink committed in root HEAD, not a staged index pointer; unrelated repository declarations or unrelated root commits do not alone invalidate the plan. Narrowly share source-operation and detached-anchor checks without changing the existing deletion caller's behavior. Cleanup must distinguish inspection failure from an idle operation state or detached HEAD instead of inheriting helpers that collapse these results. Run source-local `git worktree list --porcelain -z` across all entries, including locked or prunable records, not just OMS-managed paths. Keep the NUL-delimited reader local unless another caller needs it; do not expand the existing newline parser's interface.

Test ancestry using `git merge-base --is-ancestor <tipOid> <baseOid>`: exit 0 proves containment, exit 1 excludes the branch, and other failures stop planning. Inspect shallow state reliably: in a shallow repository, describe exit-1 exclusions as ancestry not proven with limited history rather than definitively unmerged. Proven ancestors remain eligible; do not fetch implicitly. Exclude symbolic local branch refs. Protect the selected local base even when it is not a configured baseline.

### 3. Require one default-No confirmation

Omitted aliases follow the destructive selector convention from `branch delete`: show initialized declared aliases, never infer the current source or auto-select a sole alias. Explicit aliases use shared preparation with `topologyOffer: false`. An empty selector gets synchronization guidance.

Render the plan once, including any preparation effects and the requirement not to mutate source branches, worktrees, or configuration through another Git or IDE operation from confirmation waiting through completion. Use `guardedConfirm` with `initialValue: false`. No candidates return 0 without prompting. Decline or cancellation returns 1 and reports retained preparation effects. Non-interactive runs with candidates display the plan and return 1 with an interactive rerun command; no bypass flag is added. Use the existing guarded prompt queue for deterministic integration coverage.

### 4. Delete refs with an expected-value transaction, not force deletion

Before each candidate, re-read the selected declaration, registration information, and recorded source commit, then refresh source preconditions, protected baselines, current branch, all-worktree occupancy, base ref type and commit, and candidate ref type and commit. Changed declaration, registration, or recorded source commit stops remaining work. Require the displayed tip and recheck ancestry against the displayed base commit. Never add candidates after confirmation. Candidate identity is branch name plus commit ID: deletion and recreation at the same name and commit remain the same eligible state if all other checks pass; creation generations are not distinguished.

For one validated candidate, use a `git update-ref --no-deref --stdin` transaction containing `verify <baseRef> <baseOid>` and `delete <candidateRef> <candidateOid>`, followed by prepare and commit. This atomically requires both resolved commit values to match the displayed values while deleting only the specified local ref. It does not identify branch generations, detect movement away and back to the same commit, or atomically require direct rather than symbolic refs. `--no-deref` prevents deletion of a symbolic candidate's referent; reject symbolic candidate/base refs during inspection. Use one transaction per candidate, not an atomic batch.

Unlike `git branch -d`, `update-ref` does not check merge containment or worktree use: those checks are mandatory in the cleanup module. Do not expose this operation as an unchecked generic deletion helper. It is not a force fallback: no branch outside the confirmed ancestry and safety conditions is eligible.

After a committed deletion, remove only that branch name's configuration section using Git's config interface. Missing configuration is harmless. A real config failure is a completed ref deletion with incomplete metadata cleanup and exit 2, not an intact branch or rollback; continue with independently safe candidates and provide an exact config-repair command. Do not modify other branch names' tracking settings. Config cleanup is not atomic with ref deletion: unsupported same-name recreation can cause the new branch's settings to be removed. Git handles the deleted ref's reflog; no raw filesystem deletion is needed.

Alternatives rejected:
- Calling `runBranchDelete` inherits HEAD/upstream semantics and a force prompt.
- Calling `git branch -D` after inspection lacks an expected-tip guard and is explicitly out of scope.
- Temporarily switching HEAD or changing stored upstream configuration violates checkout/config preservation.
- Command-scoped upstream overrides were experimentally insufficient when an existing merge configuration pointed elsewhere.

Disposable Git experiments confirmed that expected-value transactions delete unchanged candidates and reject different tips. They also confirmed that same-OID symbolic replacements pass commit verification, worktree occupancy introduced after inspection can lose its branch, and later config cleanup can remove a same-named recreated branch's settings. These are design experiments, not an implementation smoke test.

### 5. Preserve accurate partial outcomes

Use separate outcomes for deleted, already absent, preserved, failed, and not run, with config-cleanup status attached to completed deletions. A changed candidate, newly occupied/protected candidate, or candidate-local Git failure preserves that branch and permits later independently safe candidates. A changed base, selected declaration or registration, recorded source commit, unsafe source precondition, or unreliable shared inventory stops remaining work. Successful or already-absent candidates yield 0 unless another outcome is incomplete; any incomplete confirmed batch, including config-cleanup failure, yields 2. Preparation and invalid-input failures retain existing 1/2 conventions.

Report the failed operation, preserved state, and an exact shell-safe rerun or repair action. Output each deleted branch's original full tip and a Git recreation command while the commit remains available. Never claim rollback. No durable recovery journal is added because cleanup does not replace the root index or finalize root history.

## Risks / Trade-offs

- **Concurrent worktree or metadata mutation:** Other Git or IDE operations must not mutate source branches, worktrees, or configuration from confirmation waiting through completion. Ref transactions compare commit values but do not atomically protect ref type, worktree registration, baseline files, operation markers, or branch config. Final checks detect some changes but cannot close every race. A worktree occupying a candidate after inspection may lose its branch; same-name recreation may lose its settings. This is unsupported concurrency, not a universal lock or safety guarantee.
- **Local or cached base is behind:** Cleanup can leave completed branches behind. Display the exact base and explain how to update it with existing fetch/pull commands; do not compensate with force or patch equivalence.
- **Low-level deletion omits branch policy:** The cleanup module must own ancestry, occupancy, protection, symbolic-ref rejection, and configuration cleanup. Integration coverage must exercise these safeguards against real Git.
- **Interrupted batch or config cleanup:** Already committed deletions remain complete. A rerun considers only surviving refs; any failed configuration cleanup receives specific repair guidance.
- **Shallow or incomplete history:** Only proven ancestry permits deletion. Preserve branches whose ancestry is unproven in shallow history, identify the history limitation, and provide repair guidance. Inspection errors stop planning; do not fetch implicitly.

## Migration Plan

This is an additive command with no persisted schema migration. Register `clean` in the CLI and interactive action list, keep existing deletion semantics, and update built-in help and branch safety documentation. Add focused behavioral coverage at the established integration layer and a production-bundle command journey under existing black-box ownership. Record test inventory changes and add an English feature changeset after the implementation smoke run.

Rollback removes the new command; it cannot restore branches already cleaned. Successful deletions retain their displayed tip in output so users can recreate a branch using an explicit Git command while the commit remains available.
