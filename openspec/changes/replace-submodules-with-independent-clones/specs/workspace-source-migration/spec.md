# Workspace Source Migration

## Purpose

Convert legacy OMS-managed submodules to independent source checkouts without losing work stored on any computer.

## ADDED Requirements

### Requirement: Explicit workspace conversion
OMS SHALL provide `oms migrate` for all legacy OMS-managed sources in the workspace. Preview and apply SHALL use the same workspace-wide scope; neither SHALL accept alias selection. Ordinary commands SHALL NOT migrate sources implicitly. Migration SHALL verify the root, report affected aliases and planned changes, provide a write-free preview, and require explicit authorization before applying the plan.

#### Scenario: Legacy checkout used with clone
- **WHEN** `oms clone` targets a legacy OMS submodule or an absent checkout with retained legacy Git data
- **THEN** OMS directs the user to migration without initializing, replacing, or advancing that checkout

#### Scenario: Preview or decline conversion
- **WHEN** the user previews the operation or does not authorize the migration plan
- **THEN** OMS leaves the root index, tracked files, and local source repositories unchanged

#### Scenario: Alias selection is not supported
- **WHEN** the user supplies an alias to `oms migrate` or `oms migrate --dry-run`
- **THEN** OMS reports that migration applies to the entire workspace and performs no writes

### Requirement: Preserve existing local repository state
A successful conversion of an initialized source SHALL preserve its checkout path, HEAD, local refs, unpublished commits, stash, index, working files, configuration not specific to legacy attachment, and linked Git worktrees. It SHALL NOT re-clone over existing data, reset to a remote ref, or require publishing local work.

#### Scenario: Source contains unpublished work
- **WHEN** an initialized source has an unpushed commit, a stash, staged and unstaged edits, and untracked files
- **THEN** the converted repository exposes the same local data and still has its original checkout state, including a detached HEAD if present

#### Scenario: Linked worktree has ongoing changes
- **WHEN** a legacy source has a linked worktree with unpublished work, whether inside `.oms-tree/` or elsewhere
- **THEN** a successful migration preserves its path, current branch or detached HEAD, index, working files, and attachment to the converted repository

### Requirement: Limit shared root changes to OMS sources
Migration SHALL remove only the legacy registrations owned by OMS and obsolete registration settings. It SHALL make migrated checkout paths ignored without hiding unrelated files under `oms/`. It SHALL preserve unrelated submodules, root changes, and staged entries, and SHALL NOT commit or push on the user's behalf.

#### Scenario: Workspace contains unrelated root content
- **WHEN** migration succeeds in a root containing non-OMS submodules, unrelated staged changes, and agent instruction files
- **THEN** the root stops tracking the selected OMS gitlinks, and the unrelated registrations, files, and staged entries remain unchanged

### Requirement: Per-computer migration after shared root update
Migration SHALL recognize legacy local repository data even after the shared root has stopped tracking the corresponding submodule. It SHALL reuse reliably identified local data and SHALL distinguish it from a genuinely missing checkout with no local legacy data. If local ownership or the safe preservation path is uncertain, it SHALL stop and identify the recovery action instead of cloning over the path.

#### Scenario: Second computer receives the converted root
- **WHEN** the shared root no longer contains the OMS registration but the second computer still has the legacy checkout or repository data with a local branch
- **THEN** explicit migration preserves that branch and any other recoverable local state without requiring the old root pointer to be restored

#### Scenario: Root history cannot establish ownership
- **WHEN** a computer has retained Git data after the shared conversion but its local root history does not verify the prior registration
- **THEN** neither migration nor clone overwrites the retained data or creates a new checkout for the alias
- **AND** OMS identifies the missing history and explains how to obtain it before retrying

#### Scenario: No local legacy data exists
- **WHEN** the shared root is converted and the alias has neither a checkout nor legacy local data
- **THEN** `oms clone` can provision the alias from the declared branch or remote default

### Requirement: Safe recovery from blocked or interrupted migration
Migration SHALL refuse conflicting registrations, ambiguous paths, and other states that prevent safe conversion. If interruption leaves work incomplete, OMS SHALL make the preserved state and next recovery action visible. A rerun SHALL preserve already converted repositories and SHALL NOT create duplicate checkouts or discard the only copy of repository data.

#### Scenario: Conversion cannot be done safely
- **WHEN** a legacy alias path is occupied by an unrelated repository or verified preservation of its worktrees is not possible
- **THEN** OMS reports the affected alias, what is preserved, and how to resolve the condition without replacing that data

#### Scenario: One unsafe alias blocks the entire migration plan
- **WHEN** migration preflight finds an unsafe alias alongside aliases it could safely convert
- **THEN** OMS names the blockers and leaves every checkout, worktree, and shared root file and index entry unchanged
- **AND** OMS does not start a migration journal for the rejected plan

#### Scenario: User ignore rules block migration before writes
- **WHEN** the proposed migration would leave a source checkout exposed to root staging unless user-authored ignore rules were overridden
- **THEN** OMS identifies the conflicting path and rejects the entire plan before changing any checkout, index entry, or root rule

#### Scenario: Migration is rerun after interruption
- **WHEN** a migration is interrupted and later rerun
- **THEN** the converted repositories remain usable and the incomplete work resumes safely or stops with actionable recovery guidance
