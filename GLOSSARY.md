# OMS Workspace

An OMS workspace consists of a main project, its source declarations, and the local checkouts of those sources.

## Language

### Workspace repositories

**Main project**:
The Git repository that shares a workspace's source declarations.
_Avoid_: Workspace when referring only to the main project's Git history

**Source repository**:
A repository declared as a source of the main project, with its own history and branches.
_Avoid_: Workspace repository when referring to a source rather than the main project

**Alias**:
The name that identifies a source repository within a workspace.
_Avoid_: Repository name when referring to the workspace-specific name

**Source declaration**:
An entry in `oms.yaml` that identifies a workspace source by its alias, remotes, and optional baseline branch. It can exist without a local checkout.
_Avoid_: Source registration, checkout

### Legacy submodule terms

These terms describe the pre-3.0 workspace model and its migration.

**Source registration**:
A source repository's inclusion as a Git submodule in the main project. A source can be declared without being registered, or registered without a locally initialized checkout.
_Avoid_: Source declaration, checkout initialization

**Pending source registration**:
A source registration prepared locally but not yet included in the main project's current revision. This is distinct from an incomplete or conflicting registration.
_Avoid_: Broken registration, registered but uninitialized

**Source registration commit**:
A main-project commit that adds or removes a source registration or updates its registration metadata. For a new registration, it establishes the first recorded commit.
_Avoid_: Pointer update when referring to a change in registration or its metadata

**Recorded commit**:
The exact source commit recorded by the main project's current revision. A staged pointer update or a different local checkout commit does not change it.
_Avoid_: Staged source pointer, current source checkout commit

**Source pointer update**:
A change to the exact source commit that the main project references for an already registered source, without adding or removing the registration.
_Avoid_: Source registration when referring only to a change in the referenced commit

### Local checkouts

**Canonical checkout**:
The primary local checkout of a declared source on one computer. In the independent-clone model, it has its own Git data and its current branch and commit belong to that computer.
_Avoid_: Source repository when distinguishing its primary checkout from a managed tree

**Former source checkout**:
A local independent checkout that matches the most recent declaration for an alias before that declaration was removed from the main project's history.
_Avoid_: Orphan when ownership has not been established

**Managed tree**:
A machine-local Git worktree for a task in a source repository. It shares the repository's history and branches with the canonical checkout but has its own working files.
_Avoid_: Separate clone, canonical checkout

### Branch cleanup

**Protected baseline**:
A source branch excluded from deletion because it is a workspace baseline. If reliable baseline information disagrees, OMS protects each branch it identifies as a baseline.
_Avoid_: Cleanup comparison base when referring to deletion protection

**Comparison base**:
A local or remote-tracking branch together with its selected commit. For cleanup, OMS checks whether a local branch's tip is in that commit's history; the result does not override baseline protection.
_Avoid_: Protected baseline when referring only to merge comparison
