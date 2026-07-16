# ai-submodule-workflow Specification

## Purpose
TBD - created by archiving change improve-ai-submodule-workflow. Update Purpose after archive.
## Requirements
### Requirement: Machine-readable workspace status
The system SHALL provide `oms status --json` to report the root repository and configured submodules in a stable machine-readable format.

#### Scenario: Status JSON from workspace root
- **WHEN** the user runs `oms status --json` from the workspace root
- **THEN** stdout contains exactly one valid pretty-printed JSON object
- **AND** the object contains `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`
- **AND** stdout is formatted as two-space pretty JSON with a trailing newline
- **AND** stdout contains no non-JSON diagnostic text
- **AND** `currentAlias` is `null`
- **AND** `workspaceRoot` is an OS-native absolute path
- **AND** `errors` is an array

#### Scenario: JSON schema version allows additive fields
- **WHEN** consumers parse a `schemaVersion` 1 status payload
- **THEN** existing field names, meanings, and types are stable
- **AND** consumers may ignore additional optional fields added later under the same `schemaVersion`

#### Scenario: Status JSON from inside a submodule
- **WHEN** the user runs `oms status --json` from inside `oms/api/`
- **THEN** the command emits valid JSON
- **AND** `currentAlias` is `api`
- **AND** this remains true even when the configured submodule is not initialized

#### Scenario: Repo entries expose stable state fields
- **WHEN** the user runs `oms status --json`
- **THEN** each configured repo entry includes `alias`, `path`, `absolutePath`, `configured`, `initialized`, `branch`, `head`, `detached`, `trackingBranch`, `pin`, `dirty`, `changes`, `ahead`, `behind`, and `error`
- **AND** `path` is POSIX-style and workspace-relative
- **AND** `absolutePath` is OS-native and absolute
- **AND** `configured` indicates the alias exists in `oms.yaml` and does not mean the submodule is registered in `.gitmodules`
- **AND** `error` is `null` when the repo state was read successfully

#### Scenario: Dirty changes expose summary and counts
- **WHEN** the root repository or a configured repo has staged, unstaged, or untracked changes
- **THEN** its status object includes `dirty: true`
- **AND** its `changes` object includes numeric `staged`, `unstaged`, and `untracked` path counts based on `git status --porcelain=v1 -z`
- **AND** a path with both staged and unstaged changes contributes to both counts

#### Scenario: Root and submodule changes are separated
- **WHEN** a submodule has source changes or a moved gitlink
- **THEN** submodule source changes are reported in the matching `repos[].changes`
- **AND** root gitlink movement is reported in `root.submodulePointers`
- **AND** `root.changes` counts non-submodule root repository paths only

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

#### Scenario: Recorded but uninitialized repo remains in inventory
- **WHEN** a configured repo has a recorded gitlink in the root repository HEAD but its working tree is not initialized
- **THEN** its repo entry remains present in `repos`
- **AND** `initialized` is `false`
- **AND** Git-dependent fields are `null` or safe defaults
- **AND** `pin` is `uninit`

#### Scenario: Missing root gitlink is represented
- **WHEN** a configured alias has no recorded gitlink in the root repository HEAD
- **THEN** `pin` is `missing`
- **AND** the human-readable `oms status` table also displays `missing`

#### Scenario: Never-synced repo reports missing rather than uninit
- **WHEN** a configured alias has no recorded gitlink in the root repository HEAD and no initialized working tree
- **THEN** `pin` is `missing`
- **AND** `pin` is not `uninit`

#### Scenario: Conflicted root gitlink is represented
- **WHEN** a configured alias has a conflicted root repository gitlink
- **THEN** `pin` is `conflict`
- **AND** the alias appears in `root.submodulePointers.conflict`
- **AND** the human-readable `oms status` table also displays `conflict`
- **AND** `oms status --json` exits 0 unless status collection itself fails

#### Scenario: Root submodule pointer state is exposed
- **WHEN** root repository submodule gitlinks are moved, staged, split between index and working tree, or conflicted
- **THEN** `root.submodulePointers` includes `moved`, `staged`, `split`, and `conflict` alias arrays
- **AND** an alias appears in `moved` when root repository HEAD differs from either the index pointer or working tree pointer
- **AND** an alias appears in `moved` when root repository HEAD has a gitlink but the working tree path has been removed by pending unsync topology changes
- **AND** an alias appears in `staged` when the index pointer differs from root repository HEAD
- **AND** an alias appears in `split` when it is staged (the index pointer differs from root repository HEAD) and the staged index pointer differs from the working tree pointer

#### Scenario: Partial status failure keeps JSON valid
- **WHEN** a repo state cannot be read
- **THEN** stdout still contains valid JSON with the normal repo entry shape
- **AND** unknown scalar repo fields are `null`
- **AND** structured fields such as `changes` preserve their normal object shape with safe default values
- **AND** the repo entry's `error` field contains a concise message
- **AND** top-level `errors` contains a matching summary
- **AND** the process exits non-zero

#### Scenario: Alias-filtered JSON status narrows repo and pointer arrays
- **WHEN** the user runs `oms status api --json`
- **THEN** `repos[]` includes only `api`
- **AND** `root.submodulePointers` arrays include only selected aliases
- **AND** repo-level `errors[]` entries and the exit code reflect only selected repos
- **AND** `root` status and `currentAlias` remain present

#### Scenario: Unknown status alias fails before JSON
- **WHEN** the user runs `oms status missing-alias --json`
- **THEN** the command fails with an invalid alias message on stderr
- **AND** stdout does not contain JSON

### Requirement: Current submodule alias resolution
The system SHALL resolve omitted aliases for supported one-alias commands using explicit arguments, current path inference, and interactive selection only.

#### Scenario: Alias inferred inside submodule tree
- **WHEN** the user runs a supported one-alias command without an alias from inside `oms/api/`
- **THEN** the command resolves alias `api`

#### Scenario: Alias inference uses path segment boundaries
- **WHEN** alias `api` exists and the current directory is `oms/api-extra/`
- **THEN** the command does not infer alias `api`

#### Scenario: Alias inferred before command preconditions
- **WHEN** the user runs `oms commit -m "feat: x"` from inside configured but uninitialized `oms/api/`
- **THEN** the command resolves alias `api`
- **AND** the command fails because `api` is not initialized
- **AND** the message suggests initializing or syncing the submodule

#### Scenario: Interactive candidate selection
- **WHEN** a supported one-alias command omits the alias outside any `oms/<alias>/` tree in an interactive terminal
- **THEN** the command builds a command-specific valid candidate list
- **AND** `oms commit` candidates are dirty submodules
- **AND** `oms record` candidates are moved submodule pointers, excluding pending removals

#### Scenario: Interactive single candidate auto-selects
- **WHEN** an interactive alias-less command has exactly one valid candidate
- **THEN** the command selects it automatically
- **AND** the command prints a short message explaining the selection

#### Scenario: Interactive no candidates is no-op
- **WHEN** an interactive alias-less `oms commit` has no dirty submodule candidates
- **THEN** the command reports that there is nothing to commit in any submodule
- **AND** exits 0
- **WHEN** an interactive alias-less `oms record` has no moved pointer candidates
- **THEN** the command reports that there is nothing to record for any submodule
- **AND** exits 0

#### Scenario: Non-interactive alias omission fails
- **WHEN** the user runs a supported one-alias command without an alias from outside any `oms/<alias>/` tree in a non-interactive shell
- **THEN** the command fails with a clear message explaining that an alias is required
- **AND** the command does not auto-select from dirty or moved state

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
- **WHEN** a declared alias's root HEAD, index, and working tree disagree about the presence of its gitlink or matching `.gitmodules` registration
- **OR** either registration element is conflicted or has a pending topology addition or removal
- **THEN** OMS exits 1 without attempting automatic initialization or topology repair
- **AND** identifies the inconsistent registration and provides sync repair guidance

#### Scenario: Moved registered pointer remains preparable
- **WHEN** root HEAD, index, and working tree agree that an alias's gitlink and `.gitmodules` registration exist
- **AND** their gitlink OIDs differ without a topology conflict or pending addition or removal
- **THEN** OMS treats the alias as registered
- **AND** does not reject automatic preparation solely because the pointer moved

#### Scenario: Accepted sync retains its existing contract
- **WHEN** the user accepts `sync and continue` for an unregistered alias
- **THEN** OMS delegates topology, metadata, and commit-or-unstage decisions to the existing sync workflow
- **AND** resumes branch listing only after sync successfully initializes the alias
- **AND** does not describe sync's explicitly accepted root changes as branch-list mutations
- **AND** redacts credentials from every delegated sync diagnostic while retaining non-sensitive URL host/path and failure context
- **AND** preserves sync's existing exit code when sync fails

### Requirement: Automated declared-remote refresh
Before collecting remote branches, `oms branch list` SHALL reconcile and fetch each remote declared for the selected alias in manifest order, SHALL retry an individual failed fetch once, and SHALL use visibly degraded cached results after an exhausted failure.

#### Scenario: Declared remote configuration is reconciled
- **WHEN** a declared remote is missing locally or its URL differs from `oms.yaml`
- **THEN** OMS adds or updates that submodule-local remote automatically from the manifest
- **AND** does not print the old or new configured URL value as data
- **AND** may retain non-sensitive URL host/path only inside a credential-redacted Git diagnostic
- **AND** does not remove or modify extra local remotes with other names
- **AND** does not rewrite root `.gitmodules`

#### Scenario: Declared remote configuration fails
- **WHEN** OMS cannot add or update one declared submodule-local remote
- **THEN** OMS marks that remote `unavailable` without fetching or displaying its cached refs
- **AND** continues with later declared remotes
- **AND** exits 0 when local branch inspection and output otherwise succeed

#### Scenario: Every declared remote is fetched and pruned
- **WHEN** remote configuration succeeds
- **THEN** OMS runs the equivalent of `git fetch <remote> --prune` for every declared remote sequentially in manifest order
- **AND** does not fetch or display a remote absent from `oms.yaml`

#### Scenario: Failed fetch is retried once
- **WHEN** the first fetch attempt for a declared remote fails
- **THEN** OMS retries that remote once without asking the user
- **AND** continues normally when the retry succeeds

#### Scenario: Exhausted fetch uses cached refs
- **WHEN** both fetch attempts for one declared remote fail
- **AND** cached remote-tracking refs exist for that remote
- **THEN** OMS warns that the remote data may be stale
- **AND** displays those cached refs with fetch state `stale`
- **AND** continues fetching later declared remotes
- **AND** exits 0 when local branch inspection and output otherwise succeed

#### Scenario: Exhausted fetch has no cached refs
- **WHEN** both fetch attempts for one declared remote fail
- **AND** no cached remote-tracking refs exist for that remote
- **THEN** OMS includes the remote with fetch state `unavailable`
- **AND** preserves the non-sensitive Git diagnostic and actionable retry guidance while redacting credentials
- **AND** continues listing usable local and other-remote state
- **AND** exits 0 when local branch inspection and output otherwise succeed

#### Scenario: Remote ref inspection fails
- **WHEN** OMS cannot inspect one configured declared remote's ref namespace
- **THEN** OMS marks that remote `unavailable` even if its fetch succeeded or stale cached refs may exist
- **AND** continues listing usable local and other-remote state
- **AND** exits 0 when local branch inspection and output otherwise succeed

#### Scenario: Fresh remote has no branch refs
- **WHEN** a declared remote fetch succeeds and its inspected remote-tracking namespace is empty
- **THEN** OMS displays that remote as `fresh` with an explicit empty group

#### Scenario: Symbolic remote HEAD is excluded
- **WHEN** a declared remote has a symbolic `<remote>/HEAD` ref
- **THEN** OMS does not display that symbolic ref as a branch row
- **AND** still displays the branch targeted by it when that remote-tracking branch exists

### Requirement: Branch decision information
The branch list SHALL group deterministic local and declared-remote rows and SHALL show the state needed to choose a later switch, checkout, or delete action without inventing tracking relationships.

#### Scenario: Local branch state is displayed
- **WHEN** local branches are available
- **THEN** each local row shows its branch name, current and baseline flags when applicable, configured upstream, and ahead/behind counts
- **AND** local rows are sorted by branch name

#### Scenario: Divergence uses the configured upstream
- **WHEN** a local branch has a resolvable configured upstream
- **THEN** ahead/behind is calculated between that local branch and that exact upstream
- **AND** OMS does not infer an upstream from a same-named remote branch

#### Scenario: Local branch has no upstream
- **WHEN** a local branch has no configured upstream
- **THEN** its upstream and ahead/behind fields are blank

#### Scenario: Configured upstream is unavailable
- **WHEN** a local branch has a configured upstream that is gone or cannot be compared
- **THEN** OMS displays the configured upstream as unavailable
- **AND** displays unknown ahead/behind values rather than zero

#### Scenario: Configured upstream uses an unmanaged remote
- **WHEN** a local branch's configured upstream belongs to a remote absent from `oms.yaml`
- **THEN** OMS displays the actual configured upstream name and its resolvable ahead/behind state
- **AND** does not include that remote in the REMOTE inventory or display its URL

#### Scenario: Declared remote rows are grouped deterministically
- **WHEN** remote-tracking branches are available
- **THEN** OMS groups them after local branches by manifest remote order
- **AND** sorts branch names within each remote
- **AND** shows each remote's `fresh`, `stale`, or `unavailable` fetch state

#### Scenario: Detached HEAD remains listable
- **WHEN** the selected submodule has detached HEAD
- **THEN** OMS displays the detached short OID
- **AND** lists local and remote branches normally
- **AND** does not mark any local branch as current

#### Scenario: Empty branch groups remain successful
- **WHEN** the selected repository has no rows for a local or remote group
- **THEN** OMS represents that group as empty explicitly
- **AND** does not treat the empty group alone as an error

### Requirement: Non-destructive baseline reporting
Branch listing SHALL refresh and report the selected alias's baseline automatically when reliable, but SHALL preserve a usable inventory with an explicit unknown baseline when read-only reporting cannot resolve it.

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

#### Scenario: Reliable baseline sources disagree
- **WHEN** the manifest and reliable applicable `.gitmodules` versions identify different baseline branches
- **THEN** OMS warns about drift
- **AND** marks every matching reliable baseline branch
- **AND** continues listing

#### Scenario: Baseline metadata is unreliable
- **WHEN** an applicable `.gitmodules` version is unreadable, malformed, duplicated, or multi-valued for the selected alias
- **THEN** OMS identifies the unreliable source
- **AND** reports baseline state as `incomplete` when another reliable baseline exists
- **AND** reports baseline state as `unknown` when no reliable baseline exists
- **AND** continues listing because no destructive action is performed

#### Scenario: Reliable baseline has no local branch
- **WHEN** OMS resolves a reliable baseline name that has no matching local branch
- **THEN** no local row is incorrectly flagged
- **AND** the baseline summary reports the unmatched reliable name

#### Scenario: Reliable and unreliable baseline sources coexist
- **WHEN** at least one reliable baseline is resolved and another applicable source is unreliable
- **THEN** OMS marks matching reliable local branches
- **AND** reports baseline state as incomplete with the unreliable source identified
- **AND** exits 0 when local branch inspection otherwise succeeds

### Requirement: Branch list scope and actionable failures
`oms branch list` SHALL keep all automatic mutations within preparation and remote-tracking refresh for the selected submodule, and SHALL fail terminally only when a useful local inventory cannot be produced safely.

#### Scenario: Listing preserves branch and root state
- **WHEN** branch listing completes in fresh or degraded mode
- **AND** the user did not delegate preparation to the existing sync workflow
- **THEN** it does not switch, create, delete, merge, or push a branch
- **AND** does not change, stage, or commit a root gitlink or root file
- **AND** does not print an `oms record` hint

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

### Requirement: Submodule-only commits
The system SHALL provide `oms commit <alias> -m <message>` to create commits only inside the selected submodule while respecting the submodule index for partial commits.

#### Scenario: Commit submodule changes only when nothing is staged
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has changed files but no staged changes
- **THEN** the command runs `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/`
- **AND** the root repository does not receive a new commit
- **AND** unrelated root repository files are not staged
- **AND** the command prints the submodule short commit SHA
- **AND** the command prints the appropriate root follow-up hint, such as `oms record api` when an existing recorded gitlink is moved

#### Scenario: Commit staged submodule changes only
- **WHEN** `oms/api/` has staged changes and unstaged changes
- **AND** the user runs `oms commit api -m "feat: add login form"`
- **THEN** the command does not run `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/` using only the staged changes
- **AND** the unstaged changes remain unstaged in `oms/api/`
- **AND** the command warns that unstaged changes remain uncommitted
- **AND** the root repository does not receive a new commit

#### Scenario: Commit supports multiple message paragraphs
- **WHEN** the user runs `oms commit api -m "feat: add login" -m "Add callback handling."`
- **THEN** both message paragraphs are passed to the submodule `git commit`

#### Scenario: Commit requires explicit message only for source commits
- **WHEN** `oms/api/` has committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command fails without opening an editor
- **AND** the message explains that `-m` is required to create a submodule commit

#### Scenario: Commit no-op does not require a message
- **WHEN** `oms/api/` has no committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0

#### Scenario: Commit without submodule changes
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has no committable changes
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Commit no-op with moved pointer
- **WHEN** `oms/api/` has no committable changes and the root pointer for `api` is moved
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** prints a hint to run `oms record api`
- **AND** does not record the root pointer

#### Scenario: Commit no-op with pending add topology
- **WHEN** `oms/api/` has no committable changes
- **AND** the root repository HEAD has no recorded gitlink for `oms/api`
- **AND** the working tree has an initialized `oms/api` submodule
- **AND** `.gitmodules` contains path `oms/api`
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** prints a hint to run `oms sync api --commit`
- **AND** does not record the root pointer

#### Scenario: Commit rejects detached submodule HEAD
- **WHEN** `oms/api/` is in detached HEAD
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails
- **AND** suggests `oms switch api <branch>`
- **AND** does not modify the root repository

#### Scenario: Commit rejects in-progress Git operations
- **WHEN** `oms/api/` has a merge, rebase, cherry-pick, revert, bisect, or similar Git operation in progress
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails and instructs the user to resolve, continue, or abort the operation inside `oms/api/`
- **AND** does not modify the root repository

#### Scenario: Commit never records root pointer
- **WHEN** `oms commit api -m "feat: add login flow"` creates a submodule commit and the root pointer for `api` is moved
- **THEN** the command does not create a root repository pointer commit
- **AND** the command prints a hint to run `oms record api`

#### Scenario: Commit source changes with pending add topology
- **WHEN** `oms commit api -m "feat: add login flow"` creates a submodule commit
- **AND** the root repository HEAD has no recorded gitlink for `oms/api`
- **AND** the working tree has an initialized `oms/api` submodule
- **AND** `.gitmodules` contains path `oms/api`
- **THEN** the command does not create a root repository topology commit
- **AND** the command prints a hint to run `oms sync api --commit`

### Requirement: Explicit root pointer records
The system SHALL provide pointer-recording commands that commit only selected submodule gitlink updates in the root repository.

#### Scenario: Record moved submodule pointer
- **WHEN** `oms/api` points at a commit different from the root repository's recorded gitlink and the user runs `oms record api`
- **THEN** the command stages only `oms/api` in the root repository
- **AND** the command creates a root repository commit with message `chore(oms): update api submodule to <short-sha>`
- **AND** the command prints the root commit short SHA and commit message

#### Scenario: Record absent pointer movement
- **WHEN** `oms/api` does not differ from the root repository's recorded gitlink and the user runs `oms record api`
- **THEN** the command reports that there is no pointer update to record
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Record no-op does not warn for dirty source changes
- **WHEN** `oms/api` has uncommitted source changes but no pointer movement
- **AND** the user runs `oms record api`
- **THEN** the command reports that there is no pointer update to record
- **AND** does not warn about dirty source changes

#### Scenario: Record fails for unrelated staged root repository changes
- **WHEN** the root repository index has staged paths other than exactly `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails with a message explaining that unrelated staged changes must be committed or unstaged first
- **AND** the command does not create a root repository commit

#### Scenario: Record allows unrelated unstaged root repository changes
- **WHEN** the root repository has unrelated unstaged changes
- **AND** no unrelated paths are staged
- **AND** the user runs `oms record api`
- **THEN** the command records only `oms/api`
- **AND** the unrelated unstaged changes remain uncommitted

#### Scenario: Record allows selected staged gitlink
- **WHEN** the only staged root repository path is `oms/api`
- **AND** the staged pointer matches the working tree pointer
- **AND** the user runs `oms record api`
- **THEN** the command creates the root pointer commit for `api`

#### Scenario: Record rejects staged pointer split
- **WHEN** the staged pointer for `oms/api` differs from the working tree pointer for `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to unstage or restage `oms/api`
- **AND** the command does not create a root repository commit

#### Scenario: Record rejects missing recorded gitlink
- **WHEN** the root repository has no recorded gitlink at `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails and explains that `record` only updates existing root gitlinks
- **AND** if pending add topology is detected, the message points to `oms sync api --commit`

#### Scenario: Record rejects conflicted root gitlink
- **WHEN** the root repository has a conflicted gitlink at `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to resolve the root repository conflict first

#### Scenario: Record rejects pending removal
- **WHEN** the root repository HEAD has a gitlink at `oms/api` but the working tree path `oms/api` has been removed
- **AND** the user runs `oms record api`
- **THEN** the command fails and explains that a pending submodule removal is recorded with `oms unsync api --commit`
- **AND** the command does not create a root repository commit
- **AND** the command does not stage the `oms/api` removal

#### Scenario: Record rejects root detached HEAD
- **WHEN** the root repository is in detached HEAD
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to switch the root repository to a branch first

#### Scenario: Record rejects root in-progress Git operation
- **WHEN** the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar Git operation in progress
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to resolve, continue, or abort the root repository Git operation first

#### Scenario: Record warns for dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes and a moved root pointer
- **AND** the user runs `oms record api`
- **THEN** the command warns that only the current HEAD pointer will be recorded
- **AND** the command records the root pointer

#### Scenario: Record commit failure preserves staged gitlink
- **WHEN** `oms record api` stages `oms/api`
- **AND** the root `git commit` step fails
- **THEN** the command fails
- **AND** the selected `oms/api` gitlink remains staged

### Requirement: Interactive branch action selection
The system SHALL provide an `oms branch` command group that exposes supported branch-management actions without moving the existing top-level `oms switch` and `oms checkout` commands.

#### Scenario: Interactive branch command selects list
- **WHEN** the user runs `oms branch` in an interactive terminal
- **THEN** the command presents `list branches` and `delete a local branch`
- **AND** selecting list continues into the `oms branch list` alias-resolution flow

#### Scenario: Interactive branch command selects delete
- **WHEN** the user runs `oms branch` in an interactive terminal
- **AND** selects delete
- **THEN** the command continues into the existing `oms branch delete` interaction

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

#### Scenario: Multi-alias commit prompt is skipped on partial failure
- **WHEN** the user runs `oms sync api web` or `oms unsync api web` in an interactive terminal
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
- **WHEN** the selected alias has pending removal topology that cannot be restored safely because the root gitlink is conflicted, the required `.gitmodules` data cannot be recovered from `HEAD`, the current `.gitmodules` entry for the same alias contains edits that would be overwritten, `oms/api` is occupied by a non-submodule file or directory, or the root repository has a merge, rebase, cherry-pick, or similar operation in progress
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

### Requirement: Root topology actions share a consistent safety preflight
The system SHALL provide one shared root-topology safety preflight in the status spine and route the root-touching commands through it, so the guard set evolves in one place rather than being re-implemented per command. The preflight SHALL classify, for a selected alias, whether the root gitlink is conflicted, whether the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar operation in progress, and whether `oms/<alias>` is occupied by a non-submodule file or directory or exists but cannot be read (permission or I/O error). Each routed command SHALL apply the subset of these checks that is meaningful for it, refuse before mutating Git state when an applied check fails, fail with a deterministic OMS message instead of leaking a raw Git error, and return a non-zero exit code. The occupied-path classification SHALL distinguish an unreadable path from one occupied by non-submodule content so the refusal message names the actual cause (access error vs. stray content) rather than misdirecting the user to "move or remove" a path they cannot read.

The checks applicable to each command are:
- `oms unsync` SHALL apply all three checks (conflicted gitlink, in-progress root operation, and occupied-or-unreadable non-submodule path), reaching parity with `oms sync`'s existing data-loss protection.
- `oms record` SHALL apply the conflicted-gitlink and in-progress-root-operation checks. The occupied-non-submodule-path check does not apply because `record` neither creates nor occupies `oms/<alias>`; its existing record-specific checks and message ordering are preserved.
- `oms sync` already refuses on an occupied non-submodule path (its `!registered` branch) and on unsafe pending-removal restore states (conflicted gitlink or in-progress root operation while restoring). It still refuses in exactly the same states with the same exit codes; the only observable change is that a path which exists but cannot be read now reports a distinct "could not be read (permission or I/O error)" message — in both its pending-removal restore branch and its `!registered` fresh-add branch — instead of the previous "occupied" / "already exists" wording. It consumes the same shared spine primitives (`gitlinkState`, `gitOperationInProgress`, `readAliasDirEntries`) that the preflight composes.

Commands that operate only inside an initialized submodule working tree (`oms commit`, `oms switch`, `oms checkout`, `oms fetch`, `oms pull`, `oms push`) are unaffected and remain gated only by their existing initialization precondition.

#### Scenario: Conflicted gitlink and in-progress root operations are refused consistently by unsync and record
- **WHEN** the selected alias has a conflicted root gitlink or the root repository has an in-progress root Git operation
- **AND** the user runs `oms unsync` or `oms record` for that alias
- **THEN** the command refuses before mutating Git state
- **AND** the command fails with a deterministic OMS message rather than a raw Git error
- **AND** the command returns a non-zero exit code

### Requirement: Unsync preserves unsafe topology guardrails
The system SHALL guard `oms unsync` with the same root-topology safety checks as `oms sync`, refusing to remove a submodule before any `git submodule deinit` or `git rm` runs when the alias state cannot be mutated safely. `oms unsync` SHALL NOT delete, overwrite, or otherwise mutate a non-submodule path occupying `oms/<alias>`, and SHALL NOT report a successful removal in any guarded state.

#### Scenario: Unsync refuses and preserves a non-submodule occupied path
- **WHEN** `oms/api` is occupied by a non-submodule file or directory and `api` is not a registered submodule
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the occupying file or directory at `oms/api` is left untouched
- **AND** the command does not report `api` as unsynced
- **AND** the command returns a non-zero exit code
- **AND** the message explains that `oms/api` is occupied by a non-submodule path and must be resolved manually

#### Scenario: Unsync refuses an unreadable occupied path
- **WHEN** `oms/api` exists but cannot be read (a permission or I/O error such as `EACCES`) and `api` is not a registered submodule
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the path at `oms/api` is left untouched
- **AND** the command does not report `api` as unsynced
- **AND** the command returns a non-zero exit code
- **AND** the message explains that `oms/api` could not be read (permission or I/O error) rather than directing the user to move or remove an occupying path

#### Scenario: Unsync refuses during an in-progress root operation
- **WHEN** the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar operation in progress
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the message explains that the in-progress root operation must be resolved, continued, or aborted first
- **AND** the command returns a non-zero exit code

#### Scenario: Unsync refuses a conflicted root gitlink
- **WHEN** the selected alias has a conflicted root repository gitlink
- **AND** the user runs `oms unsync api`
- **THEN** the command fails before running `git submodule deinit` or `git rm`
- **AND** the message explains that the root gitlink conflict must be resolved first
- **AND** the command returns a non-zero exit code

#### Scenario: Unsync continues to remove a normal registered submodule
- **WHEN** `api` is a registered, initialized submodule with no unsafe root topology state
- **AND** the user runs `oms unsync api`
- **THEN** the command removes the submodule as before
- **AND** the command follows the existing unsync topology finalization policy

### Requirement: Managed agent instruction files
The system SHALL manage AI agent instruction blocks in selected files under the workspace `oms/` directory.

#### Scenario: Install selected agent instruction files
- **WHEN** the user runs `oms agent install --target both`
- **THEN** the command creates or updates `oms/AGENTS.md` and `oms/CLAUDE.md`
- **AND** each file contains one managed block delimited by `<!-- OMS START -->` and `<!-- OMS END -->`
- **AND** the command does not stage the files in Git

#### Scenario: Interactive install target selection
- **WHEN** the user runs `oms agent install` in an interactive terminal without `--target`
- **THEN** the command offers `AGENTS.md`, `CLAUDE.md`, and `AGENTS.md + CLAUDE.md` choices

#### Scenario: Non-interactive install requires target
- **WHEN** the user runs `oms agent install` in a non-interactive shell without `--target`
- **THEN** the command fails and asks for `--target agents|claude|both`

#### Scenario: Preserve existing file content
- **WHEN** a selected instruction file already exists without an OMS managed block and the user runs `oms agent install --target agents`
- **THEN** the command appends the OMS managed block after two blank lines
- **AND** the command preserves existing content outside the managed block
- **AND** the resulting file ends with one trailing newline

#### Scenario: Replace existing managed block
- **WHEN** a selected instruction file already contains exactly one complete OMS managed block and the user runs `oms agent install --target agents`
- **THEN** the command replaces only the managed block
- **AND** preserves all content outside the managed block

#### Scenario: Reject malformed markers atomically
- **WHEN** any selected instruction file contains malformed OMS markers
- **AND** the user runs `oms agent install --target both`
- **THEN** the command fails with a message explaining that the managed block markers are malformed
- **AND** no selected file is modified

#### Scenario: Uninstall managed block
- **WHEN** a selected instruction file contains exactly one complete OMS managed block and the user runs `oms agent uninstall --target agents`
- **THEN** the command removes only the OMS managed block
- **AND** preserves all content outside the managed block

#### Scenario: Uninstall deletes empty managed file
- **WHEN** removing the OMS managed block leaves the target file empty or whitespace-only
- **THEN** the command deletes the target file

#### Scenario: Uninstall no-op for missing block
- **WHEN** the selected instruction file is missing or contains no OMS managed block
- **AND** the user runs `oms agent uninstall --target agents`
- **THEN** the command exits 0 and reports that no OMS block was found

#### Scenario: Uninstall rejects malformed markers atomically
- **WHEN** any selected instruction file contains malformed OMS markers
- **AND** the user runs `oms agent uninstall --target both`
- **THEN** the command fails with no selected file modifications

### Requirement: Agent instruction content
The managed agent instruction block SHALL provide concise durable rules and defer detailed usage to CLI help.

#### Scenario: Installed instructions describe minimal safe OMS workflow
- **WHEN** the user runs `oms agent install --target agents`
- **THEN** the managed block instructs agents to run `oms status --json` before Git work involving `oms/`
- **AND** the managed block explains that `oms/<alias>/` directories are separate Git repositories
- **AND** the managed block instructs agents not to guess root repository versus submodule Git scope
- **AND** the managed block states that root repository commits for existing submodule pointer updates must not be created unless the user explicitly runs `oms record <alias>`
- **AND** the managed block points agents to `oms --help` and `oms <command> --help` for exact command usage

### Requirement: CLI help documents new workflow boundaries
The system SHALL provide help output for new or changed commands that describes purpose, scope, and at least one usage example.

#### Scenario: Help explains scoped commit and record behavior
- **WHEN** the user runs help for `oms commit` or `oms record`
- **THEN** the help text explains which repository the command mutates
- **AND** the help text includes an example command

#### Scenario: Help explains push and record separation
- **WHEN** the user runs help for `oms push`
- **THEN** the help text explains that pull and push do not stage or commit the root gitlink
- **AND** the help text identifies `--commit` as unsupported and points to `oms record <alias>`
- **AND** the help text distinguishes staging for review from recording a root pointer commit

### Requirement: Help documents the status JSON field contract
The `oms status --help` text SHALL accurately document the `schemaVersion` 1 `status --json` field contract, so it serves as an authoritative, version-matched reference for consumers that defer to it.

#### Scenario: Help lists the top-level payload keys
- **WHEN** the user runs `oms status --help`
- **THEN** the help text names the `schemaVersion` 1 top-level keys `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`

#### Scenario: Help names the pointer location correctly
- **WHEN** the user runs `oms status --help`
- **THEN** the help text refers to the submodule pointer arrays as `root.submodulePointers`, with its `moved`, `staged`, `split`, and `conflict` arrays
- **AND** it does not present those arrays as a top-level `pointers` key

### Requirement: Internal refactors preserve submodule workflow behavior
The system SHALL preserve all existing root/submodule workflow behavior when internal CLI modules are reorganized.

The baseline for preservation SHALL be the behavior covered by the existing OpenSpec requirements, the pre-refactor `npm test` result, and the focused CLI behavior checks captured before implementation.

#### Scenario: Status JSON remains stable after module refactor
- **WHEN** `scripts/lib/` modules are reorganized and the user runs `oms status --json`
- **THEN** the command emits the same schemaVersion 1 payload contract as before the refactor
- **AND** root repository changes and submodule source changes remain separated according to the existing workflow requirements

#### Scenario: Root topology safety remains centralized and consistent
- **WHEN** internal modules are reorganized around command or helper boundaries
- **THEN** root topology safety checks for conflicted gitlinks, in-progress root Git operations, occupied paths, unreadable paths, pending add topology, and pending removal topology continue to use the existing shared safety semantics
- **AND** commands that mutate root topology refuse unsafe states before destructive Git or filesystem operations

#### Scenario: Commit, record, sync, unsync, pull, and push preserve scope boundaries
- **WHEN** the user runs `oms commit`, `oms record`, `oms sync`, `oms unsync`, `oms pull`, or `oms push` after the refactor
- **THEN** each command mutates only the same repository scope it mutated before the refactor
- **AND** root pointer commits remain explicit through `oms record <alias>`
- **AND** sync and unsync topology commits remain separate from submodule source commits

#### Scenario: Alias and remote resolution behavior is unchanged
- **WHEN** the user omits aliases or remotes in interactive and non-interactive contexts after the refactor
- **THEN** alias inference, candidate selection, interactive prompts, non-interactive failures, remote defaulting, and remote validation behave as before the refactor

#### Scenario: Help and exit-code semantics are preserved
- **WHEN** the user invokes OMS commands after the refactor
- **THEN** command help continues to describe the same workflow boundaries
- **AND** success, usage/config failure, and git-operation failure exit codes retain their existing meanings
