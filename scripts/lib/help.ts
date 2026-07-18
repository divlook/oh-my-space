export const exitHelp = "\nExit codes: 0 ok | 1 usage/config error | 2 one or more git operations failed.";

export const workspaceContextHelp = `
Workspace discovery uses the nearest oms.yaml from the current directory upward. An invalid nearest
candidate is an error; OMS never falls back. Submodule topology requires the manifest directory to be
the root Git top-level. Worktree mode also supports plain and nested directories; checkout operations use alias/name.
`;
export const initHelp = `
Default submodule init requires a plain directory or Git top-level. --mode worktree also permits a nested directory.
`;

// Per-command help: each new or changed command states its purpose, scope boundary, and an example.
export const statusHelp = `
Machine-readable mode prints exactly one JSON object on stdout. The schemaVersion 2 payload contains
schemaVersion, toolVersion, mode, workspaceRoot, currentAlias, currentWorktree, currentTarget, root,
repos, and errors. Root may be null outside Git. Submodule entries retain pin and
root.submodulePointers (moved, staged, split, conflict); worktree entries expose common repository state and managed or external
worktrees without pointer fields. Errors use structured scope, alias, target, and message fields.
Examples:
  $ oms status --json          # full workspace state for tools and agents
  $ oms status api --json      # narrow the JSON to one alias
  $ oms status api/login --json # narrow worktree mode to one managed checkout
`;
export const commitHelp = `
Scope: commits inside a selected submodule alias or worktree-mode alias/name only. Existing staged
changes are committed as-is (staged-first); otherwise all changes are staged with git add -A.
An explicit alias takes precedence over an alias inferred from the current configured oms/<alias>/ path.
Examples:
  $ oms commit api -m "feat: add login"   # commit submodule source changes
  $ oms commit -m "fix: typo"             # infer the alias from the current oms/<alias>/ directory
`;
export const recordHelp = `
Scope: commits an existing root gitlink pointer update for one alias in the ROOT repository only
(chore(oms): update <alias> submodule to <sha>). It never adds or removes a submodule registration.
An explicit alias takes precedence over an alias inferred from the current configured oms/<alias>/ path.
Example:
  $ oms record api
`;
export const syncHelp = `
Root topology changes (.gitmodules, oms/<alias>) are left unstaged by default; create the topology
commit through the interactive prompt or with --commit.
In worktree mode, initial provisioning requires origin. If only additional remotes fail, interactive
use may accept degraded provisioning (exit 0); cancellation or non-interactive refusal exits 1.
Later syncs attempt every declared remote, preserve successful updates, and exit 2 if any fetch fails.
Examples:
  $ oms sync api               # add/initialize/refresh oms/api (topology left unstaged)
  $ oms sync api --commit      # also create chore(oms): add api submodule
`;
export const unsyncHelp = `
Root topology changes are left unstaged by default; create the removal topology commit through the
interactive prompt or with --commit.
In worktree mode, unsync fetches every declared remote and removes all managed worktrees plus the owned
common repository only after publication and reconstruction checks. External or locked worktrees always
block removal. --force accepts disclosed managed local loss and stale remote knowledge, but never bypasses
ownership, symlink, external, or lock boundaries. Worktree-mode --commit is unavailable.
Examples:
  $ oms unsync api             # remove oms/api (topology left unstaged)
  $ oms unsync api --commit    # also create chore(oms): remove api submodule
  $ oms unsync api --force     # disclose and discard protected managed worktree state
`;
export const pullHelp = `
Scope: pulls the submodule branch only — it never stages or commits the root gitlink. Record a moved
root pointer afterward with "oms record <alias>".
In worktree mode pull targets alias/name; --all attempts every managed checkout and excludes external worktrees.
Example:
  $ oms pull api
`;
export const pushHelp = `
Scope: pushes the submodule branch only — it never stages or commits the root gitlink. Staging a pointer
for review is not the same as recording a pointer commit: "--commit" is unsupported, so push the branch
with "oms push <alias>", then record the existing root pointer update with "oms record <alias>".
In worktree mode push targets alias/name and has no root pointer follow-up.
Examples:
  $ oms push api
  $ oms record api             # record the moved root pointer
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
