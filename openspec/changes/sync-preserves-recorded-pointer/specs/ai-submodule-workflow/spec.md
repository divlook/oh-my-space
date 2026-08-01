## MODIFIED Requirements

### Requirement: Existing submodule metadata reconciliation
The system SHALL reconcile an existing or restored selected submodule's OMS-managed `.gitmodules` URL and branch metadata from `oms.yaml` after topology mutation and baseline validation, then include successful plans in the same root commit-or-unstage finalization as successful topology. When sync encounters a detached submodule `HEAD`, it SHALL attach the resolved baseline only when the attachment preserves the checked-out commit; otherwise it SHALL preserve the detached commit and root gitlink, report the divergent baseline, and provide explicit branch-switch and pull guidance. When Git refuses the branch operation instead, sync SHALL report that alias as failed rather than as a successful attachment.

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

#### Scenario: Detached baseline at the current commit attaches safely
- **WHEN** sync initializes or updates a selected alias at detached `HEAD`
- **AND** the resolved local baseline branch points at exactly the current commit, or does not yet exist
- **THEN** sync attaches or creates that baseline without changing the checked-out commit
- **AND** preserves the root gitlink value

#### Scenario: Refused baseline attachment fails the alias
- **WHEN** sync attaches the resolved baseline for a selected alias at detached `HEAD`
- **AND** Git refuses to create or switch to that branch
- **THEN** sync reports the Git diagnostic and names the alias whose attachment failed
- **AND** the refused attachment neither moves the checked-out commit nor writes the root gitlink
- **AND** reports that alias as failed rather than added or updated
- **AND** exits non-zero

#### Scenario: Diverged detached baseline preserves the recorded pointer
- **WHEN** sync initializes a registered alias at the root repository's recorded gitlink commit
- **AND** the resolved local baseline branch points at a different commit
- **THEN** sync does not switch to the baseline branch
- **AND** leaves the submodule detached at the recorded commit
- **AND** leaves the root gitlink and root index clean
- **AND** reports the current and baseline commits without exposing remote URLs
- **AND** names `oms branch switch <alias> <baseline>` and `oms pull <alias>` as explicit ways to advance
- **AND** exits 0

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

#### Scenario: Working-tree manifest is captured for finalization
- **WHEN** sync plans a requested or accepted root commit
- **THEN** it captures the exact working-tree `oms.yaml` bytes during planning
- **AND** stages the captured bytes rather than re-reading the path

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
- **AND** exits 2 while preserving the changed index

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

### Requirement: Shared alias preparation across commands
The system SHALL prepare a selected alias through one shared implementation for every command that operates inside a submodule working tree — `oms commit`, `oms fetch`, `oms pull`, `oms push`, `oms branch list`, `oms branch switch`, `oms branch checkout`, and `oms branch delete` — classifying its root registration, initializing it automatically when that requires no root topology change, and offering topology-creating registration only for the commands a fresh registration could serve. `oms status`, `oms doctor`, and `oms record` SHALL NOT perform this preparation. When automatic initialization cannot attach the resolved baseline because Git refuses the branch operation, preparation SHALL report the failure and exit non-zero instead of continuing the requested command.

#### Scenario: Registration is classified consistently for every command
- **WHEN** any preparing command resolves an alias
- **THEN** OMS classifies it as initialized, registered but uninitialized, partially registered, or unregistered
- **AND** the classification compares root HEAD, the root index, and the working tree for both the gitlink and the `.gitmodules` registration
- **AND** every preparing command derives the same classification for the same repository state

#### Scenario: Registered uninitialized alias is initialized for any preparing command
- **WHEN** a preparing command's selected alias has a root gitlink and `.gitmodules` registration but is not initialized
- **THEN** OMS initializes only that alias automatically
- **AND** does not create, stage, or commit root topology
- **AND** continues the requested command without requiring a separate command

#### Scenario: Baseline attachment failure stops automatic initialization
- **WHEN** a preparing command automatically initializes a registered alias
- **AND** Git refuses to create or switch to the resolved baseline branch
- **THEN** OMS reports the Git diagnostic and names the alias whose attachment failed
- **AND** leaves the initialized submodule at its checked-out commit
- **AND** does not continue the requested command
- **AND** exits non-zero

#### Scenario: Unregistered alias is offered registration for commands a fresh clone can serve
- **WHEN** the selected alias is declared in `oms.yaml` but not registered in the root repository
- **AND** the command is `oms fetch`, `oms pull`, `oms branch list`, `oms branch switch`, or `oms branch checkout`
- **AND** stdin is interactive
- **THEN** OMS offers to register the alias and continue, stating the root topology consequence
- **AND** accepting delegates to the sync workflow and resumes the requested command
- **AND** declining leaves root topology unchanged and exits non-zero

#### Scenario: Unregistered alias is refused for commands presupposing local state
- **WHEN** the selected alias is declared in `oms.yaml` but not registered in the root repository
- **AND** the command is `oms commit`, `oms push`, or `oms branch delete`
- **THEN** OMS does not offer registration
- **AND** exits non-zero explaining that a newly registered alias has no uncommitted changes, no unpushed commits, and no branch other than its baseline
- **AND** names `oms sync <alias>` as the command that registers it

#### Scenario: Unregistered alias is refused non-interactively
- **WHEN** a preparing command's selected alias is unregistered
- **AND** stdin is non-interactive
- **THEN** OMS exits non-zero without creating root topology
- **AND** names `oms sync <alias>` and the command to retry

#### Scenario: Partially registered alias is refused by every preparing command
- **WHEN** root HEAD, the root index, and the working tree disagree about an alias's gitlink or `.gitmodules` registration
- **OR** either registration element is conflicted or has a pending topology addition or removal
- **THEN** OMS exits non-zero without attempting automatic initialization or topology repair
- **AND** identifies the inconsistent registration and provides sync repair guidance

#### Scenario: Multi-alias preparation asks once and registers together
- **WHEN** `oms fetch` or `oms pull` selects several aliases and more than one is unregistered
- **AND** stdin is interactive
- **THEN** OMS presents one choice naming every unregistered alias
- **AND** accepting registers them in a single delegated sync producing one root topology commit
- **AND** OMS does not present the choice once per alias

#### Scenario: Multi-alias preparation offers a skip that does not fail the run
- **WHEN** OMS presents the multi-alias preparation choice
- **THEN** the choices include registering all of them, skipping them and continuing with the rest, and cancelling
- **AND** choosing to skip reports the skipped aliases, processes the remaining aliases, and exits 0
- **AND** cancelling performs no repo operation and exits non-zero

#### Scenario: Preparation choice defaults by how the selection was made
- **WHEN** the alias was named on the command line, or was auto-selected as the only candidate
- **THEN** the preparation choice defaults to registering and continuing
- **WHEN** the selection came from `--all` or a multi-select prompt
- **THEN** the preparation choice defaults to skipping the unregistered aliases

#### Scenario: Detached submodule HEAD is attached when a branch already points at it
- **WHEN** a preparing command's selected submodule is in detached HEAD
- **AND** at least one local branch points at exactly the current HEAD commit
- **THEN** OMS switches to that branch without changing the working tree contents
- **AND** reports the attachment
- **AND** continues the requested command

#### Scenario: Detached submodule HEAD with no branch at HEAD offers a choice
- **WHEN** a preparing command's selected submodule is in detached HEAD
- **AND** no local branch points at the current HEAD commit
- **AND** stdin is interactive
- **THEN** OMS presents choices to create a branch at the current commit, to switch to the baseline branch while stating that the working tree moves, or to cancel
- **AND** continues the requested command after the user chooses

#### Scenario: Detached submodule HEAD with no branch at HEAD fails non-interactively
- **WHEN** a preparing command's selected submodule is in detached HEAD
- **AND** no local branch points at the current HEAD commit
- **AND** stdin is non-interactive
- **THEN** OMS exits non-zero without moving the working tree
- **AND** names `oms branch switch <alias> <branch>`

#### Scenario: Diagnostic and pointer commands do not prepare
- **WHEN** the user runs `oms status`, `oms doctor`, or `oms record`
- **THEN** OMS does not initialize, register, or attach any alias
- **AND** reports the state it observes
- **AND** `oms record` still resolves an omitted selection through the shared alias-resolution rules, which govern selection only and are separate from preparation
