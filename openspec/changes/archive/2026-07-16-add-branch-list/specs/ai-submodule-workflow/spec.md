## ADDED Requirements

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

## MODIFIED Requirements

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
- **THEN** the command prints branch command help that includes list and delete
- **AND** exits 1 without modifying repository state
