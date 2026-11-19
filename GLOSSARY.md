# OMS Workspace

OMS workspaces contain a main project and separately versioned source repositories. The main project records the source commits that belong to the workspace.

## Language

### Workspace repositories

**Main project**:
The Git repository that declares the workspace's source repositories and records their exact commits.
_Avoid_: Workspace when referring only to the main project's Git history

**Source repository**:
A repository declared as a source of the main project, with its own history and branches.
_Avoid_: Workspace repository when referring to a source rather than the main project

**Alias**:
The name that identifies a source repository within a workspace.
_Avoid_: Repository name when referring to the workspace-specific name

**Source registration**:
A source repository's inclusion as a Git submodule in the main project. A source can be declared without being registered, or registered without a locally initialized checkout.
_Avoid_: Source declaration, checkout initialization

**Recorded commit**:
The exact source commit recorded by the main project's current revision. A staged pointer update or a different local checkout commit does not change it.
_Avoid_: Staged source pointer, current source checkout commit

### Local checkouts

**Canonical checkout**:
The source repository's primary local checkout in the workspace. Its checked-out commit can differ from the recorded commit.
_Avoid_: Source repository when distinguishing its primary checkout from a managed tree

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
