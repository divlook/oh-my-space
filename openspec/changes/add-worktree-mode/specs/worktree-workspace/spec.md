## ADDED Requirements

### Requirement: Workspace-wide repository mode
The system SHALL accept top-level `mode` values `submodule` and `worktree`, SHALL treat an omitted mode as `submodule`, and SHALL apply one mode to every repository in the workspace without per-repository overrides.

#### Scenario: Existing manifest keeps submodule behavior
- **WHEN** a valid existing `oms.yaml` omits `mode`
- **THEN** OMS treats the workspace as `submodule`
- **AND** does not create worktree-mode storage

#### Scenario: Worktree mode is explicit
- **WHEN** `oms.yaml` contains `mode: worktree`
- **THEN** OMS manages every declared repository with the worktree-mode contract
- **AND** does not create root gitlinks or `.gitmodules` entries

#### Scenario: Per-repository mode is rejected
- **WHEN** a repository entry contains a `mode` key
- **THEN** manifest validation fails with an unknown-key diagnostic

### Requirement: Portable common repository layout
For each synced worktree-mode alias, the system SHALL store a bare common repository at `.oms/repos/<alias>.git` and managed linked worktrees at `oms/<alias>/<name>`. It MUST require Git 2.48 or newer, enable relative worktree paths, and reject non-portable worktree names longer than 64 ASCII bytes.

#### Scenario: New common repository is initialized deterministically
- **WHEN** a declared alias has no common repository and sync provisions it
- **THEN** OMS initializes an empty bare repository at `.oms/repos/<alias>.git`
- **AND** configures relative worktree paths
- **AND** configures declared remotes and explicit remote-tracking fetch refspecs before fetching
- **AND** does not create local branches merely by cloning remote heads

#### Scenario: Whole workspace moves
- **WHEN** a synced worktree workspace and all its contents are moved to another filesystem path supported by Git
- **THEN** its managed worktrees continue resolving their common repository through relative metadata
- **AND** normal status and Git commands do not require repair solely because the workspace root moved

#### Scenario: Git is too old
- **WHEN** the installed Git version is older than 2.48
- **THEN** OMS fails before sync, mode transition, or managed repository mutation
- **AND** explains that relative worktree metadata requires Git 2.48 or newer

#### Scenario: Portable name validation
- **WHEN** a requested worktree name contains a separator, uppercase or non-ASCII characters, a Windows-reserved basename, an unsafe path component, or a case-insensitive collision
- **THEN** OMS exits 1 before creating or moving a worktree
- **AND** explains the portable single-slug and 64-ASCII-byte naming rule

#### Scenario: Complete path exceeds host limits
- **WHEN** a valid slug would produce a common-repository or worktree path unsupported by the host filesystem
- **THEN** OMS exits 1 before mutation
- **AND** identifies the host path-limit failure separately from slug validation

#### Scenario: Branch name normalization is deterministic
- **WHEN** OMS derives a name without `--name`
- **THEN** it lowercases ASCII letters, replaces each run of non-alphanumeric characters with one `-`, and trims leading and trailing separators
- **AND** `Feature/login_v2`, `fix..cache`, and ` release ` normalize to `feature-login-v2`, `fix-cache`, and `release`
- **AND** an empty, reserved, overlong, or colliding result requires an explicit valid name

### Requirement: Managed storage ownership and containment
The system SHALL assign each workspace an atomic random mode-independent ownership ID on its first post-init mutation and SHALL mutate or delete worktree storage only when ownership metadata, alias metadata, common-dir identity, worktree registration, canonical containment, and expected path type all agree. A workspace without an ID SHALL bootstrap exactly one ID while holding the provisional canonical-target mutation lock.

#### Scenario: Existing workspace bootstraps identity once
- **WHEN** a new or existing manifest has no `.oms/workspace.json` and a post-init mutation starts
- **THEN** OMS locks the canonical manifest directory using its credential-free target hash
- **AND** rechecks absence and atomically creates exactly one random workspace ID before later mutation preflight
- **AND** concurrent first mutations cannot create different IDs

#### Scenario: New workspace records ownership
- **WHEN** worktree-mode storage is first created
- **THEN** OMS atomically creates or reuses the already bootstrapped local ownership record under `.oms/`
- **AND** records the same workspace ID and alias in each managed common repository without copying credentials

#### Scenario: Foreign common repository blocks sync
- **WHEN** `.oms/repos/api.git` exists without matching OMS ownership and alias metadata
- **THEN** sync exits 1 before changing its config, refs, or contents
- **AND** force does not bypass the ownership failure

#### Scenario: Occupied checkout path blocks creation
- **WHEN** a target checkout path is tracked, staged, occupied by a foreign repository or user data, unreadable, or not registered to the expected common repository
- **THEN** OMS fails before adding exclude rules or modifying the path

#### Scenario: Symlinked managed path fails closed
- **WHEN** any component of `.oms`, the common repository path, alias directory, or managed worktree path is a symbolic link or resolves outside the workspace
- **THEN** OMS refuses mutation and deletion with or without force
- **AND** reports the ambiguous ownership boundary

### Requirement: Initial worktree provisioning
The first successful sync of a worktree-mode alias SHALL reconcile and attempt to fetch all declared remotes before creating one attached managed worktree from the configured baseline branch or resolved `origin/HEAD`. It SHALL track credential-free atomic per-alias provisioning phases under `.oms/provisioning/`, resume incomplete phases idempotently, and retain `complete` after all worktrees are intentionally removed. Origin fetch success SHALL be required. Failure of another declared remote SHALL permit creation only when an interactive user explicitly accepts degraded provisioning. The baseline SHALL be a default for initial and new-branch creation, not a revision pin or an ongoing checkout mandate.

#### Scenario: Provisioning phase distinguishes retry from intentional absence
- **WHEN** an alias has an owned common repository and atomic provisioning state in `common-ready`, `branch-ready`, or `worktree-created`
- **THEN** sync revalidates the recorded ownership, branch, target path, common-dir, and registration before idempotently resuming the incomplete phase
- **AND** when state is `complete`, sync never recreates an intentionally removed last worktree

#### Scenario: Interruption before completion adopts only matching state
- **WHEN** interruption occurs after the first owned worktree is durably registered but before provisioning state becomes `complete`
- **THEN** retry adopts that worktree only when its recorded branch, path, common-dir, ownership, and registration all match
- **AND** atomically marks the alias `complete` without creating a duplicate

#### Scenario: Provisioning state conflict fails closed
- **WHEN** an existing common repository has missing, malformed, wrong-ownership, or Git-conflicting provisioning state
- **THEN** sync exits 1 before creating a worktree or changing refs
- **AND** provides bounded doctor guidance

#### Scenario: Explicit baseline creates the first checkout
- **WHEN** a new alias declares branch `feature/login`
- **AND** every declared remote fetch succeeds
- **THEN** sync creates a tracking local branch from `origin/feature/login`
- **AND** creates the first worktree under the normalized name `feature-login`

#### Scenario: Omitted baseline follows origin HEAD
- **WHEN** a new alias omits `branch`
- **AND** fetched `origin/HEAD` resolves to `origin/main`
- **THEN** sync creates the first managed worktree for local branch `main`

#### Scenario: Origin HEAD cannot be resolved
- **WHEN** a new alias omits `branch`
- **AND** `origin/HEAD` cannot be resolved after fetch
- **THEN** sync preserves the common repository
- **AND** creates no worktree
- **AND** exits 1 with guidance to declare a branch or repair the remote default

#### Scenario: Additional remote fails interactively
- **WHEN** origin fetch succeeds during initial sync but another declared remote fetch fails
- **AND** the command is interactive
- **THEN** OMS offers continue with degraded remote state or cancel
- **AND** continuing creates the first worktree, prints the failed remote, and exits 0
- **AND** cancelling creates no worktree and exits 1

#### Scenario: Additional remote fails non-interactively
- **WHEN** origin fetch succeeds during initial sync but another declared remote fetch fails
- **AND** stdin is non-interactive
- **THEN** OMS creates no worktree
- **AND** exits 1 without guessing whether degraded provisioning is acceptable

#### Scenario: Origin fetch fails during initial provisioning
- **WHEN** origin fetch fails while provisioning a new alias
- **THEN** OMS preserves the owned common repository and any safely fetched objects
- **AND** creates no local branch or worktree
- **AND** exits 2 with a credential-redacted diagnostic and exact retry guidance

#### Scenario: Initial sync fails operationally
- **WHEN** fetch or worktree creation fails operationally
- **THEN** OMS preserves the reusable common repository and fetched objects
- **AND** removes any incomplete worktree directory that it created
- **AND** reports the preserved state and retry command

### Requirement: Non-authoritative subsequent sync
After a worktree-mode common repository exists, sync SHALL reconcile and fetch/prune all declared remotes, prune only safe stale managed registrations, and SHALL NOT move local branches or recreate removed worktrees.

#### Scenario: Sync leaves checkout commits unchanged
- **WHEN** one or more managed worktrees are behind their remote-tracking branches
- **AND** the user runs sync
- **THEN** remote-tracking refs are refreshed
- **AND** every managed worktree HEAD and local branch tip remains unchanged

#### Scenario: Removed first worktree remains removed
- **WHEN** the first worktree was intentionally removed
- **AND** the user runs sync again
- **THEN** sync does not recreate it even when no managed worktrees remain

#### Scenario: Existing baseline disappeared
- **WHEN** the configured baseline no longer exists on origin after an existing alias is fetched
- **THEN** sync warns that future default branch creation may fail
- **AND** completes remote synchronization without moving or deleting local state

#### Scenario: Missing managed registration is safe to prune
- **WHEN** a registered managed worktree path is absent
- **AND** no moved directory or repair ambiguity is detected
- **THEN** sync prunes that managed stale registration automatically

#### Scenario: Possible manual move blocks prune
- **WHEN** a missing registration may correspond to a manually moved worktree directory
- **THEN** sync stops before destructive prune
- **AND** provides doctor or `git worktree repair` guidance

### Requirement: Managed worktree creation
The system SHALL provide `oms worktree add [alias] [branch]` with optional `--name`, `--from`, and `--remote`, creating one attached worktree for a unique local branch and never forcing Git's checked-out-branch protection.

#### Scenario: Existing local branch is attached
- **WHEN** the requested branch exists locally and is not checked out in another worktree
- **THEN** OMS creates the named worktree attached to that local branch

#### Scenario: Remote branch becomes tracking branch
- **WHEN** the requested branch does not exist locally
- **AND** it exists on the selected remote
- **THEN** OMS creates a same-named local branch tracking the selected remote branch
- **AND** attaches the new worktree to it

#### Scenario: New branch uses an explicit start point
- **WHEN** the requested branch exists neither locally nor on the selected remote
- **AND** `--from <ref>` is supplied
- **THEN** OMS validates the ref and creates the attached local branch from it

#### Scenario: New branch uses baseline default
- **WHEN** the requested branch exists neither locally nor on the selected remote
- **AND** `--from` is omitted
- **THEN** OMS creates it from the configured baseline or resolved `origin/HEAD`

#### Scenario: Name is derived from branch
- **WHEN** `--name` is omitted for branch `Feature/login_v2`
- **THEN** OMS normalizes the name to `feature-login-v2`
- **AND** validates it before mutation

#### Scenario: Derived or explicit name collides
- **WHEN** the resulting managed name already exists
- **THEN** OMS exits 1 without returning the existing worktree or generating a suffix
- **AND** asks the user to choose another name or use the existing target

#### Scenario: Branch is already checked out
- **WHEN** the requested local branch is attached to another managed or external worktree
- **THEN** OMS exits 1 without using force
- **AND** reports the existing checkout path

#### Scenario: Omitted add inputs are interactive
- **WHEN** alias or branch is omitted in a TTY
- **THEN** OMS collects the missing alias and existing-or-new branch decision interactively
- **AND** proceeds after the user supplies intent

#### Scenario: Omitted add inputs are non-interactive
- **WHEN** alias or branch is omitted outside a TTY
- **THEN** OMS exits 1 and identifies every required argument

### Requirement: Selected-remote refresh and trusted cached fallback
Before add or branch checkout, OMS SHALL validate and reconcile declared remote configuration and fetch/prune the selected declared remote. It SHALL use a cached remote-tracking ref after fetch failure only when durable credential-free provenance proves that the current endpoint and refspec match the last complete successful fetch.

#### Scenario: Selected remote defaults to origin
- **WHEN** add or branch checkout omits `--remote`
- **THEN** OMS selects origin and fetches only origin before resolving the requested remote branch

#### Scenario: Declared remote override
- **WHEN** `--remote upstream` names a declared remote
- **THEN** OMS reconciles all declared remote configuration
- **AND** fetches upstream for the requested operation

#### Scenario: Cached branch survives fetch failure
- **WHEN** selected-remote fetch fails
- **AND** a usable cached selected-remote branch exists
- **AND** its endpoint and refspec match the last successful-fetch provenance
- **THEN** OMS completes add or checkout from the cached ref
- **AND** prints a stale-data warning
- **AND** exits 0

#### Scenario: URL drift invalidates cache
- **WHEN** OMS changes the selected remote URL to match the manifest
- **AND** fetching the new URL fails
- **THEN** OMS does not use remote-tracking refs obtained from the previous URL
- **AND** exits 2 without creating or switching a worktree

#### Scenario: URL drift remains untrusted across processes
- **WHEN** an endpoint or refspec change is followed by a failed fetch or process interruption
- **AND** a later OMS process retries while old remote-tracking refs still exist
- **THEN** those refs remain untrusted
- **AND** only a complete successful fetch of the current declared endpoint atomically restores trusted provenance

### Requirement: Safe declared remote endpoints
Every worktree-mode network command SHALL validate and reconcile its effective endpoint before network access. `origin` SHALL remain required, declared remotes SHALL have one authoritative fetch and push endpoint, automatic upstream use SHALL be limited to declared remotes, and network Git configuration SHALL be sanitized against rewrite and environment injection.

#### Scenario: Credential-bearing manifest URL is rejected
- **WHEN** worktree mode declares an HTTP(S) URL with userinfo, any URL password, or query or fragment components
- **THEN** manifest validation exits 1 before writing common-repository config or accessing the network
- **AND** points to credential-helper or SSH-agent authentication
- **AND** permits non-secret SSH usernames and SCP-style SSH locations

#### Scenario: Additional URL or pushurl drift is rejected or removed safely
- **WHEN** a declared remote has additional fetch URLs or a `pushurl` that differs from its manifest endpoint
- **THEN** OMS does not fetch from or push to that undeclared endpoint
- **AND** reconciles safely or exits before network access

#### Scenario: Undeclared upstream is not automatic
- **WHEN** a local branch tracks a remote absent from the manifest
- **THEN** pull or push does not use that upstream automatically
- **AND** requires an explicit declared remote choice

#### Scenario: Executable transport is rejected
- **WHEN** a declared or orphan-configured remote uses `ext::` or another transport that executes an external helper outside the supported URL policy
- **THEN** OMS exits before invoking the transport
- **AND** does not print embedded credentials

#### Scenario: Git URL rewrite cannot redirect a network operation
- **WHEN** system, global, local, command, or environment Git configuration defines `insteadOf`, `pushInsteadOf`, or a `GIT_CONFIG_*` injection that would change the declared endpoint
- **THEN** OMS does not execute the rewritten endpoint
- **AND** runs network Git under sanitized immutable configuration or exits before network access

#### Scenario: Effective endpoint is validated and recorded
- **WHEN** OMS is ready to fetch or push
- **THEN** it resolves the final effective endpoint under the same sanitized configuration used for execution
- **AND** validates its transport and host/path immediately before use
- **AND** binds successful-fetch provenance to that credential-free effective endpoint

### Requirement: Worktree inventory and movement
The system SHALL provide human-readable `oms worktree list [alias]` and `oms worktree move <alias/name> <new-name>`. Listing SHALL include managed and external linked worktrees; moving SHALL change only a managed worktree's portable name and path.

#### Scenario: List all worktrees
- **WHEN** the user runs `oms worktree list`
- **THEN** OMS shows every declared alias, its managed worktree names, branches, and paths
- **AND** shows aliases with no worktrees
- **AND** marks external linked worktrees as external

#### Scenario: List remains human-readable only
- **WHEN** a machine consumer needs worktree inventory
- **THEN** the supported machine-readable contract is `oms status --json`
- **AND** `oms worktree list` does not define a second JSON schema

#### Scenario: Move a dirty idle worktree
- **WHEN** a managed worktree has dirty files but no Git operation in progress
- **AND** the user moves it to an available valid name
- **THEN** OMS moves it with Git's worktree operation
- **AND** preserves its branch, index, working files, and relative metadata

#### Scenario: Move rejects in-progress operation
- **WHEN** merge, rebase, cherry-pick, revert, bisect, or sequencer state is active in the target worktree
- **THEN** OMS exits 1 without moving it
- **AND** asks the user to resolve, continue, or abort the operation

### Requirement: Resumable worktree lifecycle failures
Worktree add, move, remove, and multi-alias unsync SHALL define explicit mutation phases, SHALL avoid blind filesystem deletion after Git failure, and SHALL report enough preserved identity to retry or diagnose partial state safely.

#### Scenario: Branch creation succeeds before add fails
- **WHEN** OMS creates a local branch but linked-worktree creation fails
- **THEN** the local branch and its full OID remain preserved
- **AND** OMS removes only an incomplete directory proven to belong to the failed invocation
- **AND** reports the retained branch and retry command

#### Scenario: Move fails after one side changes
- **WHEN** worktree move changes a path or registration before a later step fails
- **THEN** OMS does not guess by recursively moving or deleting paths
- **AND** reports actual canonical path and registration state with doctor or resume guidance

#### Scenario: Remove fails partially
- **WHEN** Git removes a worktree directory or registration but not both
- **THEN** OMS preserves the remaining state
- **AND** exits 2 with an idempotent retry or bounded repair action

#### Scenario: Multi-alias unsync fails after earlier success
- **WHEN** unsync processes multiple aliases and a later operational deletion fails after an earlier alias completed
- **THEN** OMS reports completed and incomplete aliases separately
- **AND** rerunning unsync treats the completed absence as a safe no-op rather than unexpected loss

### Requirement: Safe managed worktree removal
`oms worktree remove <alias/name>` SHALL remove only a managed checkout, preserve its local branch and upstream configuration, and protect dirty or locked state.

#### Scenario: Remove a clean managed worktree
- **WHEN** the selected managed worktree is clean, unlocked, and idle
- **THEN** OMS removes its directory and linked-worktree registration
- **AND** preserves the local branch and upstream configuration

#### Scenario: Unpublished branch does not block removal
- **WHEN** the selected worktree is clean and its local branch has commits absent from all remotes
- **THEN** removal is allowed because the local branch remains in the common repository

#### Scenario: Dirty removal requires force
- **WHEN** the selected managed worktree has staged, unstaged, or untracked changes
- **THEN** removal without force exits 1 before deletion
- **AND** removal with force warns about discarded files and may proceed

#### Scenario: In-progress removal requires force
- **WHEN** the selected managed worktree has an in-progress Git operation
- **THEN** removal without force exits 1
- **AND** removal with force names the operation and may proceed

#### Scenario: Ignored or nested data requires force
- **WHEN** a managed worktree contains ignored files, ignored directories, or a nested repository
- **THEN** removal without force exits 1 even when porcelain status is otherwise clean
- **AND** force reports counts and affected categories before deletion without printing sensitive contents

#### Scenario: Detached unpublished HEAD is protected
- **WHEN** a managed worktree was detached by raw Git
- **AND** its HEAD is not durably reachable from a retained local ref or fresh declared remote ref
- **THEN** removal without force exits 1
- **AND** reports the full OID and a branch-creation recovery command

#### Scenario: Locked worktree cannot be forced
- **WHEN** the selected managed worktree is locked
- **THEN** removal fails with or without force
- **AND** instructs the user to unlock it explicitly

#### Scenario: External worktree cannot be removed
- **WHEN** a target resolves to an external linked worktree
- **THEN** OMS refuses to remove or move it
- **AND** identifies it as outside OMS mutation scope

### Requirement: Mode-aware repository commands
In worktree mode, repository commands SHALL distinguish alias-scoped and `alias/name`-scoped operations and SHALL resolve omitted checkout targets by explicit argument, current path, sole command-viable managed worktree, or interactive selection in that order. Explicit aliases SHALL restrict inference to that alias. Every candidate SHALL pass ownership, registration, canonical-containment, existing-path, readability, and Git-state checks; commit SHALL additionally require attached idle state, pull attached idle clean state, push attached idle state, and branch switch or checkout idle state while permitting detached-HEAD recovery.

#### Scenario: Checkout target inferred from current path
- **WHEN** the user runs commit, pull, push, branch switch, or branch checkout below `oms/api/login/` without a target
- **AND** the current worktree is viable for that command
- **THEN** OMS resolves target `api/login`

#### Scenario: Ineligible current target requires explicit interactive reselection
- **WHEN** a target-scoped command is run without a target inside a managed worktree that is not viable for that command
- **THEN** OMS identifies the current target and its detached, dirty, operation, ownership, registration, path, readability, or Git-state reason
- **AND** interactive use may explicitly select another viable target
- **AND** non-interactive use exits 1 without selecting another target
- **AND** an explicit target never falls back

#### Scenario: Sole managed worktree is selected
- **WHEN** a checkout-scoped command omits its target outside managed worktree paths
- **AND** exactly one managed worktree is viable for that command within the explicit alias or workspace-wide candidate scope
- **THEN** OMS selects it and explains the automatic selection

#### Scenario: Ineligible worktree is not silently selected
- **WHEN** a managed worktree fails the requested command's detached, dirty, operation, ownership, registration, path, readability, or Git-state viability rule
- **THEN** automatic and interactive selection exclude it
- **AND** the diagnostic or selector identifies the reason

#### Scenario: Multiple targets are interactive
- **WHEN** multiple viable managed worktrees exist and stdin is a TTY
- **THEN** OMS presents a target selector

#### Scenario: Multiple targets are non-interactive
- **WHEN** multiple viable managed worktrees exist and stdin is non-interactive
- **THEN** OMS exits 1 without guessing
- **AND** shows the required `alias/name` syntax

#### Scenario: Commit remains checkout-local
- **WHEN** `oms commit api/login -m "feat: login"` creates a commit
- **THEN** it commits only the selected worktree's staged changes or stages all changes there when none are staged
- **AND** it does not modify an enclosing Git repository or print an `oms record` hint

#### Scenario: Record is unavailable
- **WHEN** the user runs `oms record` in worktree mode
- **THEN** OMS exits 1
- **AND** explains that worktree mode has no parent gitlink pointer to record

### Requirement: Mode-aware branch workflows
Worktree mode SHALL support repository-wide branch inventory and deletion plus target-specific switch and checkout without bypassing attached-worktree or baseline protection.

#### Scenario: Branch inventory includes checkout locations
- **WHEN** the user runs `oms branch list api`
- **THEN** OMS shows local and declared-remote branches from the common repository
- **AND** identifies every managed or external worktree where a local branch is checked out

#### Scenario: Switch changes one managed target
- **WHEN** the user runs `oms branch switch api/login feature/other`
- **THEN** OMS switches only that managed worktree
- **AND** rejects the switch if `feature/other` is checked out elsewhere

#### Scenario: Checkout accepts declared remote
- **WHEN** the user runs `oms branch checkout api/login dev --remote upstream`
- **THEN** OMS applies selected-remote refresh and cached fallback rules
- **AND** switches the target to a local branch tracking `upstream/dev`

#### Scenario: Branch deletion is repository-scoped
- **WHEN** the user runs `oms branch delete api feature/old`
- **THEN** OMS deletes the local branch from the common repository using existing safe-or-force semantics
- **AND** does not require a worktree target

#### Scenario: Checked-out branch is protected everywhere
- **WHEN** a local branch is attached to any managed or external worktree
- **THEN** branch deletion fails before Git deletion with the checkout path

#### Scenario: Baseline branch is protected
- **WHEN** a branch is the configured baseline or resolved origin default
- **THEN** branch deletion fails with or without force

### Requirement: Mode-aware fetch, pull, and push
Worktree mode SHALL fetch at repository scope and pull or push at managed-worktree scope without moving unrelated checkouts.

#### Scenario: Fetch defaults to every declared remote
- **WHEN** the user runs `oms fetch api` without `--remote`
- **THEN** OMS reconciles and fetches/prunes every declared remote

#### Scenario: Subsequent sync and fetch aggregate remote failures
- **WHEN** subsequent sync or default fetch encounters an operational failure for one declared remote
- **THEN** OMS attempts every remaining selected remote and reports per-remote results
- **AND** preserves successful remote-tracking updates and exits 2
- **AND** a rerun fetches every selected remote and reports already-current refs normally

#### Scenario: Pull follows upstream first
- **WHEN** a selected worktree branch has an upstream
- **THEN** pull uses that upstream with fast-forward-only behavior
- **AND** if no upstream exists, it falls back to same-named origin branch or exits when unavailable

#### Scenario: Pull all excludes external worktrees
- **WHEN** the user runs `oms pull --all`
- **THEN** OMS attempts every managed worktree independently
- **AND** does not pull external linked worktrees

#### Scenario: Pull all aggregates target results
- **WHEN** one or more managed worktrees fail or refuse pull during `oms pull --all`
- **THEN** OMS still attempts every remaining managed worktree and reports per-target results
- **AND** exits 2 if any operational failure occurred, otherwise exits 1 if any safety refusal occurred, otherwise exits 0
- **AND** a rerun reports already-current worktrees as successful results

#### Scenario: Push follows upstream first
- **WHEN** a selected worktree branch has an upstream
- **THEN** push uses that upstream
- **AND** if no upstream exists, it pushes the same branch to origin and sets upstream

#### Scenario: Multiple push remotes are independent
- **WHEN** multiple `--remote` values are supplied
- **THEN** OMS attempts every selected remote even after one fails
- **AND** reports per-remote results and exits non-zero if any failed

### Requirement: Destructive alias removal safety
Worktree-mode unsync SHALL remove every managed worktree and its common repository only after proving that no protected external or locked worktree exists and that local work is safe, unless force explicitly accepts managed local loss.

#### Scenario: Clean published alias is unsynced
- **WHEN** all managed worktrees are clean and idle
- **AND** every local commit is reachable from a freshly fetched declared remote-tracking ref
- **AND** no external or locked worktree exists
- **THEN** unsync removes managed worktrees and the common repository

#### Scenario: Dirty or unpublished state blocks ordinary unsync
- **WHEN** any managed worktree is dirty or in progress
- **OR** a local commit is unreachable from every freshly fetched declared remote-tracking ref
- **THEN** unsync exits 1 without deleting alias state
- **AND** identifies the blocking worktree, branch, and recoverable OIDs

#### Scenario: Ignored and nested local data blocks ordinary unsync
- **WHEN** any managed worktree contains ignored local data or a nested repository
- **THEN** ordinary unsync exits 1 before deletion
- **AND** identifies counts and categories without exposing sensitive contents

#### Scenario: Every local ref namespace is protected
- **WHEN** the common repository contains local branches, worktree HEADs, tags, stash, notes, replace refs, custom refs, reflog-only commits, or recoverable dangling objects
- **THEN** ordinary unsync verifies publication without reducing the check to branch tips
- **AND** local metadata refs or objects whose identity or content cannot be reconstructed from freshly inspected declared remotes block deletion

#### Scenario: Force discloses all local object kinds
- **WHEN** force waives unpublished common-repository data
- **THEN** OMS reports each protected object kind, refname when present, and full OID
- **AND** does not describe branch-only reachability as complete protection

#### Scenario: Remote verification fails closed
- **WHEN** a declared remote cannot be fetched before ordinary unsync
- **THEN** OMS refuses to infer publication from stale refs
- **AND** exits non-zero with retry or force guidance

#### Scenario: Force accepts managed local loss
- **WHEN** the user supplies `--force`
- **AND** only managed dirty, unpublished, or in-progress state blocks removal
- **THEN** OMS prints the affected operations, branches, and full OIDs before deletion
- **AND** proceeds without a second confirmation

#### Scenario: External worktree always blocks unsync
- **WHEN** any external linked worktree is registered for the alias
- **THEN** unsync fails with or without force
- **AND** instructs the user to detach it with Git before retrying

#### Scenario: Locked worktree always blocks unsync
- **WHEN** any linked worktree is locked
- **THEN** unsync fails with or without force
- **AND** instructs the user to unlock it explicitly

### Requirement: Orphan alias cleanup
Explicit worktree-mode unsync SHALL recognize a safely identifiable managed common repository whose alias is absent from the manifest, while automatic selections and `--all` SHALL remain limited to declared aliases.

#### Scenario: Explicit orphan cleanup
- **WHEN** `api` is absent from the manifest but `.oms/repos/api.git` is a recognizable managed common repository
- **AND** the user runs `oms unsync api`
- **THEN** OMS applies normal external, lock, dirty, operation, and publication preflights
- **AND** uses every configured remote for publication verification

#### Scenario: All does not select orphan data
- **WHEN** orphan managed aliases exist
- **AND** the user runs `oms unsync --all`
- **THEN** only declared aliases are selected
- **AND** orphan data is preserved and diagnosed

#### Scenario: Alias rename is not inferred
- **WHEN** one manifest alias is removed and another with the same URL is added
- **THEN** OMS treats them as independent aliases
- **AND** does not move or rename local storage automatically

### Requirement: Explicit workspace mode transition
The system SHALL provide `oms mode switch <submodule|worktree>` to select transition-only or transition-plus-sync behavior before mutation, preflight and remove current-mode state, preserve recoverable pointer commits according to an explicit user choice, preserve YAML comments and formatting while changing only top-level mode, and complete the selected transition path under one resumable journal.

#### Scenario: Interactive transition selects a completion scope
- **WHEN** the user runs mode switch in a TTY without `--sync` or `--no-sync`
- **THEN** OMS offers transition only or transition plus target-mode sync before mutation
- **AND** explains whether target repositories will exist when the selected path completes
- **AND** completes the selected path without requiring an unplanned follow-up command

#### Scenario: Non-interactive transition requires an explicit scope
- **WHEN** the user runs mode switch non-interactively without `--sync` or `--no-sync`
- **THEN** OMS exits 1 before mutation
- **AND** prints the exact `--sync` and `--no-sync` alternatives

#### Scenario: Transition preflight is global
- **WHEN** any current-mode alias fails its normal removal preflight
- **THEN** mode switch removes nothing and leaves `oms.yaml` unchanged
- **AND** reports every blocking alias discovered by preflight

#### Scenario: Mutation lock serializes OMS operations
- **WHEN** another mutating OMS process owns the workspace lock
- **THEN** init, mode switch, sync, unsync, worktree add/move/remove, record, commit, fetch, pull, push, and branch switch/checkout/delete fail before mutation
- **AND** generic operations provide bounded doctor guidance rather than silently stealing a stale lock

#### Scenario: Init locks a provisional workspace identity
- **WHEN** init starts before a manifest or workspace ownership ID exists
- **THEN** it acquires `.oms-mutation.lock` in the canonical target directory using a credential-free canonical-target hash plus operation and process identity
- **AND** lock failure leaves the manifest, ownership state, and Git state unchanged
- **AND** successful init remains manifest-only while the first post-init mutation bootstraps persistent identity

#### Scenario: Interrupted mode switch recovers only its proven stale lock
- **WHEN** a mode-switch journal and mutation lock have matching workspace, operation, and transition identities
- **AND** PID plus process-start identity conclusively prove that the recorded owner is no longer running
- **THEN** a repeated mode-switch invocation compare-and-swap recovers the lock and continues journal validation
- **AND** an alive owner, ambiguous PID identity, malformed record, or identity mismatch stops without mutation and requires doctor guidance

#### Scenario: Mode switch binds provisional identity before journaling
- **WHEN** mode switch starts in a workspace without persistent identity
- **THEN** it atomically creates the ID under the provisional canonical-target lock
- **AND** compare-and-swap binds the still-owned lock to that ID before creating the transition journal or mutating topology
- **AND** interruption before binding or journal creation requires stale-lock doctor handling and leaves topology unchanged

#### Scenario: Lock survives worktree topology deletion
- **WHEN** mode switch removes owned `.oms/repos/`, `.oms/provisioning/`, fetch provenance, and every worktree-mode repository
- **THEN** the workspace-root `.oms-mutation.lock` remains held outside the deletion set
- **AND** mode-independent `.oms/workspace.json` remains unchanged
- **AND** ownership-marked local-exclude rules for `.oms/workspace.json`, `.oms-mutation.lock`, and `.oms-mode-switch.json` remain unchanged
- **AND** prevents another mutation until manifest cutover, exclude cleanup, journal completion, and final lock cleanup finish

#### Scenario: Destructive state is revalidated at deletion boundaries
- **WHEN** worktree inventory, ownership, canonical paths, lock state, refs, HEAD, local files, or Git operation state changes after preflight
- **THEN** OMS detects the change immediately before the affected deletion
- **AND** stops further deletion and reports resumable partial state

#### Scenario: Orphan blocks transition
- **WHEN** current-mode orphan managed aliases exist
- **THEN** mode switch fails before mutation
- **AND** identifies explicit orphan unsync commands

#### Scenario: Limited force transition
- **WHEN** `--force` is supplied
- **THEN** managed dirty, unpublished, or in-progress state may be removed after disclosure
- **AND** disclosure distinguishes committed, staged, checked-out, and local-ref OIDs that will not be preserved
- **AND** external or locked worktrees still block transition

#### Scenario: Target submodule mode requires Git root
- **WHEN** the user requests `mode switch submodule`
- **AND** the workspace root is not the canonical Git top-level
- **THEN** mode switch fails before removing worktree state or editing the manifest

#### Scenario: Transition-only selection stops without target topology
- **WHEN** mode switch completes with `--no-sync` or the equivalent interactive selection
- **THEN** current-mode storage is removed and the manifest mode is changed
- **AND** target-mode repositories are not created
- **AND** OMS reports that the selected transition-only outcome completed

#### Scenario: Transition-plus-sync selection creates target topology
- **WHEN** mode switch completes with `--sync` or the equivalent interactive selection
- **THEN** current-mode storage is removed, the manifest mode is changed, and every declared alias is provisioned in the target mode
- **AND** target provisioning and recovery remain phases of the same transition journal

#### Scenario: Submodule pointer roles are inventoried independently
- **WHEN** a submodule-to-worktree preflight finds different gitlink OIDs in root HEAD, the index, and the checked-out submodule HEAD
- **THEN** OMS identifies the state as split
- **AND** reports each committed, staged, and checked-out role with its full OID
- **AND** does not silently select one role as the only commit requiring protection

#### Scenario: Independent local refs and objects are inventoried
- **WHEN** a source submodule contains a branch not descending from any pointer OID, tags, stash, notes, replace or custom refs, or recoverable reflog-only or dangling objects
- **THEN** preflight inventories each ref or object independently before source deletion
- **AND** does not reduce preservation checks to pointer reachability or branch tips
- **AND** distinguishes remote commit reachability from reconstruction of ref identity and metadata

#### Scenario: Fully reconstructible submodule state needs no intervention
- **WHEN** every inventoried pointer, ref identity, metadata value, and required object closure is fully reconstructible from freshly fetched declared remotes
- **THEN** submodule-to-worktree transition proceeds without a publication or preservation prompt

#### Scenario: Non-reconstructible submodule state offers local preservation
- **WHEN** any locally available pointer, branch, tag, stash, notes, replace/custom ref, or recoverable reflog-only or dangling object is not fully reconstructible from freshly fetched declared remotes
- **AND** mode switch is interactive
- **THEN** OMS offers preservation in the target common repository or cancellation without mutation
- **AND** cancellation explains that suitable state may be published manually before rerunning mode switch
- **AND** mode switch never pushes or otherwise writes to a remote
- **AND** OMS verifies every preservation ref before continuing

#### Scenario: Preservation changes transition-only scope explicitly
- **WHEN** the user selected transition only and then selects preservation in a target common repository
- **THEN** OMS explains that preservation requires target sync
- **AND** offers to change the scope to transition plus sync or cancel before mutation

#### Scenario: Non-interactive unpublished state is explicit
- **WHEN** any inventoried submodule state is not fully reconstructible from declared remotes in non-interactive mode
- **AND** neither `--sync --preserve-local` nor `--force` was supplied
- **THEN** OMS exits 1 before mutation
- **AND** prints the exact preservation and force alternatives plus manual-publication guidance

#### Scenario: Preserved pointer OIDs survive source removal
- **WHEN** the user selects preservation during submodule-to-worktree transition
- **THEN** OMS imports non-conflicting local branches and safe metadata refs into a journal-owned staged common repository
- **AND** with replacement lookup disabled, copies the complete raw reachable object closure for every retained ref or anchor, including commit parents, trees, blobs, nested annotated-tag targets, and both objects named by each replace ref
- **AND** anchors otherwise unreferenced pointer, reflog-only, dangling, or namespace-conflicting OIDs under `refs/oms/mode-switch/<transition-id>/<kind>/<name>`
- **AND** verifies connectivity of the staged repository before source topology removal
- **AND** installs the staged repository at its owned target path during target sync without deleting the preservation refs

#### Scenario: Incomplete preservation closure keeps source topology
- **WHEN** a retained commit, tag, tree, blob, parent, replace-ref side, or anchored object is missing from the staged common repository
- **THEN** preservation exits 2 before source topology removal
- **AND** identifies the affected ref or anchor and missing object without claiming preservation succeeded

#### Scenario: Preserved baseline branch wins during target provisioning
- **WHEN** preservation installed a local baseline branch whose tip differs from the same-named remote branch
- **THEN** target sync attaches the first worktree to the preserved local branch without resetting its tip
- **AND** retains its upstream only when that upstream names a declared reconciled remote
- **AND** otherwise leaves the upstream unset and reports how to publish or set it later

#### Scenario: Unavailable pointer object is not claimed as preserved
- **WHEN** a root or index gitlink names an object unavailable locally and from freshly fetched declared remotes
- **THEN** OMS reports the role and full OID separately from unpublished available objects
- **AND** does not continue under a preservation choice that cannot copy the object
- **AND** provides publication, restoration, force when permitted, or cancellation guidance

#### Scenario: Prior root commits retain committed pointers
- **WHEN** submodule-to-worktree mode switch creates a new root transition tree or commit
- **THEN** prior root commits and their gitlink OIDs remain unchanged
- **AND** only the new transition tree removes the current gitlinks

#### Scenario: Sole worktree selects the target submodule pointer
- **WHEN** worktree-to-submodule transition plus sync finds exactly one viable managed worktree for an alias
- **THEN** OMS selects that worktree HEAD as the target gitlink OID
- **AND** verifies the OID in staged target storage before removing source topology

#### Scenario: Multiple worktrees require a pointer source choice
- **WHEN** worktree-to-submodule transition plus sync finds multiple viable managed worktrees for an alias
- **THEN** interactive use offers a per-alias `alias/name` selector
- **AND** non-interactive use exits before mutation unless one `--source <alias/name>` identifies the source for every ambiguous alias

#### Scenario: Alias without a worktree uses a fresh baseline
- **WHEN** worktree-to-submodule transition plus sync finds no viable managed worktree for an alias
- **THEN** OMS resolves its configured baseline only after a successful declared-remote refresh
- **AND** fails before mutation with repair guidance when no baseline commit can be resolved

#### Scenario: Unpublished selected worktree OID is copied before deletion
- **WHEN** the selected target gitlink OID is not available from freshly fetched declared remotes
- **AND** its object closure is available in the source common repository
- **THEN** OMS copies the commit and required objects into a journal-owned staged target submodule repository outside source deletion sets
- **AND** verifies the full OID and object closure before removing any source topology
- **AND** retains the selected attached branch and valid upstream or anchors the OID under a transition preservation ref

#### Scenario: Staged target submodule is installed at the selected OID
- **WHEN** source removal and manifest cutover follow successful selected-OID staging
- **THEN** target sync installs the verified staged repository at the expected Git module path
- **AND** checks out the selected OID
- **AND** stages a gitlink with exactly that OID

#### Scenario: Selected OID import failure preserves source topology
- **WHEN** copying or verifying a selected target gitlink OID or required object fails
- **THEN** mode switch exits 2 before source topology removal
- **AND** reports the retained source and exact retry or alternative source-selection action

#### Scenario: Force cannot discard the selected target OID
- **WHEN** `--force` is used for worktree-to-submodule transition plus sync
- **THEN** force may waive other disclosed managed local state
- **AND** OMS still requires the selected target OID and object closure to be verified in staged target storage before source deletion

#### Scenario: Default transition stages only owned root paths
- **WHEN** mode switch runs without `--commit` in a Git repository with unrelated staged paths
- **THEN** preexisting unrelated staged entries, modes, and flags are preserved exactly
- **AND** OMS stages only the manifest and root topology paths owned by the selected transition
- **AND** a transition-plus-sync to submodule stages each created gitlink at its verified selected OID

#### Scenario: Unsafe root operation blocks transition
- **WHEN** the root has unmerged index entries, a conflicting index lock, or merge, rebase, cherry-pick, revert, bisect, or similar operation in progress
- **THEN** mode switch exits 1 before current-mode removal or manifest edits

#### Scenario: Transition commit is scoped
- **WHEN** mode switch runs with `--commit`
- **AND** no unrelated paths are staged
- **THEN** it includes the manifest's current contents and current-mode topology removal
- **AND** when target sync was selected, it includes the resulting target topology and verified submodule gitlinks
- **AND** commits `chore(oms): switch workspace mode to <mode>`

#### Scenario: Transition commit rejects unrelated staging
- **WHEN** unrelated root paths are staged and `--commit` is supplied
- **THEN** mode switch exits 1 before mutation

#### Scenario: Operational transition failure is resumable
- **WHEN** a caught execution failure occurs after global preflight and after some current-mode state was removed but before manifest cutover
- **THEN** the manifest mode remains unchanged
- **AND** removed state is not reconstructed automatically
- **AND** OMS identifies preserved partial state and the exact resume command

#### Scenario: YAML comments and formatting survive mode switch
- **WHEN** `oms.yaml` contains comments, custom quoting, key order, indentation, or non-default line endings
- **AND** mode switch succeeds
- **THEN** only the top-level mode scalar is inserted or replaced
- **AND** every unrelated source byte remains unchanged

#### Scenario: Symlink manifest blocks mode switch
- **WHEN** `oms.yaml` is a symbolic link, including a link to an otherwise readable regular file
- **THEN** mode switch exits 1 during preflight before journal creation, topology mutation, index changes, or target-file edits
- **AND** leaves the link and its target unchanged
- **AND** instructs the user to replace it intentionally with a regular workspace-local `oms.yaml` before retrying

#### Scenario: Transition journal resumes after interruption
- **WHEN** mode switch is interrupted after one or more aliases or local-exclude state changed
- **THEN** a durable non-secret journal retains source and target modes, original and expected manifest hashes, the mode scalar location/token, phase, and completed work without copying manifest or exclude contents
- **AND** the next mode-switch invocation resumes idempotently when actual state matches
- **AND** stops without further mutation when state drifted

#### Scenario: Ambiguous stale lock is not recovered
- **WHEN** a transition journal exists but lock ownership cannot be disproved conclusively from matching workspace, operation, transition, PID, and process-start identities
- **THEN** mode switch does not remove or replace the lock
- **AND** exits 1 with bounded doctor guidance

#### Scenario: Interruption after manifest cutover resumes forward
- **WHEN** atomic manifest replacement persisted the target mode before mode switch was interrupted
- **THEN** the next mode-switch invocation recognizes the expected target manifest hash
- **AND** resumes the remaining journal phases toward transition completion without reverting the manifest

#### Scenario: Interruption after transition commit does not duplicate it
- **WHEN** the optional root transition commit succeeded before mode switch was interrupted
- **THEN** the next mode-switch invocation recognizes the expected committed tree and commit
- **AND** completes the remaining journal phases without creating another transition commit

#### Scenario: Journal survives removal of mode storage
- **WHEN** process interruption occurs after worktree-mode `.oms/` children were partly or completely removed
- **THEN** workspace-root `.oms-mode-switch.json` remains discoverable before mode-specific loading
- **AND** `.oms/workspace.json` still contains the journal's workspace ID
- **AND** recovery reacquires an absent lock or recovers an existing lock only under the proven-stale identity rules before resuming

#### Scenario: Target sync is gated by transition completion
- **WHEN** standalone sync observes a transition journal, unexpected old-mode filesystem or index topology, or incomplete exclude cleanup
- **THEN** it refuses to create new storage
- **AND** points to the exact mode-switch resume or recovery action
- **AND** journal-owned target sync proceeds only when expected staged entries and the recorded phase match actual state

#### Scenario: Commit hook or signing failure preserves recovery state
- **WHEN** `mode switch --commit` reaches the root commit and a hook, signature, or commit operation fails
- **THEN** OMS leaves the transition-owned paths staged with a documented recoverable journal state
- **AND** retains any target topology already created by the selected `--sync` path
- **AND** does not report the transition complete

### Requirement: Serialized destructive mutation
Every OMS command or helper that writes manifest, exclude, provisioning, provenance, ownership, journal, lock, recovery, topology, ref, HEAD, index, working-tree, or remote-tracking state SHALL hold mode-independent workspace-root `.oms-mutation.lock` outside all topology deletion sets and SHALL revalidate the affected ownership and safety snapshot at its final mutation boundary, because direct Git operations can bypass the OMS lock. Submodule-mode branch list SHALL preserve its existing initialization, declared-remote reconciliation, and fetch behavior and therefore SHALL hold the mutation lock. Read-only status, worktree list, worktree-mode branch list, help, and doctor inspection SHALL remain lock-free and SHALL run every Git subprocess with `GIT_OPTIONAL_LOCKS=0` plus non-mutating command forms.

#### Scenario: Concurrent OMS mutation is rejected
- **WHEN** any topology, ref, HEAD, index, working-tree, or remote-tracking mutation starts while another OMS mutation owns the workspace lock
- **THEN** it exits before changing Git or filesystem state

#### Scenario: Cross-category mutations share one lock
- **WHEN** manifest, topology, index, or remote-tracking mutations overlap
- **THEN** the first operation exclusively owns the same workspace-root lock
- **AND** every later operation exits before changing any file or Git state

#### Scenario: Lock-free inspection does not refresh the index
- **WHEN** status, worktree list, worktree-mode branch list, or read-only doctor inspection runs alone or concurrently with a mutation
- **THEN** every inspection Git subprocess disables optional locks
- **AND** manifest bytes, OMS state files, refs, index bytes, worktree contents, and Git topology remain unchanged by the inspection

#### Scenario: Submodule branch list keeps refresh behavior serialized
- **WHEN** submodule-mode branch list initializes a registered submodule, reconciles declared remotes, or fetches remote-tracking refs
- **THEN** it holds the workspace mutation lock through the complete refresh and inspection
- **AND** lock refusal leaves submodule topology, configuration, refs, index, and working-tree state unchanged

#### Scenario: Direct Git changes after preflight
- **WHEN** direct Git adds or locks a worktree, moves a ref, creates a commit, or changes local files after OMS preflight
- **THEN** OMS detects the changed snapshot immediately before destructive mutation
- **AND** stops rather than relying on stale safety results

### Requirement: Read-only worktree diagnostics
Doctor SHALL diagnose worktree mode without mutating it, including common repositories, remotes, refspecs, relative metadata, managed and external paths, locks, stale or moved registrations, enclosing Git excludes, orphan aliases, and incompatible old-mode artifacts.

#### Scenario: Doctor reports a manually moved worktree
- **WHEN** a linked worktree directory was moved without Git metadata updates
- **THEN** doctor identifies the old registration and candidate current path
- **AND** prints a bounded `git worktree repair` procedure
- **AND** does not repair or prune automatically

#### Scenario: Doctor reports local exclude drift
- **WHEN** a worktree workspace is inside a Git repository and marker-managed local exclude rules are missing or malformed
- **THEN** doctor reports the drift and the OMS command that can reconcile it

#### Scenario: Local exclude update preserves user content
- **WHEN** OMS reconciles an enclosing repository's local exclude file
- **THEN** it resolves the file through `git rev-parse --git-path info/exclude`
- **AND** uses workspace-specific markers, locking, and atomic replacement
- **AND** preserves user rules, permissions, line endings, `oms/AGENTS.md`, and `oms/CLAUDE.md`
- **AND** malformed or duplicate markers fail closed

#### Scenario: Mode-independent control files stay locally excluded
- **WHEN** a workspace has an enclosing Git repository in either mode or during a transition
- **THEN** ownership-marked workspace-relative rules exclude `.oms/workspace.json`, `.oms-mutation.lock`, and `.oms-mode-switch.json`
- **AND** transition away from worktree mode removes only mode-specific repository and checkout rules
- **AND** OMS root status and root-commit classification filter the control paths even before or during exclude reconciliation

#### Scenario: Credential-bearing failure is redacted
- **WHEN** a worktree-mode Git diagnostic contains URL userinfo, tokens, keys, passwords, signatures, or other credential components
- **THEN** OMS redacts credentials while preserving non-sensitive host, path, and failure context

#### Scenario: Secret canary never reaches an output channel
- **WHEN** the same credential canary appears in URL userinfo, query, fragment, percent-encoding, headers, or Git command diagnostics
- **THEN** it appears in none of stdout, stderr, status JSON errors, prompts, doctor output, debug output, or durable provenance and transaction files

### Requirement: Universal secret-safe output
All worktree-mode commands SHALL route dynamic Git, manifest, endpoint, path, and failure diagnostics through one redaction boundary before writing stdout, stderr, JSON error strings, prompts, debug output, or durable diagnostic metadata. Common repository config SHALL reject credential-bearing manifest URLs, and provenance, temporary files, backups, recovery files, locks, and transaction state SHALL NOT copy raw remote URLs or authorization material.

#### Scenario: URL and header credentials are redacted
- **WHEN** dynamic diagnostics contain URL userinfo, secret query or fragment parameters, percent-encoded credentials, authorization or proxy header values, or credential-bearing command arguments
- **THEN** OMS replaces every secret value and unsafe control character
- **AND** retains only non-sensitive host, path, operation, and failure context

#### Scenario: Manifest edit disclosure omits contents
- **WHEN** mode switch will include preexisting manifest edits in a commit
- **THEN** OMS identifies that such edits will be included
- **AND** does not print manifest lines or configured remote values as disclosure data

#### Scenario: Durable and temporary files contain no credential canary
- **WHEN** a rejected or accepted manifest endpoint is processed through validation, reconciliation, failure, and recovery paths
- **THEN** credential canaries appear in none of common-repository config, provenance, journals, locks, temporary files, backups, or recovery files
