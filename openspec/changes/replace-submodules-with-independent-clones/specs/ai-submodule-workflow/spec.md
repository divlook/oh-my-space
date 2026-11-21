# Spec Delta

## ADDED Requirements

### Requirement: Independent source checkout lifecycle
OMS SHALL use `oms.yaml` to provision independent Git checkouts at `oms/<alias>/`. The workspace root SHALL share declarations, not commits checked out in sources. OMS SHALL keep managed clone paths out of root staging without ignoring unrelated files in `oms/`.

#### Scenario: Provision a missing source on either computer
- **WHEN** `oms clone api` targets an absent path with no local legacy data
- **THEN** OMS clones the declared origin on the declared branch, or on the remote default when no branch was declared, and leaves the root index and HEAD unchanged

#### Scenario: Existing source is not advanced
- **WHEN** the canonical source has an active topic branch or a detached HEAD and the remote baseline has advanced
- **THEN** `oms clone` preserves its branch, commit, index, and files

#### Scenario: An existing independent clone is eligible without registration
- **WHEN** a user-created independent checkout occupies the declared path and its origin matches the declaration after applying Git URL rewriting to both fetch URLs
- **THEN** OMS uses it without registering it or changing its checkout

#### Scenario: An existing checkout does not match the declared origin
- **WHEN** the origin is missing, ambiguous, or differs after Git URL rewriting
- **THEN** OMS reports the mismatch without overwriting, reconfiguring, or removing the checkout
- **AND** it does not assume that SSH and HTTPS URLs identify the same source

#### Scenario: Configured remotes and missing baseline
- **WHEN** the declaration names additional remotes and an explicit baseline
- **THEN** the clone uses the declared remotes and branch, or fails without leaving an apparently usable checkout if the branch cannot be provisioned

#### Scenario: Unsafe checkout path
- **WHEN** the expected path is occupied by a foreign or unreadable entry, or resolves outside the managed location
- **THEN** `oms clone` reports the failure for that alias without replacing or following the entry

#### Scenario: Source path is ignored without hiding instructions
- **WHEN** a managed clone and root-owned agent instructions are both present under `oms/`
- **THEN** root Git ignores the clone path but does not gain a blanket ignore rule for those instructions

#### Scenario: A user rule prevents a checkout from being ignored
- **WHEN** the effective root ignore rules would leave a selected clone exposed to root staging and OMS cannot fix that without overriding a user rule
- **THEN** `oms clone` reports the conflicting path, leaves the user's rules unchanged, and does not create the checkout for that alias

#### Scenario: Independent clone targets
- **WHEN** several declared aliases are selected and one cannot be provisioned
- **THEN** other eligible aliases are processed and the result reports the affected alias with a nonzero exit

### Requirement: Removed submodule interfaces
OMS SHALL replace `oms sync` and `oms unsync` with `oms clone` and `oms remove` without compatibility aliases. OMS SHALL NOT expose source pointer recording or accept source registration commit options.

#### Scenario: Removed command and flags
- **WHEN** the user invokes `oms sync`, `oms unsync`, or `oms record`, or passes `--commit` or `--no-commit` to `oms clone` or `oms remove`
- **THEN** OMS rejects the invocation before changing any repository

#### Scenario: Obsolete manifest setting
- **WHEN** the manifest contains `autoCommitRegistration`
- **THEN** normal workspace operations identify the legacy setting and direct the user to migration rather than applying it

### Requirement: Versioned independent checkout status
`oms status --json` SHALL report the root and configured source checkouts as one versioned JSON object. The new schema version SHALL differ from version 1 and SHALL omit source `pin` and root `submodulePointers`. Other fields SHALL retain their meanings where applicable.

#### Scenario: Status JSON from workspace root
- **WHEN** the user runs `oms status --json` from the workspace root
- **THEN** stdout contains exactly one valid pretty-printed JSON object
- **AND** the object contains `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`
- **AND** stdout is formatted as two-space pretty JSON with a trailing newline
- **AND** stdout contains no non-JSON diagnostic text
- **AND** `currentAlias` is `null`
- **AND** `workspaceRoot` is an OS-native absolute path
- **AND** `errors` is an array

#### Scenario: Status JSON from inside a source repository
- **WHEN** the user runs `oms status --json` from inside `oms/api/`
- **THEN** the command emits valid JSON
- **AND** `currentAlias` is `api`
- **AND** this remains true even when the configured source repository is not initialized

#### Scenario: Dirty changes expose summary and counts
- **WHEN** the root repository or a configured repo has staged, unstaged, or untracked changes
- **THEN** its status object includes `dirty: true`
- **AND** its `changes` object includes numeric `staged`, `unstaged`, and `untracked` path counts based on `git status --porcelain=v1 -z`
- **AND** a path with both staged and unstaged changes contributes to both counts

#### Scenario: Detached HEAD is represented explicitly
- **WHEN** the root repository or a configured repo is in detached HEAD
- **THEN** its `branch` is `null`
- **AND** its `detached` is `true`
- **AND** its `head` contains the current short SHA

#### Scenario: Missing tracking branch is represented explicitly
- **WHEN** a configured repo has no tracking branch
- **THEN** `trackingBranch`, `ahead`, and `behind` are `null`
- **AND** the command does not report ahead or behind as `0` merely because no comparison base exists

#### Scenario: Tracking branch divergence is numeric
- **WHEN** a configured repo has a tracking branch
- **THEN** `ahead` and `behind` are numbers
- **AND** `0` means the tracking comparison was successful with no commits on that side

#### Scenario: Partial status failure keeps JSON valid
- **WHEN** a repo state cannot be read
- **THEN** stdout still contains valid JSON with the normal repo entry shape
- **AND** unknown scalar repo fields are `null`
- **AND** structured fields such as `changes` preserve their normal object shape with safe default values
- **AND** the repo entry's `error` field contains a concise message
- **AND** top-level `errors` contains a matching summary
- **AND** the process exits non-zero

#### Scenario: Unknown status alias fails before JSON
- **WHEN** the user runs `oms status missing-alias --json`
- **THEN** the command fails with an invalid alias message on stderr
- **AND** stdout does not contain JSON

#### Scenario: Source state without pointers
- **WHEN** a declaration has an initialized independent checkout or a missing checkout
- **THEN** its entry reports identity, initialization, branch, HEAD, detached state, tracking/divergence, dirty counts, and diagnostics when applicable, without any root pointer fields

#### Scenario: Legacy or unrelated checkout is visible
- **WHEN** an alias cannot be used because its path contains a legacy or foreign checkout
- **THEN** status identifies the condition and does not modify the path

#### Scenario: Alias filter is scoped
- **WHEN** the user runs `oms status api --json`
- **THEN** only `api` appears in `repos` and only its source errors are reported, while root and current-alias context remain present

#### Scenario: Status lists only current declarations
- **WHEN** a checkout remains after its source declaration is removed
- **THEN** `oms status` does not add it to the source list, including `repos` in JSON output

### Requirement: Doctor distinguishes undeclared checkout paths
`oms doctor` SHALL report verified former source checkouts separately from undeclared paths whose identity cannot be established. It SHALL NOT change the paths or their Git state.

#### Scenario: Former checkout and unidentified path coexist
- **WHEN** `oms/` contains both a checkout that matches its former declaration and a directory whose source identity cannot be verified
- **THEN** doctor identifies which checkout matches a former declaration and which path remains unidentified
- **AND** it preserves both paths

### Requirement: Shared independent checkout preparation
OMS SHALL use consistent checkout eligibility for source commands. A valid independent checkout needs no provisioning. Only fetch, pull, branch list, branch switch, and branch checkout SHALL offer to provision a missing clone when the request can use a fresh checkout and the user can consent. Diagnostics, `exec`, and tree inventory and removal SHALL NOT prepare sources.

#### Scenario: One provisioning decision for all missing aliases
- **WHEN** an interactive fetch or pull selects several missing aliases
- **THEN** OMS offers to provision them as one decision; accept continues for successful aliases, skip continues without provisioning, and cancel stops before repository operations

#### Scenario: Selection controls the prompt default
- **WHEN** provisioning is offered
- **THEN** an explicit or sole automatically selected target defaults to proceeding, and a whole-workspace or multi-select request defaults to skipping

#### Scenario: Missing checkout without consent
- **WHEN** a command requires existing local work or the session is non-interactive
- **THEN** OMS declines implicit provisioning and gives `oms clone <alias>` guidance

#### Scenario: Foreign, legacy, or unreadable source path
- **WHEN** the checkout cannot be verified as an independent source at the expected alias path
- **THEN** OMS preserves it and reports the reason and the applicable clone, migration, or repair guidance

#### Scenario: Detached commit retained during preparation
- **WHEN** an operation requires attachment and a local branch already points at the current commit
- **THEN** OMS attaches without moving the checkout

#### Scenario: Detached branch choice
- **WHEN** a branch is required and no local branch points at the current commit
- **THEN** OMS offers an informed branch choice interactively, or fails non-interactively with branch guidance without moving the checkout

#### Scenario: Managed tree starts at current commit
- **WHEN** a valid canonical source is detached and the user runs `oms tree add`
- **THEN** OMS leaves the canonical checkout detached and creates the task tree at its current HEAD unless `--from` was requested

### Requirement: Current source alias resolution
For supported single-source commands, explicit aliases SHALL precede current-path inference. Without either, OMS SHALL select from command-eligible aliases, require interaction only when more than one is eligible, and retain the separate explicit-selection rules for destructive branch commands.

#### Scenario: Alias inference uses directory boundaries
- **WHEN** the user runs a supported command from a declared canonical checkout or a descendant
- **THEN** OMS infers its alias only for that path and its descendants, never for a similarly prefixed sibling

#### Scenario: No implicit destructive selection
- **WHEN** the user omits the alias to `oms branch delete` or `oms branch clean`
- **THEN** OMS uses the command’s explicit interactive selection rules rather than inferring the current alias

#### Scenario: Commit candidate selection
- **WHEN** the user invokes `oms commit` without an explicit or inferred alias
- **THEN** OMS uses dirty eligible sources, handles zero as a no-op and one without prompting, and prompts for several only in an interactive session

#### Scenario: No alias inference inside a managed tree
- **WHEN** a canonical-only command is invoked inside a managed tree
- **THEN** OMS refuses before selecting an alias or running a repository operation

### Requirement: Whole-workspace selection for source-set commands
`oms clone`, `oms remove`, `oms fetch`, `oms pull`, `oms push`, and `oms status` SHALL accept explicit alias lists and `--all`. Status SHALL default to all declared aliases. Clone, fetch, pull, and push SHALL offer selection when targets are omitted in a terminal. Remove SHALL always require explicit targets.

#### Scenario: Whole-workspace selection
- **WHEN** the user supplies `--all`
- **THEN** OMS selects all declared aliases without prompting for selection
- **AND** for `oms remove`, OMS also includes verified former source checkouts and still requires authorization

#### Scenario: No set selection without a terminal
- **WHEN** a set command other than status is called without aliases or `--all` non-interactively
- **THEN** OMS fails with selection guidance and performs no source operation

#### Scenario: Explicit subset
- **WHEN** the user supplies aliases without `--all`
- **THEN** OMS operates only on those aliases, which must be declared or, for `oms remove` only, verified former source checkouts

#### Scenario: Clone offers interactive selection
- **WHEN** the user runs `oms clone` without aliases or `--all` in an interactive terminal
- **THEN** OMS offers repository selection and does not provision anything if selection is cancelled

### Requirement: Independent source branch inventory
`oms branch list [alias]` SHALL prepare one selected source when eligible, refresh declared remotes, and display its local and remote branch inventory without moving the checked-out commit.

#### Scenario: Initialized source is selected
- **WHEN** the alias is explicit or is the only eligible candidate
- **THEN** OMS lists its branches without requiring a selection prompt

#### Scenario: Ambiguous source
- **WHEN** more than one eligible source exists and the alias was omitted
- **THEN** OMS prompts interactively or reports ambiguity without changing any repository non-interactively

#### Scenario: Unknown or unavailable source
- **WHEN** the selected alias is unknown or checkout preparation is blocked
- **THEN** OMS reports the failure and gives actionable guidance without overwriting any source path

### Requirement: Source branch listing scope and failures
`oms branch list` SHALL limit its writes to permitted preparation and refresh of the selected source. It SHALL fail only when a useful local inventory cannot be safely produced.

#### Scenario: Local ref inspection fails
- **WHEN** OMS cannot inspect local refs in the prepared selected repository
- **THEN** OMS exits 2
- **AND** identifies the failed inspection and preserved repository state
- **AND** provides a bounded diagnostic or repair action

#### Scenario: Credential-bearing diagnostics are redacted
- **WHEN** a preserved Git diagnostic contains URL userinfo, an embedded token, or another credential-bearing URL component
- **THEN** OMS redacts the credential before displaying the diagnostic
- **AND** retains non-sensitive failure context and actionable guidance

#### Scenario: Degraded remote freshness is not a terminal failure
- **WHEN** local branch inspection succeeds
- **AND** one or more declared remotes are stale or unavailable after automatic retry
- **THEN** OMS prints the usable inventory and explicit degraded states
- **AND** exits 0

#### Scenario: Listing preserves checkout and root state
- **WHEN** branch listing succeeds in a valid source
- **THEN** the root index and HEAD and the source commit do not change

### Requirement: Help documents the independent checkout status contract
`oms status --help` SHALL accurately document the current JSON schema and its version.

#### Scenario: Help lists the top-level payload keys
- **WHEN** the user runs `oms status --help`
- **THEN** the help text names the `schemaVersion` 1 top-level keys `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`

#### Scenario: Versioned status help
- **WHEN** the user reads status help
- **THEN** it identifies the current schema version and no longer documents pointer fields

### Requirement: CLI help documents source command boundaries
Help for changed commands SHALL state their purpose, repository scope, and at least one usage example.



#### Scenario: Source-only help
- **WHEN** the user reads help for `clone`, `remove`, `commit`, `pull`, or `push`
- **THEN** help explains whether the command provisions, removes, or updates a local source and does not instruct pointer recording

### Requirement: Non-destructive source baseline reporting
Branch listing SHALL resolve the declared branch or remote default and report an unknown baseline if resolution fails. It SHALL NOT change the checkout to match a baseline.

#### Scenario: Explicit manifest baseline is flagged
- **WHEN** `oms.yaml` declares a baseline branch for the selected alias
- **THEN** every matching local branch row is marked as baseline
- **AND** OMS does not require `origin/HEAD` to label that manifest baseline

#### Scenario: Omitted baseline refreshes origin default
- **WHEN** `oms.yaml` omits the selected alias's branch
- **AND** origin fetch succeeds
- **THEN** OMS automatically refreshes `origin/HEAD`
- **AND** marks the resolved default's matching local branch as baseline

#### Scenario: Baseline refresh cannot resolve the default
- **WHEN** the manifest omits a branch and OMS cannot refresh or resolve `origin/HEAD`
- **THEN** OMS warns that baseline is `incomplete` when another reliable baseline exists
- **AND** warns that baseline is `unknown` when no reliable baseline exists
- **AND** continues displaying the branch inventory
- **AND** exits 0 when local branch inspection otherwise succeeds

#### Scenario: Failed origin fetch does not trust cached default
- **WHEN** the manifest omits a branch and origin fetch fails after retry
- **AND** a cached `origin/HEAD` exists
- **THEN** OMS does not use the cached symbolic ref as a reliable baseline
- **AND** reports baseline as `incomplete` when another reliable baseline exists
- **AND** reports baseline as `unknown` when no reliable baseline exists

#### Scenario: Reliable baseline has no local branch
- **WHEN** OMS resolves a reliable baseline name that has no matching local branch
- **THEN** no local row is incorrectly flagged
- **AND** the baseline summary reports the unmatched reliable name

### Requirement: Source-only commits
`oms commit <alias> -m <message>` SHALL commit only in the chosen independent source checkout and respect its index for partial commits. It SHALL NOT stage or commit root paths.

#### Scenario: Commit source changes only when nothing is staged
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has changed files but no staged changes
- **THEN** the command runs `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/`
- **AND** the root repository does not receive a new commit
- **AND** unrelated root repository files are not staged
- **AND** the command prints the source repository short commit SHA
- **AND** the command prints the appropriate root follow-up hint, such as `oms record api` when an existing recorded gitlink is moved

#### Scenario: Commit staged source changes only
- **WHEN** `oms/api/` has staged changes and unstaged changes
- **AND** the user runs `oms commit api -m "feat: add login form"`
- **THEN** the command does not run `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/` using only the staged changes
- **AND** the unstaged changes remain unstaged in `oms/api/`
- **AND** the command warns that unstaged changes remain uncommitted
- **AND** the root repository does not receive a new commit

#### Scenario: Commit supports multiple message paragraphs
- **WHEN** the user runs `oms commit api -m "feat: add login" -m "Add callback handling."`
- **THEN** both message paragraphs are passed to the source repository `git commit`

#### Scenario: Commit requires explicit message only for source commits
- **WHEN** `oms/api/` has committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command fails without opening an editor
- **AND** the message explains that `-m` is required to create a source repository commit

#### Scenario: Commit no-op does not require a message
- **WHEN** `oms/api/` has no committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0

#### Scenario: Commit without source changes
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has no committable changes
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Commit attaches a free detached source HEAD
- **WHEN** `oms/api/` is in detached HEAD and a local branch points at exactly the current HEAD commit
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command switches to that branch without changing the working tree contents
- **AND** creates the commit on that branch

#### Scenario: Commit rejects detached source HEAD
- **WHEN** `oms/api/` is in detached HEAD and no local branch points at the current HEAD commit
- **AND** the user runs `oms commit api -m "feat: add login flow"` in a non-interactive shell
- **THEN** the command fails without creating a commit
- **AND** suggests `oms branch switch api <branch>`
- **AND** does not modify the root repository

#### Scenario: Commit rejects in-progress Git operations
- **WHEN** `oms/api/` has a merge, rebase, cherry-pick, revert, bisect, or similar Git operation in progress
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails and instructs the user to resolve, continue, or abort the operation inside `oms/api/`
- **AND** does not modify the root repository

#### Scenario: Missing source cannot be committed
- **WHEN** the alias has no local checkout
- **THEN** OMS refuses and gives `oms clone <alias>` guidance without creating a checkout

### Requirement: Source baseline protection
Explicit manifest branches or the verified remote default SHALL be protected from branch deletion. Unknown baseline state SHALL block deletion, including force.

#### Scenario: Explicit baseline is protected
- **WHEN** the alias declares a branch
- **THEN** both safe and forced deletion refuse to delete that branch

#### Scenario: Remote default is the fallback
- **WHEN** the alias has no declared branch
- **THEN** OMS protects the branch identified by the verified remote default and refuses deletion if it cannot resolve it

### Requirement: Local source branch deletion
`oms branch delete [alias] [branch]` SHALL delete only a local branch in an eligible independent checkout while preserving remote refs, checkout contents, and root Git state.

#### Scenario: Safely delete a local branch
- **WHEN** the user runs `oms branch delete api feature/login`
- **AND** `feature/login` is a deletable local branch in initialized source repository `oms/api/`
- **THEN** the command runs the equivalent of `git branch -d -- feature/login` inside `oms/api/`
- **AND** exits 0
- **AND** reports alias `api`, branch `feature/login`, and the branch's prior short SHA

#### Scenario: Explicit force deletion
- **WHEN** the user runs `oms branch delete api feature/login --force` or `oms branch delete api feature/login -f`
- **AND** `feature/login` passes OMS protected-branch validation
- **AND** its full OID remains unchanged immediately before deletion
- **AND** the command prints the full OID and a POSIX-shell-safe branch recreation command before deletion
- **THEN** the command runs the equivalent of `git branch -D -- feature/login` without first attempting safe deletion
- **AND** does not prompt for confirmation
- **AND** reports that deletion was forced

#### Scenario: Explicit force deletion fails in Git
- **WHEN** the user requests explicit force deletion
- **AND** Git rejects `git branch -D`, including because the branch is checked out in another worktree
- **THEN** the command displays Git's original error
- **AND** exits 2 without another prompt

#### Scenario: Explicit force target moves concurrently
- **WHEN** the final full-OID revalidation detects that the target branch changed after selection
- **THEN** the command does not run `git branch -D`
- **AND** reports that the branch changed concurrently and must be retried
- **AND** exits 2

#### Scenario: Deletion safety state changes concurrently
- **WHEN** a protected baseline or listed source Git-operation marker changes after target selection
- **AND** the change is visible during final validation immediately before safe or force deletion
- **THEN** the command does not run `git branch -d` or `git branch -D`
- **AND** reports the concurrent safety change and exits 2

#### Scenario: Interactive force option skips safe deletion
- **WHEN** the user runs `oms branch delete --force` in an interactive terminal
- **AND** selects alias `api` and branch `feature/login`
- **THEN** the command runs force deletion directly without attempting `git branch -d`

#### Scenario: Unknown alias is rejected
- **WHEN** the user runs `oms branch delete missing feature/login`
- **AND** `missing` is not declared in `oms.yaml`
- **THEN** the command exits 1 with an unknown-alias message
- **AND** does not modify repository state


#### Scenario: Local branch is missing at command start
- **WHEN** the user requests deletion of `feature/missing`
- **AND** no local branch with that name exists before deletion starts
- **THEN** the command exits 1 with a local-branch-not-found message
- **AND** if `origin/feature/missing` exists, the message explains that the command deletes local branches only

#### Scenario: Missing source refuses deletion
- **WHEN** the selected alias has no independent checkout
- **THEN** OMS fails before deleting anything and directs the user to `oms clone <alias>`

### Requirement: Protected branch and source checkout state
OMS SHALL protect the current and baseline branches and refuse unsafe source states while permitting unrelated dirty source files during local branch deletion.

#### Scenario: Current branch is protected
- **WHEN** the user requests deletion of the current branch with or without `--force`
- **THEN** the command exits 1 before running `git branch -d` or `git branch -D`
- **AND** suggests switching to another branch first

#### Scenario: Detached HEAD rejects branch deletion
- **WHEN** the selected source repository is in detached HEAD
- **THEN** the command exits 1 before deleting any branch
- **AND** suggests attaching HEAD with `oms branch switch <alias> <branch>`

#### Scenario: In-progress source Git operation rejects deletion
- **WHEN** the selected source Git directory contains `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, or `sequencer`
- **THEN** the command exits 1 before deleting any branch
- **AND** asks the user to resolve, continue, or abort that operation

#### Scenario: Dirty source worktree does not block deletion
- **WHEN** the selected source repository has modified, staged, or untracked files
- **AND** the target is a different unprotected local branch
- **THEN** the command permits Git to delete the target branch
- **AND** leaves the worktree and index unchanged

#### Scenario: Root repository state does not block deletion
- **WHEN** the root repository is dirty or has a merge, rebase, or similar operation in progress
- **AND** the selected source repository passes its own deletion preconditions
- **THEN** the command permits local source repository branch deletion
- **AND** does not modify root repository state

### Requirement: Safe local checkout removal
`oms remove` SHALL delete only verified local checkouts and SHALL preserve their declarations, the root index, and root history. It SHALL require explicit targets and authorization before deletion. It SHALL refuse foreign, unreadable, or legacy paths and protect local work against loss.

#### Scenario: Clean checkout is removed locally
- **WHEN** the selected clone is safe to remove and removal is explicitly authorized
- **THEN** OMS removes the local checkout, leaves its declaration in place, and does not touch remote or root Git state

#### Scenario: Local work would be lost
- **WHEN** the checkout has known unpublished local history, a stash, or a linked worktree, or an accessible remote does not establish repository recoverability
- **THEN** OMS refuses deletion, including with `--force`, and reports the blocking state

#### Scenario: Removal requires selection and confirmation
- **WHEN** the caller omits both aliases and `--all`, declines the displayed list of checkouts to delete, or runs non-interactively without `--yes`
- **THEN** OMS deletes nothing

#### Scenario: Force applies only to working files
- **WHEN** an otherwise removable checkout has uncommitted, untracked, or ignored files
- **THEN** OMS lists the affected state and refuses unless `--force` and explicit authorization are both present
- **AND** `--force` never overrides repository-history, stash, worktree, or ownership protection

#### Scenario: Foreign or legacy path is preserved
- **WHEN** the selected path cannot be verified as the intended independent checkout
- **THEN** OMS does not remove anything and reports repair or migration guidance

#### Scenario: Already absent
- **WHEN** the selected source has no checkout and no local legacy data
- **THEN** `oms remove` reports a no-op without changing the workspace

### Requirement: Removal can select former source checkouts
`oms remove` SHALL accept a former source checkout only when the latest declaration before its removal can be verified in the current root history and its origin matches that declaration under normal checkout identity rules. Other source commands SHALL continue to use current declarations.

#### Scenario: Former source selected for deletion
- **WHEN** the user names an alias that is no longer declared, but root history and its checkout's origin establish its identity
- **THEN** OMS includes the former checkout in the removal plan and applies the same safeguards as for current sources

#### Scenario: All includes verified former sources
- **WHEN** the user runs `oms remove --all`
- **THEN** the plan distinguishes current sources from verified former source checkouts
- **AND** it separately reports and preserves undeclared paths whose identity cannot be verified

#### Scenario: Explicit former source cannot be verified
- **WHEN** the user explicitly names an undeclared alias whose former declaration is missing or ambiguous, or whose origin does not match that declaration
- **THEN** OMS refuses the selection without deleting anything and explains the missing or conflicting evidence

#### Scenario: Current declaration reuses a former alias
- **WHEN** `oms.yaml` declares an alias for a different origin than the existing checkout, even if the checkout matches an older declaration
- **THEN** neither `oms clone` nor `oms remove` modifies or deletes the checkout
- **AND** OMS explains that the path must be freed without discarding the existing repository

### Requirement: Removal verifies remote recoverability
OMS SHALL check recoverability against current evidence from the declared origin. A local branch need not have a remote branch with the same name if its tip can be recovered from current remote history. A local tag requires a matching name and object on the remote.

#### Scenario: Deleted remote branch was merged
- **WHEN** the remote branch name is gone but the local branch tip is reachable from a current remote ref
- **THEN** the branch does not block deletion
- **AND** the plan names the local branch that will disappear

#### Scenario: Tag is absent or points to another object
- **WHEN** a local tag lacks an identically named remote tag pointing to the same object
- **THEN** OMS refuses deletion even if the tagged commit is reachable

### Requirement: Removal protects commits retained only by reflogs
OMS SHALL protect commits reachable from a checkout's reflogs but not from its current refs or HEAD. It SHALL refuse deletion unless those commits are reachable from current refs at the declared origin. Neither `--force` nor the inaccessible-origin exception SHALL bypass this protection.

#### Scenario: A deleted branch left a commit only in a reflog
- **WHEN** a commit remains reachable only through a reflog and current origin refs cannot recover it
- **THEN** OMS refuses removal, identifies the affected commit, and explains how to preserve it outside the checkout

#### Scenario: A reflog-only commit remains recoverable
- **WHEN** current origin history contains every commit reachable only through local reflogs
- **THEN** reflog history does not block normal deletion if the other safeguards pass

#### Scenario: Origin is inaccessible and reflog-only history remains
- **WHEN** a checkout contains a reflog-only commit and origin access fails
- **THEN** OMS refuses deletion without offering the typed-alias exception

### Requirement: Removal when the origin is inaccessible
When origin access fails, OMS SHALL allow removing one explicitly named checkout only after a separate interactive confirmation that requires typing the alias. This exception waives verification of remote recoverability only; it SHALL NOT override another blocking state.

#### Scenario: Repository was removed or access was revoked
- **WHEN** the declared origin cannot be accessed and the named checkout passes every other safety check
- **THEN** OMS warns that the local copy may be the only recoverable copy and requires the user to type the exact alias before deletion
- **AND** OMS names the local branches and tags that will disappear

#### Scenario: Exception cannot be automated or applied to a batch
- **WHEN** the origin cannot be accessed and the caller uses `--all`, names multiple aliases, or cannot provide interactive confirmation
- **THEN** OMS preserves every selected checkout
- **AND** neither `--yes` nor `--force` supplies the required confirmation

#### Scenario: Other safety checks still apply
- **WHEN** the origin is inaccessible but OMS has evidence of unpublished local history, or detects a stash, linked worktree, ownership mismatch, or another blocking state
- **THEN** OMS refuses deletion without offering an override for that state

#### Scenario: Local history exceeds the last known upstream
- **WHEN** origin is inaccessible and a local branch contains a commit absent from its last known upstream from that origin
- **THEN** OMS refuses exception deletion and identifies the affected branch

#### Scenario: A branch has no tracking target
- **WHEN** origin is inaccessible and a local branch has no configured upstream
- **THEN** OMS does not treat the missing configuration alone as evidence of unpublished history
- **AND** all other safety checks and the separate typed confirmation still apply

### Requirement: Removal preflights the entire selection
OMS SHALL inspect the whole selection and report the deletion plan before deleting anything. If an eligible target fails a safety check, no selected checkout SHALL be removed. OMS SHALL stop remaining deletions if a selected checkout changes during execution and report any completed removals without claiming rollback.

#### Scenario: A batch contains a blocked checkout
- **WHEN** `oms remove --all` finds one safe checkout and another with a stash
- **THEN** OMS preserves both and identifies the blocked checkout

#### Scenario: A selected checkout changes after confirmation
- **WHEN** OMS has already removed one checkout and a remaining target no longer matches its approved state
- **THEN** OMS preserves the changed and remaining checkouts, reports completed and unattempted targets, and exits nonzero

### Requirement: Independent source agent instruction content
The managed instruction block SHALL identify the workspace root and independent sources as separate Git scopes and defer specifics to command help.

#### Scenario: Agent works on a declared source
- **WHEN** the agent reads the managed block
- **THEN** it sees guidance to inspect `oms status --json`, distinguish root from sources, and commit or push in the intended repository without recording a root pointer

### Requirement: Source-only pull and push
`oms pull` and `oms push` SHALL synchronize the selected source repository only. Pull SHALL retain its fast-forward policy. Neither command shall stage or commit root files.

#### Scenario: Pull does not stage or commit the root index
- **WHEN** the user runs `oms pull api`
- **THEN** the command pulls the current `api` source repository branch according to the existing fast-forward policy
- **AND** does not stage the root index
- **AND** does not create a root repository commit

#### Scenario: Pull rejects dirty source repository source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms pull api`
- **THEN** the command fails before running pull
- **AND** the message asks the user to commit, stash, or clean changes inside `oms/api`

#### Scenario: Push does not stage or commit the root index
- **WHEN** the user runs `oms push api`
- **THEN** the command pushes the current `api` source repository branch
- **AND** does not stage the root index
- **AND** does not create a root repository commit

#### Scenario: Push warns for dirty source repository source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms push api`
- **THEN** the command warns that only the current HEAD will be pushed
- **AND** the command does not auto-commit source changes

#### Scenario: Pull and push attach a free detached source HEAD
- **WHEN** `oms/api` is in detached HEAD and a local branch points at exactly the current HEAD commit
- **AND** the user runs `oms pull api` or `oms push api`
- **THEN** the command switches to that branch without changing the working tree contents
- **AND** performs the requested pull or push on that branch

#### Scenario: Push rejects detached source HEAD
- **WHEN** `oms/api` is in detached HEAD and no local branch points at the current HEAD commit
- **AND** the user runs `oms push api` in a non-interactive shell
- **THEN** the command fails and suggests `oms branch switch api <branch>`
- **AND** the command does not stage or commit the root index

#### Scenario: Pull rejects detached source HEAD
- **WHEN** `oms/api` is in detached HEAD and no local branch points at the current HEAD commit
- **AND** the user runs `oms pull api` in a non-interactive shell
- **THEN** the command fails and suggests `oms branch switch api <branch>`
- **AND** the command does not stage or commit the root index

#### Scenario: Multi-alias pull and push process aliases independently
- **WHEN** the user runs `oms push api web` or `oms pull api web`
- **THEN** the command processes aliases independently
- **AND** continues processing later aliases after one alias fails
- **AND** exits non-zero if any alias operation fails
- **AND** prints a final summary of per-alias results

#### Scenario: Pull and push leave root paths alone
- **WHEN** a source pull or push succeeds
- **THEN** OMS provides no root pointer-recording hint and does not modify the root index or history

### Requirement: Independent checkout eligibility for branch cleanup
Cleanup SHALL require a verified independent checkout and SHALL NOT provision missing repositories. It SHALL refuse managed-tree execution, in-progress source Git operations, and a detached HEAD rather than infer a branch from root state.

#### Scenario: Clean target is missing or invalid
- **WHEN** the alias lacks a usable independent checkout
- **THEN** OMS stops without cloning or deleting anything and gives setup or recovery guidance

#### Scenario: Unsafe source state
- **WHEN** the source is detached or has an in-progress Git operation, or invocation is inside a managed tree
- **THEN** OMS refuses before deleting local branches

### Requirement: Revalidated branch cleanup in independent checkouts
Cleanup SHALL recheck selected declaration, checkout identity, ref types and commits, protection, occupancy, source preconditions, and ancestry before deletion. Candidate identity SHALL be name plus commit ID. Changed tips SHALL preserve candidates; changed base or selected context, or unreliable shared safety, SHALL stop remaining work. Deletion SHALL atomically verify confirmed commits without force retries; ref-type and occupancy checks are not atomic.

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

#### Scenario: Selected declaration, or checkout identity changes
- **WHEN** final revalidation detects a change to the selected repository's declaration, or the identity of the independent checkout after confirmation
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

### Requirement: Empty branch cleanup reporting for independent checkouts
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

#### Scenario: Limited history prevents proving ancestry
- **WHEN** limited shallow history prevents proving a topic branch's ancestry and no candidates remain
- **THEN** cleanup retains a concise history-limitation diagnostic with explicit deepen-or-repair guidance
- **AND** preserves the branch without claiming it is definitively unmerged
- **AND** does not print the full deletion plan or concurrency warning

#### Scenario: Inspection fails before an empty result can be established
- **WHEN** the comparison base, source safety, baseline metadata, refs, worktree occupancy, or ancestry cannot be inspected reliably
- **THEN** cleanup reports the failure with the existing nonzero exit behavior and applicable recovery guidance
- **AND** does not replace the failure with a successful no-op summary

## MODIFIED Requirements

### Requirement: Cleanup results and repository boundaries
Cleanup SHALL report deleted, already-absent, preserved, failed, and not-run candidates, with config-cleanup status for completed deletions. Successful batches SHALL exit 0; incomplete batches, including config failures, SHALL exit 2 without rollback. Under the concurrency restriction, cleanup SHALL preserve remote refs, source HEAD/files/index, and root tracked state. Results SHALL provide recovery, rerun, or repair guidance.

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
- **AND** no root path is staged or committed

### Requirement: Concise branch cleanup help
`oms branch clean --help` SHALL prioritize usage, arguments, options, two examples, and brief base and confirmation guidance. It SHALL identify local-only deletion, the default comparison base, no automatic ref refresh, and interactive deletion confirmation. Detailed safety and recovery rules SHALL remain reachable through the existing documentation link rather than inline help sections.

#### Scenario: Quick usage lookup
- **WHEN** the user runs `oms branch clean --help`
- **THEN** help presents the alias argument and `--base` option followed by examples for the default base and an explicit remote-tracking base
- **AND** examples precede supplemental guidance
- **AND** the command purpose is not repeated in appended prose
- **AND** help exits 0 without inspecting or preparing a source repository

#### Scenario: Essential conditions stay visible
- **WHEN** the user reads cleanup help
- **THEN** brief guidance explains local-only deletion with interactive confirmation, the configured local branch or cached `origin/HEAD` default, and no automatic ref refresh
- **AND** help links to the existing merged-branch-cleanup safety documentation

#### Scenario: Detailed rules do not fill quick help
- **WHEN** the user runs cleanup help
- **THEN** it does not append long safety or result sections, detailed concurrency and transaction limitations, an exit-code table, or the generic workspace-discovery explanation
- **AND** the linked documentation continues to describe those detailed rules
- **AND** no new verbose-help flag or other CLI option is introduced

## REMOVED Requirements

### Requirement: Explicit root pointer records
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Multi-alias root pointer records
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Existing submodule metadata reconciliation
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Sync restores pending submodule removals
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Root topology actions share a consistent safety preflight
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Root topology finalization
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Internal refactors preserve submodule workflow behavior
**Reason**: Normal source commands no longer register submodules or coordinate root pointers.
**Migration**: Use `oms clone` for missing independent checkouts and `oms pull` for source updates; explicitly migrate any legacy OMS registrations before use.

### Requirement: Machine-readable workspace status
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Versioned independent checkout status.

### Requirement: Shared alias preparation across commands
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Shared independent checkout preparation.

### Requirement: Current submodule alias resolution
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Current source alias resolution.

### Requirement: Whole-workspace selection for submodule-set commands
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Whole-workspace selection for source-set commands.

### Requirement: Submodule branch inventory
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Independent source branch inventory.

### Requirement: Branch list scope and actionable failures
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Source branch listing scope and failures.

### Requirement: Help documents the status JSON field contract
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Help documents the independent checkout status contract.

### Requirement: CLI help documents new workflow boundaries
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, CLI help documents source command boundaries.

### Requirement: Non-destructive baseline reporting
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Non-destructive source baseline reporting.

### Requirement: Submodule-only commits
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Source-only commits.

### Requirement: Baseline branch resolution and protection
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Source baseline protection.

### Requirement: Local submodule branch deletion
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Local source branch deletion.

### Requirement: Protected branch and repository state
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Protected branch and source checkout state.

### Requirement: Unsync preserves unsafe topology guardrails
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Safe local checkout removal.

### Requirement: Agent instruction content
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Independent source agent instruction content.

### Requirement: Pull and push submodule-only synchronization
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Source-only pull and push.

### Requirement: Cleanup repository preparation
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Independent checkout eligibility for branch cleanup.

### Requirement: Revalidated local cleanup execution
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Revalidated branch cleanup in independent checkouts.

### Requirement: Contextual empty cleanup reporting
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Empty branch cleanup reporting for independent checkouts.

