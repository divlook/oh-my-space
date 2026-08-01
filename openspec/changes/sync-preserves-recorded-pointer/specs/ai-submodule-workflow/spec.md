## MODIFIED Requirements

### Requirement: Existing submodule metadata reconciliation
The system SHALL reconcile an existing or restored selected submodule's OMS-managed `.gitmodules` URL and branch metadata from `oms.yaml` after topology mutation and baseline validation, then include successful plans in the same root commit-or-unstage finalization as successful topology. When sync encounters a detached submodule `HEAD`, it SHALL attach the resolved baseline only when the attachment preserves the checked-out commit; otherwise it SHALL preserve the detached commit and root gitlink, report the divergent baseline, and provide explicit branch-switch and pull guidance.

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
