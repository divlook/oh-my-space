## ADDED Requirements

### Requirement: Interactive branch action selection
The system SHALL provide an `oms branch` command group that exposes supported branch-management actions without moving the existing top-level `oms switch` and `oms checkout` commands.

#### Scenario: Interactive branch command selects an action
- **WHEN** the user runs `oms branch` in an interactive terminal
- **THEN** the command presents the supported branch actions even when `delete` is the only action
- **AND** selecting `delete` continues into the `oms branch delete` interaction

#### Scenario: Branch action selection is cancelled
- **WHEN** the user cancels the action selector opened by `oms branch`
- **THEN** the command exits 1 without modifying any submodule or root repository state

#### Scenario: Branch command without action is non-interactive
- **WHEN** the user runs `oms branch` in a non-interactive shell
- **THEN** the command prints branch command help
- **AND** exits 1 without modifying repository state

### Requirement: Local submodule branch deletion
The system SHALL provide `oms branch delete [alias] [branch]` to delete one local branch in one initialized or safely auto-initializable registered submodule while preserving remote refs, deletion-phase worktree contents, and root tracked topology.

#### Scenario: Safely delete a local branch
- **WHEN** the user runs `oms branch delete api feature/login`
- **AND** `feature/login` is a deletable local branch in initialized submodule `oms/api/`
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
- **WHEN** a protected baseline or listed submodule Git-operation marker changes after target selection
- **AND** the change is visible during final validation immediately before safe or force deletion
- **THEN** the command does not run `git branch -d` or `git branch -D`
- **AND** reports the concurrent safety change and exits 2

#### Scenario: Interactive force option skips safe deletion
- **WHEN** the user runs `oms branch delete --force` in an interactive terminal
- **AND** selects alias `api` and branch `feature/login`
- **THEN** the command runs force deletion directly without attempting `git branch -d`

#### Scenario: Deletion remains local and pointer-neutral
- **WHEN** deletion preconditions have been resolved for an initialized submodule and a local branch is deleted successfully
- **THEN** the deletion phase does not fetch, push, or prune a remote
- **AND** does not delete a same-named remote or remote-tracking ref
- **AND** does not change, stage, or commit the root gitlink or any root path
- **AND** does not print an `oms record` hint

#### Scenario: Unknown alias is rejected
- **WHEN** the user runs `oms branch delete missing feature/login`
- **AND** `missing` is not declared in `oms.yaml`
- **THEN** the command exits 1 with an unknown-alias message
- **AND** does not modify repository state

#### Scenario: Registered uninitialized alias is initialized automatically
- **WHEN** the user runs `oms branch delete api feature/login`
- **AND** `api` is declared and registered by the root gitlink and `.gitmodules` but its worktree is not initialized
- **THEN** the command initializes only `api`
- **AND** revalidates branch existence, current state, and every protected baseline after initialization
- **AND** continues deletion without requiring a separate `oms sync` invocation
- **AND** does not create or commit root topology
- **AND** may access only `api`'s registered remote and update local submodule config and `oms/api` worktree state

#### Scenario: Root-gitlink-anchored detached HEAD is safe across retries
- **WHEN** `api` is at detached HEAD
- **AND** detached HEAD equals the root-recorded `oms/api` gitlink
- **THEN** OMS treats that recorded commit as the durable current anchor across invocations
- **AND** does not attach or move HEAD
- **AND** still rejects deletion of every protected baseline

#### Scenario: Automatic initialization fails
- **WHEN** Git fails while automatically initializing registered alias `api`
- **THEN** the command exits 2 with Git's original error
- **AND** does not attempt branch deletion
- **AND** preserves Git's resumable partial initialization state without deleting fetched data

#### Scenario: Validation fails after automatic initialization
- **WHEN** registered alias initialization succeeds
- **AND** later branch or baseline validation rejects deletion
- **THEN** the command does not run branch deletion
- **AND** preserves the initialized worktree and local config as safe resumable preparation state
- **AND** does not create root topology or a root commit

#### Scenario: Unregistered alias cannot be auto-initialized for deletion
- **WHEN** the user runs `oms branch delete api feature/login`
- **AND** `api` is declared but has no root gitlink or `.gitmodules` registration
- **THEN** the command exits 1 with targeted `oms sync api` guidance
- **AND** does not create root topology because no local submodule branch can yet be validated

#### Scenario: Local branch is missing at command start
- **WHEN** the user requests deletion of `feature/missing`
- **AND** no local branch with that name exists before deletion starts
- **THEN** the command exits 1 with a local-branch-not-found message
- **AND** if `origin/feature/missing` exists, the message explains that the command deletes local branches only

### Requirement: Interactive branch delete input selection
The system SHALL collect omitted delete inputs interactively in alias-then-branch order without inferring or auto-selecting destructive targets.

#### Scenario: Alias is always selected when omitted
- **WHEN** the user runs `oms branch delete` in an interactive terminal
- **THEN** the command presents initialized aliases even when invoked inside `oms/api/`
- **AND** presents the selector even when only one initialized alias is available

#### Scenario: No initialized aliases are available
- **WHEN** the user runs `oms branch delete` interactively
- **AND** no declared alias has an initialized submodule
- **THEN** the command exits 1
- **AND** suggests running `oms sync`

#### Scenario: Branch selector shows protected branches
- **WHEN** an initialized alias is selected and the branch argument is omitted
- **THEN** the command presents all local branches in ascending name order
- **AND** current and baseline branches are visible but disabled with their protection reasons
- **AND** a branch that is both current and baseline shows both reasons

#### Scenario: Sole deletable branch still requires selection
- **WHEN** exactly one deletable local branch is available
- **AND** the branch argument is omitted
- **THEN** the command presents the branch selector instead of automatically choosing that branch

#### Scenario: No deletable local branches are available
- **WHEN** an interactively selected submodule has no local branch other than protected branches
- **THEN** the command reports the protected branches and reasons
- **AND** exits 0 without opening a branch selector

#### Scenario: Interactive selection is cancelled
- **WHEN** the user cancels either the alias selector or branch selector
- **THEN** the command exits 1 without running a branch deletion or modifying root repository state

#### Scenario: Omitted delete input is non-interactive
- **WHEN** the user omits a required alias or branch in a non-interactive shell
- **THEN** the command exits 1 with a message identifying the missing argument
- **AND** does not select an alias or branch implicitly

#### Scenario: Selection immediately attempts safe deletion
- **WHEN** the user selects a deletable branch without supplying `--force`
- **THEN** the command attempts safe deletion without an additional confirmation prompt

### Requirement: Guarded deterministic prompt responses
The system SHALL expose deterministic prompt responses only when `OMS_TEST_MODE=1` and `OMS_TEST_PROMPT_RESPONSES` are both set, without changing normal interactive behavior.

#### Scenario: Typed test responses drive prompts
- **WHEN** `OMS_TEST_MODE=1` and `OMS_TEST_PROMPT_RESPONSES` contains a JSON array
- **THEN** each entry is one of `{"type":"select","value":"..."}`, `{"type":"confirm","value":true|false}`, or `{"type":"cancel"}`
- **AND** the queue supplies responses in prompt order even when stdin is not a TTY
- **AND** no real prompt is opened

#### Scenario: Invalid test response configuration fails closed
- **WHEN** the queue JSON is malformed, an entry has an unknown shape, its type does not match the next prompt, or responses remain at command completion
- **THEN** the command exits 1 without falling back to a real prompt

#### Scenario: Prompt injection is disabled normally
- **WHEN** either `OMS_TEST_MODE=1` or `OMS_TEST_PROMPT_RESPONSES` is absent
- **THEN** the command ignores injected responses
- **AND** uses normal TTY detection and prompt behavior

### Requirement: Interactive force escalation
The system SHALL offer a one-time force-deletion retry after any failed safe deletion when the target local branch remains.

#### Scenario: Force retry prompt contains decision context
- **WHEN** `git branch -d` fails in an interactive terminal and the target branch remains
- **THEN** the command displays Git's original error
- **AND** asks whether to force-delete the branch
- **AND** includes the alias, branch, prior full OID, and local-commit-loss warning
- **AND** defaults the confirmation to No

#### Scenario: User accepts force retry
- **WHEN** the user accepts the force-deletion prompt
- **AND** the branch full OID remains unchanged immediately before deletion
- **THEN** the command prints the full OID and POSIX-shell-safe recreation command before retrying once with the equivalent of `git branch -D`
- **AND** a successful retry exits 0 and reports forced deletion

#### Scenario: Force retry target moves concurrently
- **WHEN** the user accepts the force-deletion prompt
- **AND** the final full-OID revalidation detects that the branch changed while the prompt was open
- **THEN** the command does not run `git branch -D`
- **AND** reports the concurrent change and exits 2

#### Scenario: User declines or cancels force retry
- **WHEN** safe deletion has failed
- **AND** the user declines or cancels the force-deletion prompt
- **THEN** the target branch remains intact
- **AND** the command exits 2 without another deletion attempt

#### Scenario: Safe deletion fails non-interactively
- **WHEN** safe deletion fails in a non-interactive shell and the target branch remains
- **THEN** the command displays Git's original error without prompting
- **AND** prints the complete retry command `oms branch delete <alias> <branch> --force` with dynamic arguments quoted using POSIX shell single-quote escaping
- **AND** exits 2

#### Scenario: Force retry is attempted only once
- **WHEN** the user accepts the force-deletion prompt
- **AND** Git rejects force deletion, including because the branch is checked out in another worktree
- **THEN** the command reports the final Git failure
- **AND** exits 2 without prompting again

#### Scenario: Branch disappears after safe deletion failure
- **WHEN** safe deletion fails
- **AND** the target branch no longer exists when OMS rechecks it
- **THEN** the command reports that the branch no longer exists
- **AND** exits 0 without offering force deletion

### Requirement: Protected branch and repository state
The system SHALL protect current and baseline branches, reject unsafe submodule states, and leave unrelated dirty state independent from local branch deletion.

#### Scenario: Current branch is protected
- **WHEN** the user requests deletion of the current branch with or without `--force`
- **THEN** the command exits 1 before running `git branch -d` or `git branch -D`
- **AND** suggests switching to another branch first

#### Scenario: Detached HEAD rejects branch deletion
- **WHEN** the selected submodule is in detached HEAD
- **AND** it differs from the root-recorded gitlink or no root gitlink exists
- **THEN** the command exits 1 before deleting any branch
- **AND** suggests attaching HEAD with `oms switch <alias> <branch>`

#### Scenario: In-progress submodule Git operation rejects deletion
- **WHEN** the selected submodule Git directory contains `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, or `sequencer`
- **THEN** the command exits 1 before deleting any branch
- **AND** asks the user to resolve, continue, or abort that operation

#### Scenario: Dirty submodule worktree does not block deletion
- **WHEN** the selected submodule has modified, staged, or untracked files
- **AND** the target is a different unprotected local branch
- **THEN** the command permits Git to delete the target branch
- **AND** leaves the worktree and index unchanged

#### Scenario: Root repository state does not block deletion
- **WHEN** the root repository is dirty or has a merge, rebase, or similar operation in progress
- **AND** the selected submodule passes its own deletion preconditions
- **THEN** the command permits local submodule branch deletion
- **AND** does not modify root repository state

### Requirement: Baseline branch resolution and protection
The system SHALL resolve every applicable declared, registered, or default baseline before deletion and SHALL NOT allow force to bypass baseline protection.

#### Scenario: Explicit manifest baseline is protected
- **WHEN** `oms.yaml` declares `develop` as the branch for alias `api`
- **THEN** local branch `develop` is disabled in interactive selection
- **AND** an explicit request to delete it exits 1 before running Git
- **AND** `origin/HEAD` is not separately protected unless `.gitmodules` records a different branch

#### Scenario: Omitted manifest branch protects remote default
- **WHEN** `oms.yaml` omits branch for alias `api`
- **AND** local `origin/HEAD` resolves to `origin/main`
- **THEN** local branch `main` is protected as the baseline

#### Scenario: Baseline cannot be resolved
- **WHEN** `oms.yaml` omits branch and `origin/HEAD` cannot be resolved
- **THEN** the command exits 1 before presenting or deleting a branch
- **AND** asks the user to declare branch in `oms.yaml` or repair origin HEAD

#### Scenario: Manifest and registered baselines differ
- **WHEN** `oms.yaml` and `.gitmodules` identify different baseline branches
- **THEN** the command warns about metadata drift
- **AND** protects both baseline branches
- **AND** still permits deletion of another unprotected local branch

#### Scenario: Root metadata versions disagree
- **WHEN** worktree, index, conflict-stage, or `HEAD` versions of `.gitmodules` record different branches for the selected alias
- **THEN** the command protects the union of every reliably parsed branch
- **AND** warns about metadata drift
- **AND** still permits deletion of an unrelated unprotected branch

#### Scenario: Applicable root metadata versions are enumerated
- **WHEN** OMS resolves registered baselines for the selected alias
- **THEN** it reads the existing worktree `.gitmodules`, index stage 0 or every present unmerged stage 1-3, and the `HEAD` blob when present
- **AND** an absent version contributes no baseline and is not an error

#### Scenario: Applicable baseline metadata is unreadable or malformed
- **WHEN** an applicable `.gitmodules` version cannot be read, has invalid Git config syntax, has duplicate selected-alias sections, or has multiple path or branch values for the selected alias
- **THEN** the command exits 1 before presenting or deleting a branch
- **AND** identifies the metadata version that must be repaired

#### Scenario: Force does not bypass baseline protection
- **WHEN** the user supplies `--force` for any resolved baseline branch
- **THEN** the command exits 1 without deleting that branch

### Requirement: Existing submodule metadata reconciliation
The system SHALL reconcile an existing or restored selected submodule's OMS-managed `.gitmodules` URL and branch metadata from `oms.yaml` after topology mutation and baseline validation, then include successful plans in the same root commit-or-unstage finalization as successful topology.

#### Scenario: User-owned Gitmodules state is rejected before mutation
- **WHEN** `.gitmodules` is unmerged, the root has an in-progress Git operation, or a pre-staged selected OMS path differs in blob or mode from its validated commit result
- **THEN** sync exits 1 before changing any root path
- **AND** does not commit, unstage, or overwrite the user-owned mismatched state
- **AND** an exact-matching pre-staged selected OMS path may be consumed by the requested or accepted sync commit
- **AND** unrelated staged root paths alone do not block path-limited OMS finalization

#### Scenario: Explicit branch is validated after fetch
- **WHEN** the user syncs an initialized existing alias whose `oms.yaml` entry declares branch `develop`
- **THEN** sync first sets the local origin URL from that alias's `oms.yaml` `remotes.origin` and fetches it before reconciliation
- **AND** verifies that `origin/develop` exists
- **AND** fails without changing `.gitmodules` when the branch does not exist

#### Scenario: Manifest origin overrides URL drift
- **WHEN** the selected alias's `oms.yaml` `remotes.origin`, local `remote.origin.url`, and `.gitmodules` URL differ
- **THEN** sync uses `oms.yaml` `remotes.origin` as the fetch URL
- **AND** reconciles both the local origin and `.gitmodules` URL to that manifest value
- **AND** neither previous URL takes precedence

#### Scenario: Omitted branch refreshes remote default
- **WHEN** the user syncs an initialized existing alias whose `oms.yaml` entry omits branch
- **THEN** sync fetches origin and refreshes `origin/HEAD` from the remote
- **AND** fails with guidance to declare branch when the current remote default cannot be resolved

#### Scenario: Managed metadata is reconciled from manifest
- **WHEN** baseline validation succeeds for an initialized existing alias
- **AND** topology mutation for selected aliases is complete
- **THEN** sync sets that alias's `.gitmodules` URL to the declared origin URL
- **AND** sets an explicit declared branch or removes the `.gitmodules` branch key when branch is omitted
- **AND** overwrites manual drift in those managed values while preserving unrelated sections and keys

#### Scenario: Reconciliation preserves current working branch
- **WHEN** metadata reconciliation changes the baseline while the submodule is attached to another branch
- **THEN** sync does not switch the current working branch

#### Scenario: Reconciled metadata follows the root finalization decision
- **WHEN** sync changes `.gitmodules` URL or branch metadata for an existing submodule
- **AND** `--commit` was requested or the user accepts the default-Yes commit prompt
- **THEN** sync includes successful aliases' metadata and topology in the same path-limited OMS commit
- **AND** sync reports the changed fields
- **AND** does not print old or new URL values

#### Scenario: No-commit result remains unstaged
- **WHEN** metadata reconciliation succeeds without a requested or accepted commit
- **THEN** sync unstages its successful topology and metadata paths
- **AND** leaves the working-tree changes intact as the explicit no-commit result

#### Scenario: Metadata-only interactive sync offers automatic completion
- **WHEN** interactive sync has metadata drift but no pending topology and `--commit` was not supplied
- **THEN** sync offers the same default-Yes root commit decision
- **AND** an accepted decision commits the reconciled metadata without requiring a second command

#### Scenario: Fetch failure does not reconcile metadata
- **WHEN** origin fetch fails for an initialized existing submodule
- **THEN** sync does not newly modify `.gitmodules` metadata for that alias

#### Scenario: Metadata uses the post-topology snapshot
- **WHEN** one sync invocation has both pending topology changes and existing-submodule metadata drift
- **THEN** sync completes topology mutation before taking the metadata snapshot
- **AND** applies metadata reconciliation before the root commit-or-unstage decision
- **AND** does not treat expected topology edits as concurrent modification
- **AND** finalizes successful topology and metadata together

#### Scenario: Topology boundary detects concurrent edits
- **WHEN** actual `.gitmodules` content after topology mutation differs from applying the selected aliases' expected topology delta to the pre-topology snapshot
- **THEN** sync does not apply metadata or finalize a root commit
- **AND** preserves the concurrent content and exits 2

#### Scenario: Finalization boundary detects concurrent edits
- **WHEN** root `HEAD`, real index, `oms.yaml`, `.gitmodules`, or a selected gitlink differs from the expected snapshot immediately before root finalization
- **THEN** sync does not create the OMS commit
- **AND** may revalidate once only before any root commit when the new state produces the same safe plan
- **AND** otherwise preserves the concurrent state and exits 2

#### Scenario: Working-tree manifest is captured and revalidated
- **WHEN** sync plans a requested or accepted root commit
- **THEN** it captures the exact working-tree `oms.yaml` bytes and hash during planning
- **AND** revalidates them immediately before finalization and immediately before invoking Git commit
- **AND** stages the captured bytes rather than re-reading the path
- **AND** a detected change triggers at most one full revalidation before any root commit or exits 2 without committing user edits

#### Scenario: Root commit fails after reconciliation
- **WHEN** metadata reconciliation succeeds but the path-limited OMS commit fails
- **AND** `HEAD` has not advanced
- **THEN** sync does not create a partial OMS commit
- **AND** preserves the real index byte-for-byte while retaining OMS working-tree changes
- **AND** exits 2 with the original Git error and exact `oms sync --commit` retry guidance

#### Scenario: Multi-alias validation partially fails
- **WHEN** a multi-alias sync successfully validates `api` but fetch or baseline validation fails for `web`
- **THEN** the metadata plan includes `api` and excludes `web`
- **AND** `sync --commit` uses a temporary index to commit `api` topology and metadata without including `web` or unrelated working-tree changes
- **AND** sync exits 2 with an alias-level summary after finalizing the successful alias

#### Scenario: Plain partial sync remains unstaged
- **WHEN** a plain or interactive multi-alias sync partially fails without `--commit`
- **THEN** sync does not open the root commit prompt
- **AND** leaves successful aliases' OMS changes unstaged

#### Scenario: Temporary commit index preserves the real index
- **WHEN** sync creates a requested or accepted commit
- **THEN** its owner-only temporary index starts from the verified `HEAD`
- **AND** contains a `.gitmodules` synthesized from `HEAD` by applying only successful aliases' OMS-managed topology and `path`, `url`, and `branch` fields
- **AND** preserves unrelated keys from `HEAD` without copying unrelated working-tree edits
- **AND** stages only successful alias gitlinks and the complete current `oms.yaml`
- **AND** atomically refreshes the real index against the new `HEAD` without losing pre-existing staged entries other than intentionally consumed `oms.yaml` and exact-matching committed OMS paths

#### Scenario: Every sync commit includes its declarative manifest
- **WHEN** a requested or accepted sync commit will be created
- **AND** current `oms.yaml` differs from `HEAD`
- **THEN** the commit includes the complete current working-tree `oms.yaml` rather than its staged blob
- **AND** this intentionally includes failed-alias declarations and other current manifest edits
- **AND** consumes prior `oms.yaml` staging while preserving other staged paths
- **AND** output identifies the complete inclusion and staging consumption before the commit is created

#### Scenario: Real index changes before temporary commit
- **WHEN** the real index differs from its planning snapshot before or after OMS acquires the index lock
- **THEN** sync does not create the commit
- **AND** revalidates once or exits 2 while preserving the changed index

#### Scenario: Real index installation fails after commit
- **WHEN** the temporary-index commit advances `HEAD`
- **AND** atomically installing the prepared replacement real index fails
- **THEN** OMS retries the atomic installation once and leaves the original real index intact if both attempts fail
- **AND** retains the prepared replacement as an owner-only recovery index with a marker containing the created commit OID and original index hash
- **AND** exits 2 without printing an unconditional index-overwrite command

#### Scenario: Commit intent is durable before HEAD can advance
- **WHEN** OMS is ready to invoke the temporary-index commit
- **THEN** it first writes and fsyncs an owner-only intent marker containing original `HEAD`, original index hash, planned tree, and temporary and recovery index paths
- **AND** fsyncs the marker directory before creating finalization artifacts or invoking Git commit
- **AND** after commit atomically records and fsyncs the created commit OID before real-index installation

#### Scenario: Every root-mutating command runs recovery preflight
- **WHEN** `sync` or `unsync` can mutate root topology or metadata, or the user runs `record`
- **THEN** OMS runs the shared intent and recovery preflight before any root mutation
- **AND** cleans unchanged prepared state, validates recorded parent and tree before promotion, and installs committed recovery only while the locked `HEAD` and real-index hash match
- **AND** preserves and blocks on mismatched state, a malformed marker, or an owner-namespaced orphan artifact with comparison guidance

#### Scenario: Record recovers or blocks before pointer finalization
- **WHEN** the user runs `oms record <alias>` and durable finalization state exists
- **THEN** OMS completes the same verified recovery preflight before staging or committing the root gitlink
- **AND** continues record only after automatic cleanup or recovery succeeds
- **AND** preserves root and index state and exits non-zero with comparison guidance when the state is mismatched, malformed, or orphaned

#### Scenario: Prepared intent is recovered after interruption
- **WHEN** a later OMS root-finalization command finds a prepared intent marker
- **AND** `HEAD` and the real-index hash still equal the recorded originals
- **THEN** OMS removes the uncommitted temporary state and continues automatically
- **AND** when `HEAD` advanced, OMS promotes the marker to committed recovery only if the new commit has the recorded original parent and planned tree
- **AND** otherwise preserves the state and exits with comparison guidance

#### Scenario: Unchanged index recovery is automatic
- **WHEN** a later OMS root-finalization command finds a recovery marker
- **AND** current `HEAD` and the locked real-index hash match the marker
- **THEN** OMS atomically installs the recovery index, removes the marker, and continues without user intervention
- **AND** when either value differs, OMS preserves both indexes and exits with comparison guidance

#### Scenario: Temporary index resources are cleaned safely
- **WHEN** temporary-index finalization succeeds, fails before commit, or receives an interrupt
- **THEN** OMS removes temporary indexes and only locks owned by the current process
- **AND** after `HEAD` has advanced it retains the recovery index and marker until installation succeeds
- **AND** a later OMS invocation detects and reports that recoverable state before another root finalization
- **AND** owner-namespaced orphan artifacts without a valid marker are preserved and reported instead of being installed or deleted

#### Scenario: Root state blocks metadata application
- **WHEN** the root has an in-progress Git operation, `.gitmodules` is unmerged, or a staged selected OMS path does not exactly match its validated result before root mutation
- **THEN** sync does not apply the metadata batch
- **AND** does not mutate topology
- **AND** exits 1 with guidance to resolve the user-owned root state

#### Scenario: Metadata batch is atomic
- **WHEN** one or more successful aliases have planned metadata changes
- **THEN** sync computes every transformation in a same-directory owner-only temporary file
- **AND** replaces `.gitmodules` only after every transformation succeeds
- **AND** keeps the temporary file owner-only until replacement
- **AND** restores the original `.gitmodules` file mode immediately after successful replacement
- **AND** preserves unrelated content and formatting

#### Scenario: Side-effect-free metadata file application retries once
- **WHEN** temporary-file serialization, write, or atomic replacement fails without changing the original snapshot
- **THEN** sync removes the failed temporary file and retries the complete atomic file application once from a fresh owner-only temporary file
- **AND** after the second failure exits 2 without a partial metadata batch
- **AND** does not retry when the current `.gitmodules` content differs from the snapshot

#### Scenario: Temporary metadata is always cleaned up
- **WHEN** metadata reconciliation succeeds, fails, or throws while preparing or replacing `.gitmodules`
- **THEN** sync removes every temporary metadata file
- **AND** no temporary file is staged

#### Scenario: Metadata transformation fails
- **WHEN** any in-memory alias planning or transformation fails before temporary-file application
- **THEN** sync leaves the original `.gitmodules` unchanged
- **AND** applies none of the metadata batch
- **AND** does not retry the deterministic transformation
- **AND** exits 2 and identifies the unapplied aliases

#### Scenario: Metadata failure preserves resumable topology
- **WHEN** topology mutation completed before metadata planning, application, concurrent-change validation, replacement, or mode restoration fails
- **THEN** sync does not create a root commit
- **AND** leaves completed topology changes unstaged in the working tree as a resumable result
- **AND** treats the verified post-topology `.gitmodules` content as the original metadata snapshot
- **AND** before replacement preserves that snapshot, while an exhausted post-replacement mode failure preserves reconciled owner-only content

#### Scenario: Gitmodules changes concurrently
- **WHEN** the final content comparison detects that `.gitmodules` changed after the metadata plan read it
- **THEN** sync leaves the concurrent content unchanged
- **AND** exits 2 with guidance to rerun sync

#### Scenario: Atomic metadata replacement fails
- **WHEN** both attempts to replace from an unchanged snapshot fail
- **THEN** sync preserves the original `.gitmodules`
- **AND** exits 2 and identifies the unapplied aliases

#### Scenario: File mode restoration retries safely
- **WHEN** atomic replacement succeeds but restoring the original `.gitmodules` mode fails
- **THEN** sync retries mode restoration once
- **AND** after a second failure leaves `.gitmodules` owner-only and does not finalize a root commit
- **AND** exits 2 with `chmod 0<mode> '<absolute-repo-root>/.gitmodules'`, using POSIX single-quote escaping for the absolute path, and a current reconciled-state summary

## MODIFIED Requirements

### Requirement: Pull and push keep root pointer updates explicit
The system SHALL keep `oms pull` and `oms push` focused only on synchronizing submodules, while existing root gitlink pointer-update staging and commits are created only by `oms record <alias>`. Sync and unsync root commits are a separate topology workflow; sync commits SHALL also include reconciled metadata and its current declarative `oms.yaml` source.

#### Scenario: Sync leaves OMS root changes unstaged
- **WHEN** the user runs `oms sync api` without creating a root commit and the command changes topology or managed metadata
- **THEN** those root working-tree changes remain available as the explicit no-commit result
- **AND** the command does not leave those changes staged in the real root index
- **AND** unrelated staged root changes remain staged

#### Scenario: Unsync leaves topology changes unstaged
- **WHEN** the user runs `oms unsync api` without creating a topology commit and the command removes or updates root topology files such as `.gitmodules` or `oms/api`
- **THEN** those root working tree changes remain available for review
- **AND** the command does not leave those changes staged in the root index
- **AND** unrelated staged root changes remain staged
- **AND** the command prints guidance to review, stage, and commit root topology changes explicitly

#### Scenario: Interactive sync prompts for one root commit
- **WHEN** the user runs `oms sync api` in an interactive terminal
- **AND** every requested alias succeeds with topology or metadata changes
- **THEN** the command asks once whether to create a root commit
- **AND** the prompt defaults to Yes and identifies topology, metadata, and changed `oms.yaml` paths that will be included
- **AND** if the user accepts, the command creates one commit for those successful OMS changes
- **AND** if the user declines, the command applies the path-limited unstage behavior

#### Scenario: Interactive unsync prompts for topology commit
- **WHEN** the user runs `oms unsync api` in an interactive terminal and topology changes succeed
- **THEN** the command asks whether to create a root topology commit
- **AND** the prompt defaults to Yes and shows commit message `chore(oms): remove api submodule`
- **AND** if the user accepts, the command creates a root commit with message `chore(oms): remove api submodule`
- **AND** if the user declines, the command applies the path-limited unstage behavior

#### Scenario: Sync commit prompt is driven by detected pending state
- **WHEN** a previous `oms sync api` left pending topology or managed metadata without creating a root commit
- **AND** the user later runs the same command again in an interactive terminal
- **THEN** the command detects the pending state from root HEAD, working tree, `.gitmodules`, and `oms.yaml`
- **AND** asks again whether to create the root commit after successful validation
- **AND** the prompt continues to re-appear until the OMS change is committed or reverted

#### Scenario: Unsync commit prompt is driven by detected pending state
- **WHEN** a previous `oms unsync api` left pending topology without creating a topology commit
- **AND** the user later runs the same command again in an interactive terminal
- **THEN** the command detects the pending topology from root HEAD, working tree, and `.gitmodules` state
- **AND** asks again whether to create the root topology commit

#### Scenario: Explicit sync commit bypasses prompt
- **WHEN** the user runs `oms sync api --commit`
- **THEN** the command creates one root commit containing successful `api` topology, reconciled metadata, and the complete current `oms.yaml` when changed
- **AND** the command does not prompt

#### Scenario: Sync commit works for pending changes
- **WHEN** `oms sync api` previously created topology or metadata working-tree changes without committing them
- **AND** the user later runs `oms sync api --commit`
- **THEN** the command validates and creates the root commit for those pending successful OMS changes

#### Scenario: Explicit unsync commit bypasses prompt
- **WHEN** the user runs `oms unsync api --commit`
- **THEN** the command creates a root topology commit with message `chore(oms): remove api submodule`
- **AND** the command does not prompt

#### Scenario: Unsync commit works for pending topology changes
- **WHEN** `oms unsync api` previously created topology working tree changes without committing them
- **AND** the user later runs `oms unsync api --commit`
- **AND** root HEAD has an `oms/api` gitlink and both the working tree path and `.gitmodules` entry for `oms/api` have been removed
- **THEN** the command creates the root topology commit for the pending `api` removal changes

#### Scenario: Unsync commit rejects partial removal topology
- **WHEN** root HEAD has an `oms/api` gitlink
- **AND** exactly one of the working tree path or `.gitmodules` entry for `oms/api` has been removed
- **AND** the current `oms unsync api --commit` invocation cannot complete the matching cleanup
- **THEN** the command fails without creating a topology commit
- **AND** the message explains that partial removal topology must be cleaned up before committing

#### Scenario: Multi-alias sync commit uses plural message
- **WHEN** the user runs `oms sync api web --commit`
- **AND** all requested aliases succeed
- **THEN** the command creates one root commit for their topology, metadata, and changed `oms.yaml`
- **AND** the commit message is `chore(oms): add submodules` when topology was added

#### Scenario: Multi-alias unsync commit uses plural message
- **WHEN** the user runs `oms unsync api web --commit`
- **THEN** the command creates one root topology commit when all requested aliases succeed
- **AND** the commit message is `chore(oms): remove submodules`

#### Scenario: Partial multi-alias sync commit finalizes successful aliases
- **WHEN** the user runs `oms sync api web --commit`
- **AND** `api` succeeds while `web` fails
- **THEN** the command uses a temporary index to commit only `api` topology and metadata plus the complete current `oms.yaml`
- **AND** failed-alias `.gitmodules` metadata and gitlink changes and unrelated working-tree changes are not included
- **AND** failed-alias `oms.yaml` declarations and other current manifest edits are intentionally included
- **AND** pre-existing real-index entries other than `oms.yaml` are preserved after the new HEAD is installed
- **AND** the command exits 2 with the alias-level summary

#### Scenario: Partial multi-alias unsync commit is skipped
- **WHEN** the user runs `oms unsync api web --commit`
- **AND** any requested alias fails
- **THEN** the command does not create a topology commit
- **AND** successfully changed topology paths are returned to unstaged state

#### Scenario: Multi-alias commit prompt is skipped on partial failure
- **WHEN** the user runs `oms sync api web` or `oms unsync api web` interactively without `--commit`
- **AND** any requested alias fails
- **THEN** the command does not ask whether to create a root commit
- **AND** successfully changed paths are returned to unstaged state

#### Scenario: Sync commit preserves unrelated staged root changes
- **WHEN** the real root index has staged paths other than `.gitmodules` before sync
- **AND** the user accepts the sync commit prompt or passes `--commit`
- **THEN** the temporary commit index excludes unrelated staged paths other than `oms.yaml`
- **AND** those excluded paths remain staged in the real index after the sync commit
- **AND** staged `oms.yaml` is replaced by and consumed as the complete current working-tree manifest
- **AND** a selected OMS path is consumed only when its staged blob and mode exactly match the validated commit result

#### Scenario: Unsync topology commit rejects unrelated staged root changes
- **WHEN** the root index has staged paths unrelated to selected unsync topology paths
- **AND** the user accepts the topology commit prompt or passes `--commit`
- **THEN** the command fails before creating the topology commit
- **AND** selected topology paths are returned to unstaged state

#### Scenario: Sync commit failure preserves working changes
- **WHEN** sync attempts its root commit and Git rejects it
- **AND** `HEAD` has not advanced
- **THEN** the command does not create a partial OMS commit
- **AND** the real index remains byte-for-byte unchanged while working-tree changes are preserved

#### Scenario: Unsync commit failure preserves staged paths
- **WHEN** unsync stages selected topology paths for a topology commit
- **AND** the root `git commit` step fails
- **THEN** the command fails
- **AND** the selected topology paths remain staged

#### Scenario: Pull does not stage or commit the root gitlink
- **WHEN** the user runs `oms pull api`
- **THEN** the command pulls the current `api` submodule branch according to the existing fast-forward policy
- **AND** does not stage the root gitlink
- **AND** does not create a root repository commit

#### Scenario: Pull prints record hint when pointer moved
- **WHEN** the user runs `oms pull api` successfully and the root pointer for `api` is moved
- **THEN** the command prints a hint to run `oms record api`
- **AND** the command does not stage or record the root pointer

#### Scenario: Pull prints topology hint when recorded gitlink is missing
- **WHEN** the user runs `oms pull api` successfully
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command prints a hint to run `oms sync api --commit`
- **AND** the command does not stage or record the root pointer

#### Scenario: Pull rejects dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms pull api`
- **THEN** the command fails before running pull
- **AND** the message asks the user to commit, stash, or clean changes inside `oms/api`

#### Scenario: Push does not stage or commit the root gitlink
- **WHEN** the user runs `oms push api`
- **THEN** the command pushes the current `api` submodule branch
- **AND** does not stage the root gitlink
- **AND** does not create a root repository commit

#### Scenario: Push prints record hint when pointer moved
- **WHEN** the user runs `oms push api` successfully and the root pointer for `api` is moved
- **THEN** the command prints a hint to run `oms record api`
- **AND** the command does not stage or record the root pointer

#### Scenario: Push prints topology hint when recorded gitlink is missing
- **WHEN** the user runs `oms push api` successfully
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command prints a hint to run `oms sync api --commit`
- **AND** the command does not stage or record the root pointer

#### Scenario: Push warns for dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms push api`
- **THEN** the command warns that only the current HEAD will be pushed
- **AND** the command does not auto-commit source changes

#### Scenario: Push rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD
- **AND** the user runs `oms push api`
- **THEN** the command fails and suggests `oms switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Pull rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD
- **AND** the user runs `oms pull api`
- **THEN** the command fails and suggests `oms switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Multi-alias pull and push process aliases independently
- **WHEN** the user runs `oms push api web` or `oms pull api web`
- **THEN** the command processes aliases independently
- **AND** continues processing later aliases after one alias fails
- **AND** exits non-zero if any alias operation fails
- **AND** prints a final summary of per-alias results

#### Scenario: Push record option is unsupported
- **WHEN** the user runs `oms push api --record`
- **THEN** the command fails before pushing
- **AND** the message explains that existing root pointer updates are committed with `oms record api`

#### Scenario: Removed push commit option fails before pushing
- **WHEN** the user runs `oms push api --commit`
- **THEN** the command fails before pushing
- **AND** the message explains that submodule branches are pushed with `oms push api` and root pointer updates are committed with `oms record api`
- **AND** does not create a root repository commit

### Requirement: Sync restores pending submodule removals
The system SHALL treat `oms sync` for a selected alias with pending removal topology as a request to restore that submodule, not as a request to add a new submodule at the same path, and SHALL reconcile restored metadata through the same root finalization as other successful sync changes.

#### Scenario: Explicit sync restores an uncommitted unsync
- **WHEN** `oms unsync api` previously removed `oms/api` and its `.gitmodules` entry without creating a topology commit
- **AND** root `HEAD` still records `oms/api` as a submodule gitlink
- **AND** the user runs `oms sync api`
- **THEN** the command restores the selected `api` submodule topology instead of running `git submodule add`
- **AND** the command initializes or updates `oms/api` as needed
- **AND** the command does not fail with `already exists in the index`

#### Scenario: Interactive sync restores a selected pending removal
- **WHEN** `oms unsync api` previously removed `oms/api` and its `.gitmodules` entry without creating a topology commit
- **AND** root `HEAD` still records `oms/api` as a submodule gitlink
- **AND** the user runs `oms sync` and selects only `api`
- **THEN** the command restores the selected `api` submodule topology instead of running `git submodule add`
- **AND** the command does not fail with `already exists in the index`

#### Scenario: Sync restore is scoped to the selected alias
- **WHEN** `api` has pending removal topology
- **AND** another alias is present in the manifest and `.gitmodules`
- **AND** the user runs `oms sync api`
- **THEN** the command restores only the selected `api` submodule topology
- **AND** unrelated alias topology and unrelated `.gitmodules` content edits are preserved
- **AND** pre-existing staged `.gitmodules` state is rejected and preserved before restoration starts

#### Scenario: Sync preserves unsafe pending removal guardrails
- **WHEN** the selected alias has pending removal topology that cannot be restored safely because the root gitlink is conflicted, the required `.gitmodules` data cannot be recovered from `HEAD`, the current `.gitmodules` entry for the same alias contains edits that would be overwritten, `.gitmodules` is already staged, `oms/api` is occupied by a non-submodule file or directory, or the root repository has a merge, rebase, cherry-pick, or similar operation in progress
- **AND** the user runs `oms sync api`
- **THEN** the command fails before running `git submodule add`
- **AND** the message explains the specific user-owned state that must be resolved or committed before syncing

#### Scenario: Sync restore keeps root finalization policy
- **WHEN** `oms sync api` restores a pending removal successfully
- **THEN** the command uses one root finalization decision for restored topology and reconciled metadata
- **AND** a plain restore back to the topology and metadata recorded in root `HEAD` leaves nothing to commit
- **AND** `oms sync api --commit` creates one path-limited root commit when topology or metadata changes remain after restore
- **AND** interactive sync without `--commit` uses one default-Yes prompt when topology or metadata changes remain
- **AND** the restore path does not add a separate confirmation prompt before restoring the selected alias

#### Scenario: Sync restore reports without changing summary semantics
- **WHEN** `oms sync api` restores a pending removal successfully
- **THEN** the command emits a message explaining that pending removal topology was restored
- **AND** the command summary uses the existing initialized or updated result semantics instead of a new restored result

#### Scenario: Sync restore tolerates a macOS metadata-only directory
- **WHEN** `oms unsync api` previously removed `oms/api` and its `.gitmodules` entry without creating a topology commit
- **AND** root `HEAD` still records `oms/api` as a submodule gitlink
- **AND** `oms/api` exists and contains only `.DS_Store`
- **AND** the user runs `oms sync api`
- **THEN** the command removes `oms/api/.DS_Store`
- **AND** the command restores and initializes `oms/api`
- **AND** the restored submodule is not dirty because of `.DS_Store`

#### Scenario: Sync restore reconciles manifest metadata
- **WHEN** `oms sync api` restores a pending removal successfully
- **AND** the restored `.gitmodules` section has a `url` or explicit `branch` value that differs from `oms.yaml`
- **THEN** the command updates that selected alias metadata in `.gitmodules` from `oms.yaml`
- **AND** finalizes those metadata edits together with restored topology when commit is requested or accepted
- **AND** otherwise leaves both kinds of OMS changes unstaged
- **AND** the restore message indicates that `.gitmodules` metadata was updated
