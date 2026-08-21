export const exitHelp = "\nExit codes: 0 ok | 1 usage/config error | 2 one or more git operations failed.";

export const workspaceContextHelp = `
Workspace discovery uses the nearest oms.yaml from the current directory upward. An invalid nearest
candidate is an error; OMS never falls back to a more distant manifest. Commands that inspect or change
submodules require that manifest directory to be the root Git top-level. Move a nested manifest to the
Git root, or initialize a separate Git repository at the intended workspace root.
`;
export const initHelp = `
The current directory must be outside a Git work tree or be its root top-level. Init refuses a child of
an existing Git work tree before changing any file, including with --force.
`;

// Per-command help: each new or changed command states its purpose, scope boundary, and an example.
export const statusHelp = `
Machine-readable mode prints exactly one JSON object on stdout. The schemaVersion 1 payload has eight
top-level keys: schemaVersion, toolVersion, workspaceRoot, currentAlias, root, repos, trees, and errors.
Submodule pointer movement lives under root.submodulePointers, with moved, staged, split, and conflict
arrays (not a top-level "pointers" key). Each repos[] entry summarizes one oms/<alias>/ submodule
(alias, path, branch, head, pin, dirty, ahead/behind, error). Each trees[] entry summarizes one
managed tree under .oms-tree/ (alias, task, path, absolutePath, branch, head, dirty, error); a broken
link or foreign directory carries a non-null error, and a broken entry reports branch, head, and
dirty as null. Read the live --json output for exact per-field values.
Examples:
  $ oms status --json          # full workspace state for tools and agents
  $ oms status api --json      # narrow the JSON to one alias
`;
export const commitHelp = `
Scope: commits inside the selected oms/<alias>/ submodule only — never the root gitlink. Existing staged
changes are committed as-is (staged-first); otherwise all changes are staged with git add -A.
Preparation initializes an existing registration automatically, but refuses an unregistered alias because
a fresh clone has no source changes to commit. A detached HEAD attaches automatically when a local branch
points at the same commit; otherwise OMS asks before moving the checkout or reports branch-switch guidance.
An explicit alias takes precedence over an alias inferred from the current configured oms/<alias>/ path.
Examples:
  $ oms commit api -m "feat: add login"   # commit submodule source changes
  $ oms commit -m "fix: typo"             # infer the alias from the current oms/<alias>/ directory
`;
export const recordHelp = `
Scope: commits an existing root gitlink pointer update for one alias in the ROOT repository only
(chore(oms): update <alias> submodule to <sha>). It never adds or removes a submodule registration.
An explicit alias takes precedence over an alias inferred from the current configured oms/<alias>/ path.
Several aliases are recorded in one root commit (chore(oms): update submodules). A named alias that
cannot be recorded fails; with --all an unrecordable alias is reported and skipped (exit 2) while the
remaining moved pointers are still recorded.
Examples:
  $ oms record api
  $ oms record api web         # both pointers in one root commit
  $ oms record --all           # record every moved pointer
`;
export const syncHelp = `
Sync reproduces the root repository's recorded submodule pointer. It attaches the baseline only when
that does not move the checkout; a newer baseline stays detached with explicit switch and pull
guidance instead of being followed as an implicit pull.

Root topology changes (.gitmodules, oms/<alias>) are committed by default, identically whether or not
stdin is a terminal. Pass --no-commit to leave them unstaged for review instead.
Examples:
  $ oms sync api               # add/initialize/refresh oms/api, then chore(oms): add api submodule
  $ oms sync api --no-commit   # leave the topology changes unstaged
  $ oms sync api --commit      # same as the default; accepted for compatibility
`;
export const unsyncHelp = `
Removal topology changes are committed by default, identically whether or not stdin is a terminal.
Pass --no-commit to leave them unstaged for review instead.
Examples:
  $ oms unsync api             # remove oms/api, then chore(oms): remove api submodule
  $ oms unsync api --no-commit # leave the removal topology unstaged
  $ oms unsync api --commit    # same as the default; accepted for compatibility
`;
export const fetchHelp = `
Preparation initializes existing registrations automatically. An unregistered alias is offered an explicit
sync; accepting creates a root topology commit, then fetch continues. A multi-alias selection asks once;
--all and picker selections default to skipping unregistered aliases, while named aliases default to sync.
The fetch itself changes only submodule remote-tracking refs.
Example:
  $ oms fetch api
`;
export const pullHelp = `
Scope: pulls the submodule branch only — it never stages or commits the root gitlink. Record a moved
root pointer afterward with "oms record <alias>". Preparation follows fetch: automatic initialization,
an explicit registration offer whose acceptance creates a root topology commit, and one offer per batch.
A detached HEAD attaches automatically when a local branch points at its commit; otherwise OMS asks before
moving the checkout or reports branch-switch guidance.
Example:
  $ oms pull api
`;
export const pushHelp = `
Scope: pushes the submodule branch only — it never stages or commits the root gitlink. Preparation
initializes an existing registration automatically, but refuses an unregistered alias because a fresh clone
has no commits to push. A detached HEAD follows the same attach-or-choose rule as pull. Staging a pointer
for review is not the same as recording a pointer commit: "--commit" is unsupported, so push with
"oms push <alias>", then record the existing root pointer update with "oms record <alias>".
Examples:
  $ oms push api
  $ oms push api web           # push several aliases
  $ oms push --all             # push every declared source repo
  $ oms push                   # pick the aliases interactively
  $ oms record api             # record the moved root pointer
`;
export const branchSwitchHelp = `
Preparation initializes an existing registration automatically or offers to sync an unregistered alias.
Accepting that offer creates a root topology commit before the local branch switch continues.
`;
export const branchCheckoutHelp = `
Preparation initializes an existing registration automatically or offers to sync an unregistered alias.
Accepting that offer creates a root topology commit before origin is fetched and checked out.
`;
export const branchListHelp = `
Behavior:
  Initializes an existing registration automatically; an unregistered alias requires an accepted sync,
  which creates a root topology commit before listing continues.
  Reconciles and fetches every oms.yaml remote with prune, retries once, then shows cached refs as stale.
  Baseline state is known, incomplete, or unknown. Listing never switches or mutates a branch or root gitlink.
  Exit 0 includes degraded remote results; exit 1 is selection/preparation refusal; exit 2 is initialization/local inspection failure.

Examples:
  $ oms branch list api
  $ oms branch list
`;
export const branchDeleteHelp = `
Preparation initializes an existing registration automatically, but refuses an unregistered alias because a
fresh clone has no deletable local branch. Partial registration is refused with oms sync repair guidance.
Deletion remains local to the submodule and never changes root topology.
`;

export const treeHelp = `
Task trees are disposable Git worktrees of an initialized oms/<alias>/ submodule, stored under
.oms-tree/<alias>/<task>/. Creating and removing trees creates no root commit and no .gitmodules
entry: the tree shares the submodule's Git directory, and .oms-tree/ is kept out of root git
status through the root's local exclude file (.git/info/exclude), so trees are machine-local.
Work inside a tree with plain Git; run oms commands from the canonical checkout or the root.
Examples:
  $ oms tree add api fix-auth   # worktree at .oms-tree/api/fix-auth/ on new branch fix-auth
  $ oms tree list               # every tree under .oms-tree/ with branch, dirty, and state
  $ oms tree remove api fix-auth # remove the worktree; branch fix-auth survives
`;
export const treeAddHelp = `
Creates a Git worktree of the initialized submodule oms/<alias>/ at .oms-tree/<alias>/<task>/ and
checks out branch <task> there. A new branch starts at the submodule's current HEAD commit (--from
<ref> overrides the start point); an existing branch is resumed at its tip, and --from with an
existing branch fails. The canonical checkout is never touched — a detached HEAD stays detached.
Creation needs no network and creates no root commit and no .gitmodules entry. The task name must
be a valid branch name without "/" separators. Omitted arguments are prompted for interactively.
Examples:
  $ oms tree add api fix-auth                # start fix-auth at the current HEAD
  $ oms tree add api fix-auth --from origin/feature
`;
export const treeListHelp = `
Lists every entry in the .oms-tree/ namespace — worktrees of aliases still declared in oms.yaml
and of aliases that are no longer declared, plus foreign directories that are not registered
worktrees. Each entry reports its alias, task, branch, dirty state (untracked files count as
dirty), and broken-link state. Read-only; reports "none" and exits 0 when the namespace is empty.
Example:
  $ oms tree list
`;
export const treeRemoveHelp = `
Removes the worktree at .oms-tree/<alias>/<task>/ and preserves the <task> branch and its commits.
A dirty worktree is refused without --force (force discards working-tree changes only). A broken
tree is pruned (leftover directory removed, stale administrative metadata dropped). A foreign
directory is deleted when empty and refused when it contains files unless --force is given. Empty
.oms-tree/<alias>/ and .oms-tree/ directories are cleaned up; the root's local exclude entry stays.
Removal creates no root commit and no .gitmodules entry. Omitted arguments are prompted for
interactively (alias, then task; never auto-selected).
Examples:
  $ oms tree remove api fix-auth   # remove the tree; resume later with oms tree add
`;
export const agentInstallHelp = `
Manages a marker-delimited block (<!-- OMS START --> ... <!-- OMS END -->) in oms/AGENTS.md and/or
oms/CLAUDE.md. These are root-repository files, not submodule files, and are not staged.
Example:
  $ oms agent install --target both
`;
export const agentUninstallHelp = `
Removes the marker-delimited OMS block; a file left empty is deleted. Missing files or blocks are a no-op.
Example:
  $ oms agent uninstall --target both
`;
export const skillsHelp = `
Installs the oms workspace skills (oms-workspace, oms-pointer, oms-branch) via the external "skills" tool.
Project scope (installed at the workspace root, discovered from the root and its subdirectories) is the
default; -g installs globally for every workspace. With --install, oms resolves to the workspace root and
delegates to "npx skills add", forwarding extra arguments (-g, --skill <name>, --list, --copy) straight
through to the skills tool.
Examples:
  $ oms skills                                # print the project and global install commands
  $ oms skills --install                      # install the skills project-scoped at the workspace root
  $ oms skills --install -g                    # install the skills globally
  $ oms skills --install --skill oms-branch    # install one skill
`;
