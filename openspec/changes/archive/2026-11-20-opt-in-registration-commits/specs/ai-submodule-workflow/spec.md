# Spec Delta

## MODIFIED Requirements

### Requirement: Shared alias preparation across commands
The system SHALL prepare a selected alias through one shared implementation for every command that operates inside a submodule working tree — `oms commit`, `oms fetch`, `oms pull`, `oms push`, `oms branch list`, `oms branch switch`, `oms branch checkout`, `oms branch delete`, and `oms tree add` — classifying its root registration, initializing it automatically when that requires no root topology change, and offering topology-creating registration only for the commands a fresh registration could serve. OMS SHALL distinguish valid pending source registrations from incomplete or conflicting registrations and apply the command-specific eligibility below. `oms status`, `oms doctor`, `oms record`, `oms tree list`, and `oms tree remove` SHALL NOT perform this preparation. When automatic initialization cannot attach the resolved baseline because Git refuses the branch operation, preparation SHALL report the failure and exit non-zero instead of continuing the requested command. `oms tree add` SHALL NOT perform detached-HEAD attachment: its start point is the canonical checkout's current HEAD commit, and it leaves a detached canonical checkout detached without prompting.

#### Scenario: Registration is classified consistently for every command
- **WHEN** any preparing command resolves an alias
- **THEN** OMS classifies it as initialized, registered but uninitialized, valid pending source registration, partially registered, or unregistered
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
- **AND** the command is `oms fetch`, `oms pull`, `oms branch list`, `oms branch switch`, `oms branch checkout`, or `oms tree add`
- **AND** stdin is interactive
- **THEN** OMS offers to register the alias and continue, stating the root topology consequence
- **AND** the offer states whether the workspace setting enables a root registration commit
- **AND** accepting delegates to the sync workflow and resumes the requested command when registration succeeds, even if it remains pending
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
- **WHEN** an alias has a conflicted gitlink or `.gitmodules` entry, a pending removal, or registration components that are inconsistent rather than a valid pending addition
- **THEN** OMS exits non-zero without attempting automatic initialization or topology repair
- **AND** identifies the inconsistent registration and provides sync repair guidance

#### Scenario: A valid pending source registration is usable without committing
- **WHEN** an alias not registered in the main project's current revision has an initialized canonical submodule checkout and a matching, unambiguous working-tree `.gitmodules` registration
- **AND** the checkout's Git directory belongs to that alias's submodule in the main project
- **AND** its root index has no conflicts or incompatible entries for the registration, whether the addition is unstaged or consistently staged
- **THEN** OMS classifies it as a valid pending source registration, not as unregistered or broken
- **AND** `oms fetch`, `oms pull`, `oms commit`, `oms branch list`, `oms branch switch`, `oms branch checkout`, and `oms tree add` accept it subject to their existing command-specific checks, without staging or committing the registration, offering to register again, or requiring a separate sync
- **AND** this applies both immediately after delegated registration and on later invocations, whether or not stdin is a terminal

#### Scenario: Independent clone is not a valid pending source registration
- **WHEN** a declared alias has a checkout and a matching working-tree `.gitmodules` entry, but its Git directory does not belong to the main project's submodule for that alias
- **THEN** OMS does not treat the checkout as a valid pending source registration
- **AND** a command preparing that alias does not operate on the checkout or attempt to repair it and reports the registration mismatch

#### Scenario: Commands outside the pending-registration scope refuse it
- **WHEN** the user explicitly targets a valid pending source registration with `oms push`, `oms branch delete`, `oms branch clean`, `oms exec`, or `oms record`
- **THEN** OMS does not perform that command's operation for the alias
- **AND** it identifies the pending registration and points to `oms sync <alias> --commit` without changing the registration
- **AND** `oms exec` still processes other eligible aliases and bulk `oms record` does not select the pending registration as a pointer-update candidate

#### Scenario: Multi-alias preparation asks once and registers together
- **WHEN** `oms fetch` or `oms pull` selects several aliases and more than one is unregistered
- **AND** stdin is interactive
- **THEN** OMS presents one choice naming every unregistered alias
- **AND** accepting registers them in a single delegated sync, creating one root registration commit only if `autoCommit` is enabled and the commit safety checks pass
- **AND** OMS does not present the choice once per alias

#### Scenario: Alias-specific registration failure does not block successful aliases
- **WHEN** delegated multi-alias sync succeeds for `api` and fails for `web`, and shared root finalization succeeds
- **THEN** the original command continues for `api` if eligible, whether the registration was committed or remains pending
- **AND** the original command does not operate on `web`, even if its checkout was created before the failure
- **AND** OMS reports per-alias outcomes and returns a non-zero exit code

#### Scenario: Shared root finalization failure blocks the original command
- **WHEN** delegated sync fails in shared root commit or index finalization, before or after root HEAD advances
- **THEN** OMS does not run the requested source operation for any alias in the invocation
- **AND** it returns a non-zero exit code and reports the failure, the retained state, and the applicable recovery action

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

#### Scenario: Tree creation skips detached-HEAD attachment
- **WHEN** the user runs `oms tree add api fix-auth`
- **AND** the initialized submodule `api` is in detached HEAD
- **THEN** OMS does not attach, prompt about, or move the canonical checkout
- **AND** the worktree's branch starts at the current HEAD commit
- **AND** the canonical checkout remains in detached HEAD afterwards

#### Scenario: Diagnostic and pointer commands do not prepare
- **WHEN** the user runs `oms status`, `oms doctor`, `oms record`, `oms tree list`, or `oms tree remove`
- **THEN** OMS does not initialize, register, or attach any alias
- **AND** reports the state it observes
- **AND** `oms record` still resolves an omitted selection through the shared alias-resolution rules, which govern selection only and are separate from preparation

### Requirement: Submodule branch inventory
The system SHALL provide `oms branch list [alias]` to prepare one selected submodule when safe, refresh every remote declared for it in `oms.yaml`, and display its local and declared-remote branch inventory without changing a checked-out branch or changing a root pointer outside an explicitly accepted delegation to the existing sync workflow.

#### Scenario: Explicit initialized alias is listed
- **WHEN** the user runs `oms branch list api`
- **AND** `api` is a declared initialized submodule
- **THEN** OMS refreshes every remote declared for `api`
- **AND** displays local and declared-remote branches
- **AND** exits 0

#### Scenario: Unknown alias is rejected
- **WHEN** the user runs `oms branch list missing`
- **AND** `missing` is not declared in `oms.yaml`
- **THEN** OMS exits 1 without changing repository state
- **AND** identifies the unknown alias and explains how to list declared aliases

#### Scenario: Sole viable alias is selected automatically
- **WHEN** the alias is omitted
- **AND** exactly one alias is declared
- **THEN** OMS selects that alias without prompting
- **AND** continues the branch listing workflow when it can be listed or safely prepared
- **AND** otherwise exits with the selected alias's exact preparation guidance

#### Scenario: Multiple aliases require interactive selection
- **WHEN** the alias is omitted in an interactive terminal
- **AND** multiple declared aliases are available
- **THEN** OMS presents one alias selector with initialization and registration state
- **AND** continues listing the selected alias

#### Scenario: Multiple aliases are ambiguous non-interactively
- **WHEN** the alias is omitted in a non-interactive shell
- **AND** multiple declared aliases are available
- **THEN** OMS exits 1 without guessing an alias
- **AND** identifies the missing alias argument and shows `oms branch list <alias>` guidance

#### Scenario: Registered uninitialized alias is prepared automatically
- **WHEN** the selected alias has a root gitlink and `.gitmodules` registration but is not initialized
- **THEN** OMS initializes only that alias automatically
- **AND** continues remote refresh and branch listing without requiring a separate command
- **AND** does not create, stage, or commit root topology

#### Scenario: Registered initialization uses manifest URL
- **WHEN** a registered uninitialized alias's `.gitmodules` URL differs from its `oms.yaml` origin URL
- **THEN** OMS uses the manifest URL for targeted initialization
- **AND** does not rewrite, stage, or commit root `.gitmodules`

#### Scenario: Automatic initialization fails
- **WHEN** targeted initialization of a registered alias fails
- **THEN** OMS exits 2 with the original Git diagnostic after credential components are redacted
- **AND** retains non-sensitive URL host/path when present as failure context
- **AND** preserves Git's resumable partial initialization state
- **AND** explains how to retry or repair the selected alias

#### Scenario: Declared alias lacks root registration interactively
- **WHEN** an interactive user selects an alias declared in `oms.yaml` without a root gitlink or `.gitmodules` registration
- **THEN** OMS offers `sync and continue` and `cancel` choices with the topology consequence stated
- **AND** accepting delegates to the normal sync workflow and resumes listing after successful initialization
- **AND** cancelling exits 1 without creating topology

#### Scenario: Declared alias lacks root registration non-interactively
- **WHEN** an explicitly selected or sole auto-selected alias is declared but unregistered
- **AND** stdin is non-interactive
- **THEN** OMS exits 1 without creating root topology
- **AND** explains the reason and provides `oms sync <alias>` guidance

#### Scenario: Alias registration is partial
- **WHEN** a declared alias has a conflicted or incomplete registration, including a pending removal
- **THEN** OMS exits 1 without attempting automatic initialization or topology repair
- **AND** identifies the inconsistent registration and provides sync repair guidance

#### Scenario: Branch inventory accepts a valid pending registration
- **WHEN** the selected alias is a valid pending source registration
- **THEN** OMS refreshes its declared remotes and lists its branches without requiring another sync or creating a root commit

#### Scenario: Moved registered pointer remains preparable
- **WHEN** root HEAD, index, and working tree agree that an alias's gitlink and `.gitmodules` registration exist
- **AND** their gitlink OIDs differ without a topology conflict or pending addition or removal
- **THEN** OMS treats the alias as registered
- **AND** does not reject automatic preparation solely because the pointer moved

#### Scenario: Accepted sync retains its existing contract
- **WHEN** the user accepts `sync and continue` for an unregistered alias
- **THEN** OMS delegates topology, metadata, and root commit decisions to the existing sync workflow
- **AND** resumes branch listing only after sync successfully initializes the alias
- **AND** does not describe sync's explicitly accepted root changes as branch-list mutations
- **AND** redacts credentials from every delegated sync diagnostic while retaining non-sensitive URL host/path and failure context
- **AND** preserves sync's existing exit code when sync fails

### Requirement: Existing submodule metadata reconciliation
The system SHALL reconcile an existing or restored selected submodule's OMS-managed `.gitmodules` URL and branch metadata from `oms.yaml` after topology mutation and baseline validation, then include successful plans in the same root finalization as successful topology. When sync encounters a detached submodule `HEAD`, it SHALL attach the resolved baseline only when the attachment preserves the checked-out commit; otherwise it SHALL preserve the detached commit and root gitlink, report the divergent baseline, and provide explicit branch-switch and pull guidance. When Git refuses the branch operation instead, sync SHALL report that alias as failed rather than as a successful attachment.

#### Scenario: User-owned Gitmodules state is rejected before mutation
- **WHEN** `.gitmodules` is unmerged, the root has an in-progress Git operation, or a sync with commits enabled encounters a pre-staged selected OMS path that differs in blob or mode from its validated commit result
- **THEN** sync exits 1 before changing any root path
- **AND** does not commit, unstage, or overwrite the user-owned mismatched state
- **AND** an exact-matching pre-staged selected OMS path may be consumed by a sync commit enabled by the root finalization policy
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
- **AND** the root finalization policy enables a commit
- **THEN** sync includes successful aliases' metadata and topology in the same path-limited OMS commit
- **AND** sync reports the changed fields
- **AND** does not print old or new URL values

#### Scenario: No-commit result remains unstaged
- **WHEN** metadata-only reconciliation succeeds with root commits disabled
- **THEN** sync writes the reconciled metadata to the working tree without changing its staged version

#### Scenario: Metadata-only interactive sync offers automatic completion
- **WHEN** interactive sync has managed metadata drift but no pending registration changes
- **AND** a root commit is not enabled for the invocation
- **THEN** sync reconciles the metadata, leaves the changes unstaged, and does not prompt to commit

#### Scenario: Fetch failure does not reconcile metadata
- **WHEN** origin fetch fails for an initialized existing submodule
- **THEN** sync does not newly modify `.gitmodules` metadata for that alias

#### Scenario: Metadata uses the post-topology snapshot
- **WHEN** one sync invocation has both pending topology changes and existing-submodule metadata drift
- **THEN** sync completes topology mutation before taking the metadata snapshot
- **AND** applies metadata reconciliation before root finalization
- **AND** does not treat expected topology edits as concurrent modification
- **AND** finalizes successful topology and metadata together

#### Scenario: Working-tree manifest is captured for finalization
- **WHEN** sync plans an enabled root commit
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
- **WHEN** a multi-alias sync partially fails with root commits disabled
- **THEN** sync creates no root commit and does not reset staging left by Git
- **AND** reports the failed aliases without a separate staging notice

#### Scenario: Temporary commit index preserves the real index
- **WHEN** sync creates an enabled root commit
- **THEN** its owner-only temporary index starts from the verified `HEAD`
- **AND** contains a `.gitmodules` synthesized from `HEAD` by applying only successful aliases' OMS-managed topology and `path`, `url`, and `branch` fields
- **AND** preserves unrelated keys from `HEAD` without copying unrelated working-tree edits
- **AND** stages only successful alias gitlinks and the complete current `oms.yaml`
- **AND** atomically refreshes the real index against the new `HEAD` without losing pre-existing staged entries other than intentionally consumed `oms.yaml` and exact-matching committed OMS paths

#### Scenario: Every sync commit includes its declarative manifest
- **WHEN** a sync commit is enabled and will be created
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

#### Scenario: No-commit runs recover verified prior finalization before new changes
- **WHEN** a `sync` or `unsync` run with root commits disabled encounters interrupted finalization from an earlier OMS operation
- **THEN** OMS runs the same verified recovery before applying new changes, without creating a commit
- **AND** an unverified recovery or an index that does not match the recorded recovery state stops the command before new changes, without overwriting that index

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
- **WHEN** the root has an in-progress Git operation, `.gitmodules` is unmerged, or a sync with commits enabled encounters a staged selected OMS path that does not exactly match its validated result before root mutation
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
- **AND** leaves completed topology changes available for retry and, with commits disabled, retains staging left by Git
- **AND** with commits enabled, leaves completed topology changes unstaged in the working tree as a resumable result
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
- **AND** when a root commit is enabled, existing staging safeguards for restoration still apply

#### Scenario: Sync preserves unsafe pending removal guardrails
- **WHEN** the selected alias has pending removal topology that cannot be restored safely because the root gitlink is conflicted, the required `.gitmodules` data cannot be recovered from `HEAD`, the current `.gitmodules` entry for the same alias contains edits that would be overwritten, `oms/api` is occupied by a non-submodule file or directory, or the root repository has a merge, rebase, cherry-pick, or similar operation in progress
- **AND** the user runs `oms sync api`
- **THEN** the command fails before running `git submodule add`
- **AND** the message explains the specific user-owned state that must be resolved or committed before syncing

#### Scenario: Sync restore keeps root finalization policy
- **WHEN** `oms sync api` restores a pending removal successfully
- **THEN** the command uses one root finalization decision for restored topology and reconciled metadata
- **AND** a plain restore back to the topology and metadata recorded in root `HEAD` leaves nothing to commit
- **AND** `oms sync api --commit` creates one path-limited root commit when topology or metadata changes remain after restore
- **AND** with commits disabled, sync retains any staging produced by the restore and creates no root commit or commit prompt
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
- **AND** finalizes those metadata edits together with restored topology when the root finalization policy enables a commit
- **AND** otherwise leaves the metadata reconciliation in the working tree without resetting any staging produced by the restore
- **AND** the restore message indicates that `.gitmodules` metadata was updated

### Requirement: Root topology finalization
The system SHALL make the source registration commit for `oms sync` and `oms unsync` opt-in. One optional boolean `autoCommit` in `oms.yaml` SHALL default to false and govern both commands, including delegated sync. On direct invocations, `--commit` or `--no-commit` SHALL override that setting for the invocation. The decision SHALL be independent of terminal availability and SHALL NOT prompt. Enabled commits remain path-limited and subject to the existing safety conditions. With commits disabled, OMS SHALL leave staging to the Git operations that perform registration, removal, or restoration. OMS SHALL NOT add a staging-only refusal, undo staging, or inspect and report staging separately at runtime. Existing conflict, in-progress operation, checkout safety, and prior commit recovery checks still apply. Help and user documentation SHALL explain that Git can change staging on affected paths, including paths that were already staged.

#### Scenario: Sync leaves registration and metadata changes unstaged by default
- **WHEN** the user runs `oms sync api` without a commit flag and `autoCommit` is omitted or false
- **AND** synchronization succeeds with source registration or managed metadata changes
- **THEN** the command creates no root commit, retains staging produced by Git, and does not emit a staging notice
- **AND** unrelated staged root changes stay staged
- **AND** the command tells the user that `oms sync api --commit` can finalize the changes

#### Scenario: Unsync leaves removal unstaged by default
- **WHEN** the user runs `oms unsync api` without a commit flag and `autoCommit` is omitted or false
- **AND** the removal succeeds
- **THEN** the command retains the staged removal, creates no root commit, and does not emit a staging notice
- **AND** unrelated staged root changes stay staged
- **AND** the command tells the user that `oms unsync api --commit` can finalize the removal

#### Scenario: Sync creates one root commit by default
- **WHEN** the workspace has opted into automatic commits with `autoCommit: true` and the user runs `oms sync api` without a commit flag
- **AND** synchronization succeeds with eligible registration or metadata changes
- **THEN** sync creates one path-limited root commit without prompting
- **AND** the commit includes successful registration and reconciled metadata changes and the complete current `oms.yaml` when changed

#### Scenario: Unsync creates the topology commit by default
- **WHEN** the workspace has opted into automatic commits with `autoCommit: true` and the user runs `oms unsync api` without a commit flag
- **AND** removal succeeds and passes the commit safety checks
- **THEN** unsync creates one path-limited root commit without prompting with the message `chore(oms): remove api submodule`

#### Scenario: Commit flag overrides a disabled default
- **WHEN** the user runs `oms sync api --commit` or `oms unsync api --commit` with `autoCommit` omitted or false
- **AND** eligible changes exist and the commit safety checks pass
- **THEN** the command creates the appropriate root registration commit without prompting

#### Scenario: Conflicting commit flags are rejected before mutation
- **WHEN** `oms sync` or `oms unsync` is invoked with both `--commit` and `--no-commit` in either order
- **THEN** OMS exits non-zero and identifies the conflicting options before registering, removing, staging, or committing anything

#### Scenario: No-commit operations leave affected staging to Git
- **WHEN** a no-commit sync or unsync affects a path already staged or with pre-existing working-tree edits, such as a partially staged `.gitmodules`
- **THEN** OMS does not refuse solely because of staging or the possibility of restaging those edits
- **AND** accepts the resulting staging if Git succeeds, or reports the operation failure if Git refuses it

#### Scenario: No-commit rerun does not rewrite existing staging
- **WHEN** `oms sync api` with root commits disabled selects an already prepared registration and no operation needs to write its index entries
- **THEN** existing staging does not by itself block the run or change the index
- **AND** metadata-only reconciliation does not stage `.gitmodules`

#### Scenario: No-commit sync can restore a staged pending removal
- **WHEN** `oms sync api` with root commits disabled selects a staged pending removal
- **AND** the existing operation safety checks pass
- **THEN** OMS does not block solely because the removal is staged
- **AND** leaves the staging outcome of restoration as-is without making a root commit

#### Scenario: No-commit partial removal keeps Git staging
- **WHEN** a no-commit `unsync` stages a removal for one alias and another alias fails
- **THEN** OMS does not create a root commit or undo the staging
- **AND** reports the failed aliases without a separate staging notice

#### Scenario: Sync leaves OMS root changes unstaged with --no-commit
- **WHEN** `autoCommit` is true and the user runs `oms sync api --no-commit`
- **AND** sync succeeds with source registration or managed metadata changes
- **THEN** sync retains staging produced by Git and creates no root commit
- **AND** unrelated staged root changes stay staged

#### Scenario: Unsync leaves topology changes unstaged with --no-commit
- **WHEN** `autoCommit` is true and the user runs `oms unsync api --no-commit`
- **AND** the removal succeeds
- **THEN** unsync retains the staged removal and creates no root commit
- **AND** unrelated staged root changes stay staged
- **AND** unsync tells the user that `oms unsync api --commit` can finalize the removal

#### Scenario: Topology finalization does not depend on a terminal
- **WHEN** a sync or unsync invocation with the same selection, flags, manifest, and repository state is run with or without a terminal
- **THEN** the root commit decision is identical and never requires a commit confirmation

#### Scenario: Sync commits detected pending state
- **WHEN** an earlier sync left registration or managed metadata changes pending
- **AND** the user reruns `oms sync api` with an enabled root commit
- **THEN** the command validates the pending state against root HEAD, the working tree, `.gitmodules`, and `oms.yaml`
- **AND** creates the root commit for that pending state after successful validation

#### Scenario: Unsync commits detected pending topology
- **WHEN** an earlier unsync left the removal of api pending
- **AND** the user reruns `oms unsync api` with an enabled root commit
- **THEN** the command detects the pending removal and creates the root commit after successful validation

#### Scenario: Sync commit flag is accepted as a no-op
- **WHEN** `autoCommit` is true and the user runs `oms sync api --commit` with eligible changes
- **THEN** sync makes the same commit decision it would make without the flag

#### Scenario: Unsync commit flag is accepted as a no-op
- **WHEN** `autoCommit` is true and the user runs `oms unsync api --commit` with eligible changes
- **THEN** unsync makes the same commit decision it would make without the flag

#### Scenario: Delegated preparation sync commits its topology
- **WHEN** another command successfully delegates to sync after the user approves registration and `autoCommit` is true
- **AND** the registration changes pass the commit safety checks
- **THEN** sync creates a root registration commit and the requesting command can continue

#### Scenario: Delegated preparation without opt-in does not commit
- **WHEN** another command successfully delegates to sync after the user approves registration and `autoCommit` is omitted or false
- **THEN** Git's staging is retained and a valid pending registration is usable by the requesting command, without a commit or a second prompt

#### Scenario: Invalid commit setting is rejected before changes
- **WHEN** `oms.yaml` supplies `autoCommit` with a non-boolean value
- **THEN** OMS reports the invalid setting and performs no registration, removal, staging, or commit

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
- **AND** the commit message is `chore(oms): add submodules`

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

#### Scenario: Sync commit preserves unrelated staged root changes
- **WHEN** the real root index has staged paths other than `.gitmodules` before sync
- **AND** the command creates its root commit
- **THEN** the temporary commit index excludes unrelated staged paths other than `oms.yaml`
- **AND** those excluded paths remain staged in the real index after the sync commit
- **AND** staged `oms.yaml` is replaced by and consumed as the complete current working-tree manifest
- **AND** a selected OMS path is consumed only when its staged blob and mode exactly match the validated commit result

#### Scenario: Unsync topology commit rejects unrelated staged root changes
- **WHEN** the root index has staged paths unrelated to selected unsync topology paths
- **AND** the command would create the topology commit
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
