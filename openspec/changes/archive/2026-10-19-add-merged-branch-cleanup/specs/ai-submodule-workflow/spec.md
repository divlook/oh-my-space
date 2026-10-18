# Spec Delta

## ADDED Requirements

### Requirement: Single-repository merged branch cleanup
The system SHALL provide `oms branch clean [alias] [--base <ref>]` to clean merged local branches in exactly one declared source repository. Omitted aliases SHALL require interactive selection without inferring the current alias or automatically choosing a sole alias. Cleanup SHALL NOT support workspace-wide selection or force deletion.

#### Scenario: Explicit repository selection
- **WHEN** the user runs `oms branch clean api`
- **THEN** only local branches in `oms/api/` are considered
- **AND** other source repositories and the root repository's branches are untouched

#### Scenario: Omitted alias requires selection
- **WHEN** the user runs `oms branch clean` interactively
- **THEN** OMS presents initialized declared aliases even if there is only one or the user is inside a source checkout
- **AND** no deletion occurs until an alias and the batch are confirmed

#### Scenario: Missing alias is non-interactive
- **WHEN** the user omits the alias without an interactive terminal
- **THEN** OMS exits 1 without guessing a target
- **AND** provides `oms branch clean <alias>` guidance

#### Scenario: Invalid selection or unsupported options
- **WHEN** the user supplies an unknown alias, several aliases, `--all`, or `--force`
- **THEN** OMS rejects the request before deleting any branch
- **AND** exits 1

### Requirement: Cleanup repository preparation
Cleanup SHALL use shared preparation without offering new registration. Registered uninitialized targets SHALL be initialized automatically; preparation MAY create or attach a baseline branch with tracking configuration at the recorded commit. Cleanup SHALL refuse inconsistent registration, managed-tree execution, in-progress source Git operations, and detached HEAD not equal to the recorded source commit, meaning the source gitlink committed in root HEAD rather than a staged pointer.

#### Scenario: Registered target is uninitialized
- **WHEN** an explicit cleanup alias is consistently registered but uninitialized
- **THEN** OMS initializes only that alias without creating root topology
- **AND** reevaluates cleanup preconditions after preparation
- **AND** fetched data, branch creation or attachment, and tracking-configuration effects remain if cleanup is later declined

#### Scenario: Target cannot be prepared safely
- **WHEN** the selected alias is unregistered or inconsistently registered
- **THEN** OMS exits 1 with targeted synchronization guidance and no deletion
- **AND** does not offer or create registration

#### Scenario: Initialization fails
- **WHEN** automatic initialization fails
- **THEN** OMS exits 2 with the Git failure and resumable-state guidance
- **AND** does not attempt deletion or discard fetched data

#### Scenario: Unsafe source state
- **WHEN** cleanup runs inside a managed tree, a source Git operation is in progress, or detached HEAD is not anchored to the root-recorded source commit
- **THEN** OMS refuses cleanup with the reason and a recovery action
- **AND** no local branch is deleted

### Requirement: Explicit cleanup comparison base
Cleanup SHALL default to the local branch named by the selected repository's `oms.yaml` `branch`, or by that repository's existing `origin/HEAD` when `branch` is omitted; it SHALL NOT use a fixed `main` default. `--base` SHALL select a resolvable local or remote-tracking comparison branch without overriding protected baselines. Cleanup SHALL display the full comparison ref and commit, perform no implicit base fallback, and not fetch or reconcile remotes after preparation.

#### Scenario: Repository-specific manifest base
- **WHEN** `api` declares `branch: develop`, `web` declares `branch: release`, and `--base` is absent
- **THEN** cleanup for `api` compares against `refs/heads/develop`, and cleanup for `web` compares against `refs/heads/release`
- **AND** neither invocation substitutes `main` or its remote-tracking counterpart

#### Scenario: Remote default identifies the base name
- **WHEN** the manifest omits `branch` and existing `origin/HEAD` identifies `origin/main`
- **THEN** cleanup uses the local `refs/heads/main`
- **AND** does not refresh `origin/HEAD` during cleanup

#### Scenario: Explicit remote-tracking base
- **WHEN** the user runs `oms branch clean api --base origin/main`
- **AND** that name resolves unambiguously to a remote-tracking branch
- **THEN** cleanup uses the existing `refs/remotes/origin/main` and displays its commit
- **AND** does not fetch, prune, or modify that ref

#### Scenario: Comparison base is unavailable or ambiguous
- **WHEN** the default local base is missing, `origin/HEAD` cannot supply the default name, or an explicit base is missing, ambiguous, or not a branch ref
- **THEN** OMS exits 1 before deletion
- **AND** a missing local default receives explicit-base guidance only when protected baselines can still be resolved reliably
- **AND** unresolved protected baselines require declaring the selected repository's `branch` or repairing `origin/HEAD`; `--base` does not bypass that refusal

#### Scenario: Explicit comparison does not replace baseline protection
- **WHEN** the manifest omits `branch`, `origin/HEAD` cannot be resolved reliably, and the user supplies an otherwise valid `--base release`
- **THEN** cleanup exits 1 without deletion
- **AND** explains how to restore the protected baseline rather than suggesting another comparison base

### Requirement: Base-relative cleanup candidates
Cleanup SHALL consider a local branch merged only if its tip commit is an ancestor of or equal to the comparison base commit. Upstream state, current HEAD, missing remote refs, and pull-request metadata SHALL NOT replace this test. The current branch, the selected local base, every reliably resolved baseline, and every branch used by any registered worktree SHALL be excluded with reasons.

#### Scenario: Branch is merged into the base
- **WHEN** a non-protected local branch tip is contained in the base history
- **THEN** it appears as a deletion candidate in ascending branch-name order
- **AND** its tip commit is shown before confirmation

#### Scenario: Additional commits remain outside the base
- **WHEN** a branch has a commit not contained in the base history, including one added after an earlier merge
- **THEN** it is excluded as not merged into the selected base
- **AND** a merged upstream or missing remote counterpart does not make it eligible

#### Scenario: Squash or rebase does not preserve ancestry
- **WHEN** equivalent changes reached the base through squash or rebase but the local branch tip is not in its history
- **THEN** cleanup preserves that branch without querying a hosting service or comparing patches

#### Scenario: Protected or occupied branch
- **WHEN** a merged local branch is current, is the selected local base, is any protected baseline, or is used by a registered worktree inside or outside `.oms-tree/`
- **THEN** it is excluded with the applicable protection reasons
- **AND** no worktree is removed or pruned

#### Scenario: Proven ancestry in shallow history
- **WHEN** the source repository is shallow and a non-protected local branch tip is proven to be contained in the comparison base history
- **THEN** that branch remains eligible for the confirmed batch

#### Scenario: Ancestry is unproven in shallow history
- **WHEN** the source repository is shallow and ancestry inspection returns not-an-ancestor without a Git error
- **THEN** cleanup preserves that branch and identifies the limited-history reason without claiming definitive non-merge
- **AND** provides history-repair guidance without fetching implicitly

#### Scenario: Safety inventory cannot be trusted
- **WHEN** baseline metadata, local refs, worktree occupancy, or ancestry cannot be inspected reliably
- **THEN** cleanup exits non-zero before deleting a branch using that uncertain state
- **AND** reports the failed inspection rather than treating it as an empty inventory

### Requirement: Informed cleanup batch confirmation
Cleanup SHALL display the selected alias, comparison ref and commit, deletion candidates and tips, excluded branches with reasons, preparation effects, and the unsupported-concurrency condition before one batch confirmation that defaults to No. No candidates SHALL produce a successful no-op. A non-interactive invocation with candidates SHALL fail without deleting them; this change SHALL NOT add a confirmation-bypass option or standalone preview mode.

#### Scenario: Confirm the batch
- **WHEN** the user accepts the displayed batch
- **THEN** OMS attempts only candidates from that displayed batch
- **AND** does not ask once per branch or include newly discovered branches

#### Scenario: Decline or cancel
- **WHEN** the user declines or cancels confirmation or alias selection
- **THEN** OMS exits 1 and deletes no local branch
- **AND** explains any preparation effects already completed

#### Scenario: No eligible branches
- **WHEN** no local branch meets the cleanup conditions
- **THEN** OMS reports that nothing can be cleaned and exits 0 without confirmation

#### Scenario: Candidates exist without a terminal
- **WHEN** an explicit alias produces deletion candidates but no interactive terminal is available
- **THEN** OMS prints the plan and exits 1 without deletion
- **AND** asks the user to rerun the same cleanup command in an interactive terminal

### Requirement: Cleanup concurrency boundary
Users SHALL NOT mutate the selected source repository's branches, worktrees, or configuration through other Git or IDE operations from confirmation waiting through cleanup completion. Cleanup SHALL detect changes through final inspection and expected-commit verification, but SHALL NOT claim atomic protection for worktree occupancy, metadata, operation markers, branch configuration, or direct-ref type. This restriction SHALL be displayed before confirmation and documented.

#### Scenario: Explain unsupported concurrent changes
- **WHEN** cleanup displays a batch for confirmation
- **THEN** it explains that other Git or IDE branch, worktree, and configuration changes must wait until cleanup finishes
- **AND** it does not claim that commit-value verification locks all repository state

### Requirement: Revalidated local cleanup execution
Cleanup SHALL recheck selected declaration, registration, root-committed gitlink, ref types and commits, protection, occupancy, source preconditions, and ancestry before deletion. Candidate identity SHALL be name plus commit ID. Changed tips SHALL preserve candidates; changed base or selected context, or unreliable shared safety, SHALL stop remaining work. Deletion SHALL atomically verify confirmed commits without force retries; ref-type and occupancy checks are not atomic.

#### Scenario: Selected base differs from HEAD and upstream
- **WHEN** a confirmed branch is merged into the selected base but not into current HEAD or its configured upstream
- **AND** all final safety checks succeed
- **THEN** cleanup deletes it using the selected base as the safe-deletion comparison
- **AND** does not persist an upstream change or switch the checkout

#### Scenario: Branch changed after confirmation
- **WHEN** final revalidation detects a different tip for a confirmed candidate
- **THEN** that branch is preserved with a concurrent-change reason
- **AND** other candidates are processed only while repository-wide safety remains valid
- **AND** the invocation exits 2

#### Scenario: Base or shared safety changes
- **WHEN** final revalidation detects that the displayed base moved, a source Git operation started, or a reliable safety inventory is no longer available
- **THEN** no remaining candidate is deleted
- **AND** OMS reports remaining candidates as not run and exits 2

#### Scenario: Selected declaration, registration, or recorded commit changes
- **WHEN** final revalidation detects a change to the selected repository's declaration, registration information, or root-committed source gitlink after confirmation
- **THEN** cleanup stops remaining deletions and reports not-run candidates with exit 2
- **AND** unrelated repository declaration changes or root commits that leave the selected information unchanged do not alone invalidate the plan

#### Scenario: Candidate is recreated at the same name and commit
- **WHEN** a confirmed candidate has been deleted and recreated with the same branch name and commit ID
- **AND** final safety checks otherwise succeed
- **THEN** cleanup treats it as the same confirmed candidate state without attempting to distinguish creation generations

#### Scenario: Candidate becomes protected or occupied
- **WHEN** final revalidation detects that a confirmed candidate became protected or used by a worktree
- **THEN** it is preserved with the reason
- **AND** OMS does not force-delete or remove the worktree
- **AND** the invocation exits 2

#### Scenario: Git deletion fails
- **WHEN** Git refuses deletion and the branch still exists
- **THEN** OMS reports the failure, preserves the branch, and does not offer force deletion
- **AND** continues only with other independently safe candidates and exits 2

#### Scenario: Branch disappeared after confirmation
- **WHEN** a confirmed branch is already absent when checked
- **THEN** OMS reports it as already absent without counting it as deleted by this invocation

### Requirement: Cleanup results and repository boundaries
Cleanup SHALL report deleted, already-absent, preserved, failed, and not-run candidates, with config-cleanup status for completed deletions. Successful batches SHALL exit 0; incomplete batches, including config failures, SHALL exit 2 without rollback. After preparation and under the concurrency restriction, cleanup SHALL preserve remote refs, source HEAD/files/index, and root tracked state, and SHALL NOT record source pointers. Results SHALL provide recovery, rerun, or repair guidance.

#### Scenario: Batch partially succeeds
- **WHEN** one candidate is deleted and another fails or becomes ineligible
- **THEN** the result names both outcomes and exits 2
- **AND** the successful deletion remains completed
- **AND** preserved or failed branches receive an actionable explanation

#### Scenario: Branch configuration cleanup fails
- **WHEN** a candidate ref is deleted successfully but removing its branch configuration fails
- **THEN** cleanup reports that the branch was deleted but metadata cleanup is incomplete and exits 2
- **AND** it provides an exact config-repair command and continues with independently safe candidates
- **AND** missing branch configuration alone is not a failure

#### Scenario: Configuration cleanup scope
- **WHEN** a confirmed candidate is deleted
- **THEN** cleanup removes only that branch name's configuration section and preserves other branch names' settings
- **AND** documentation warns that unsupported same-name recreation between ref deletion and config cleanup can lose the recreated branch's settings

#### Scenario: Recovery information for a deleted branch
- **WHEN** cleanup reports a completed branch deletion
- **THEN** it prints the branch's original full commit ID and a shell-safe Git command to recreate it while the commit is available
- **AND** it does not claim automatic rollback or durable recovery storage

#### Scenario: Local deletion has no workspace side effects
- **WHEN** cleanup deletes eligible branches after preparation
- **THEN** same-named remote and remote-tracking branches remain
- **AND** source HEAD, working-tree files, and staged changes remain unchanged
- **AND** no root path is staged or committed and no recorded source commit changes

## MODIFIED Requirements

### Requirement: Interactive branch action selection
The system SHALL provide an `oms branch` command group that hosts every supported branch-management action as a subcommand — `list`, `switch`, `checkout`, `delete`, and `clean` — and SHALL NOT expose top-level `oms switch` or `oms checkout` commands. `oms branch switch [alias] [branch]` SHALL provide the local-branch management behavior (switch to an existing local branch, or create a new one with no remote required) previously provided by top-level `oms switch`, and `oms branch checkout [alias] [branch]` SHALL provide the remote-tracking behavior (fetch origin, then check out an `origin/*` branch as a local tracking branch) previously provided by top-level `oms checkout`.

#### Scenario: Interactive branch command offers every lifecycle action
- **WHEN** the user runs `oms branch` in an interactive terminal
- **THEN** the command presents `list`, `switch`, `checkout`, `delete`, and `clean` actions in lifecycle order

#### Scenario: Interactive branch command selects list
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects list
- **THEN** the command continues into the `oms branch list` alias-resolution flow

#### Scenario: Interactive branch command selects switch
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects switch
- **THEN** the command continues into the `oms branch switch` local-branch interaction

#### Scenario: Interactive branch command selects checkout
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects checkout
- **THEN** the command continues into the `oms branch checkout` remote-tracking interaction

#### Scenario: Interactive branch command selects delete
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects delete
- **THEN** the command continues into the existing `oms branch delete` interaction

#### Scenario: Interactive branch command selects clean
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects clean
- **THEN** the command continues into the `oms branch clean` alias selection and batch-confirmation flow

#### Scenario: Branch switch subcommand preserves former top-level switch behavior
- **WHEN** the user runs `oms branch switch api feature/login`
- **THEN** the command behaves exactly as the former `oms switch api feature/login`, switching to or creating the local branch without requiring a remote

#### Scenario: Branch checkout subcommand preserves former top-level checkout behavior
- **WHEN** the user runs `oms branch checkout api dev`
- **THEN** the command behaves exactly as the former `oms checkout api dev`, fetching origin and checking out `origin/dev` as a local tracking branch

#### Scenario: Top-level switch and checkout commands are removed
- **WHEN** the user runs `oms switch ...` or `oms checkout ...`
- **THEN** the CLI reports an unknown command
- **AND** exits with a non-zero status

#### Scenario: Branch action selection is cancelled
- **WHEN** the user cancels the action selector opened by `oms branch`
- **THEN** the command exits 1 without modifying any submodule or root repository state

#### Scenario: Branch command without action is non-interactive
- **WHEN** the user runs `oms branch` in a non-interactive shell
- **THEN** the command prints branch command help
- **AND** exits 1 without modifying repository state
