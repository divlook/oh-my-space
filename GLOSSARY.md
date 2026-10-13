# OMS Workspace

OMS workspaces contain a main project and separately versioned source repositories. The main project records the source commits that belong to the workspace.

## Language

**Source repository**:
A repository declared as a source of the main project, with its own history and branches.
_Avoid_: Workspace repository when referring to a source rather than the main project

**Recorded commit**:
The exact source commit committed as that source repository's pointer in the main project's current revision. A staged pointer change is not yet a recorded commit.
_Avoid_: Staged source pointer, current source checkout commit

**Protected baseline**:
A source branch designated as a baseline by the workspace declaration or reliable registration metadata and therefore excluded from branch deletion. Conflicting reliable declarations can identify more than one protected baseline.
_Avoid_: Cleanup comparison base when referring to deletion protection

**Comparison base**:
The source branch and its confirmed commit whose history determines whether a local branch is eligible for cleanup. A comparison base is distinct from the workspace's protected baselines.
_Avoid_: Protected baseline when referring only to merge comparison
