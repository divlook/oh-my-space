# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit cleanup comparison base
Cleanup SHALL default to the local branch named by the selected repository's `oms.yaml` `branch`, or by that repository's existing `origin/HEAD` when `branch` is omitted; it SHALL NOT use a fixed `main` default. `--base` SHALL select a resolvable local or remote-tracking comparison branch without overriding protected baselines. For a nonempty deletion plan, cleanup SHALL display the full comparison ref and commit. Cleanup SHALL perform no implicit base fallback and SHALL NOT fetch or reconcile remotes after preparation.

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
- **THEN** cleanup uses the existing `refs/remotes/origin/main`
- **AND** displays its full ref and commit when deletion candidates exist
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

### Requirement: Informed cleanup batch confirmation
For a nonempty deletion plan, cleanup SHALL display the alias, comparison ref and commit, candidates and tips, exclusions with reasons, actual preparation effects, and the unsupported-concurrency condition before one default-No confirmation. No candidates SHALL produce a successful no-op without confirmation. Non-interactive candidates SHALL fail without deletion. Cleanup SHALL NOT add a confirmation-bypass option or standalone preview mode.

#### Scenario: Confirm the batch
- **WHEN** the user accepts the displayed batch
- **THEN** OMS attempts only candidates from that displayed batch
- **AND** does not ask once per branch or include newly discovered branches

#### Scenario: Decline or cancel
- **WHEN** the user declines or cancels confirmation or alias selection
- **THEN** OMS exits 1 and deletes no local branch
- **AND** explains any preparation effects already completed
- **AND** does not print a routine notice that an already initialized source needed no initialization

#### Scenario: No eligible branches
- **WHEN** no local branch meets the cleanup conditions after successful inspection
- **THEN** OMS reports that nothing can be cleaned for the selected alias and exits 0 without confirmation
- **AND** omits the deletion plan and deletion-concurrency warning
- **AND** retains actual preparation effects and applicable safety or history-limitation diagnostics

#### Scenario: Candidates exist without a terminal
- **WHEN** an explicit alias produces deletion candidates but no interactive terminal is available
- **THEN** OMS prints the plan and exits 1 without deletion
- **AND** asks the user to rerun the same cleanup command in an interactive terminal

## ADDED Requirements

### Requirement: Contextual empty cleanup reporting
After successful inspection, cleanup SHALL use an alias-specific no-op summary instead of a deletion plan when no candidates exist. An already initialized source with no exceptional diagnostics SHALL produce only that summary after alias selection. Cleanup SHALL retain actual preparation effects and exceptional diagnostics, and SHALL NOT equate no candidates with a clean working tree or all branches being merged.

#### Scenario: Initialized source has only protected branches
- **WHEN** an initialized source has no eligible branches and no exceptional diagnostics
- **THEN** cleanup prints one alias-specific no-op summary after any required alias selection
- **AND** prints no comparison-base dump, branch inventory, routine preparation notice, or deletion-concurrency warning
- **AND** exits 0 without changing branches or requesting deletion confirmation

#### Scenario: Unmerged branches are preserved in a no-op
- **WHEN** inspection succeeds but every remaining topic branch is outside the comparison base's history
- **THEN** cleanup reports no eligible branches without listing ordinary exclusions
- **AND** does not claim all topic branches were merged or working files are clean
- **AND** preserves those branches and exits 0

#### Scenario: Initialization precedes an empty plan
- **WHEN** cleanup initializes a registered source and subsequently finds no eligible branches
- **THEN** cleanup reports the completed initialization and its retained effects alongside the no-op summary
- **AND** does not claim the whole invocation was read-only or that preparation was rolled back

#### Scenario: Limited history prevents proving ancestry
- **WHEN** limited shallow history prevents proving a topic branch's ancestry and no candidates remain
- **THEN** cleanup retains a concise history-limitation diagnostic with explicit deepen-or-repair guidance
- **AND** preserves the branch without claiming it is definitively unmerged
- **AND** does not print the full deletion plan or concurrency warning

#### Scenario: Inspection fails before an empty result can be established
- **WHEN** the comparison base, source safety, baseline metadata, refs, worktree occupancy, or ancestry cannot be inspected reliably
- **THEN** cleanup reports the failure with the existing nonzero exit behavior and applicable recovery guidance
- **AND** does not replace the failure with a successful no-op summary

### Requirement: Concise branch cleanup help
`oms branch clean --help` SHALL prioritize usage, arguments, options, two examples, and brief base and confirmation guidance. It SHALL identify local-only deletion, the default comparison base, no automatic ref refresh after preparation, interactive deletion confirmation, and possible automatic initialization. Detailed safety and recovery rules SHALL remain reachable through the existing documentation link rather than inline help sections.

#### Scenario: Quick usage lookup
- **WHEN** the user runs `oms branch clean --help`
- **THEN** help presents the alias argument and `--base` option followed by examples for the default base and an explicit remote-tracking base
- **AND** examples precede supplemental guidance
- **AND** the command purpose is not repeated in appended prose
- **AND** help exits 0 without inspecting or preparing a source repository

#### Scenario: Essential conditions stay visible
- **WHEN** the user reads cleanup help
- **THEN** brief guidance explains local-only deletion with interactive confirmation, the configured local branch or cached `origin/HEAD` default, no ref refresh after preparation, and automatic initialization of existing registration when necessary
- **AND** help links to the existing merged-branch-cleanup safety documentation

#### Scenario: Detailed rules do not fill quick help
- **WHEN** the user runs cleanup help
- **THEN** it does not append long safety or result sections, detailed concurrency and transaction limitations, an exit-code table, or the generic workspace-discovery explanation
- **AND** the linked documentation continues to describe those detailed rules
- **AND** no new verbose-help flag or other CLI option is introduced
