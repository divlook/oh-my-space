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
Machine-readable mode prints exactly one JSON object on stdout. The schemaVersion 1 payload has seven
top-level keys: schemaVersion, toolVersion, workspaceRoot, currentAlias, root, repos, and errors.
Submodule pointer movement lives under root.submodulePointers, with moved, staged, split, and conflict
arrays (not a top-level "pointers" key). Each repos[] entry summarizes one oms/<alias>/ submodule
(alias, path, branch, head, pin, dirty, ahead/behind, error). Read the live --json output for exact
per-field values.
Examples:
  $ oms status --json          # full workspace state for tools and agents
  $ oms status api --json      # narrow the JSON to one alias
`;
export const commitHelp = `
Scope: commits inside the selected oms/<alias>/ submodule only — never the root gitlink. Existing staged
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
Examples:
  $ oms sync api               # add/initialize/refresh oms/api (topology left unstaged)
  $ oms sync api --commit      # also create chore(oms): add api submodule
`;
export const unsyncHelp = `
Root topology changes are left unstaged by default; create the removal topology commit through the
interactive prompt or with --commit.
Examples:
  $ oms unsync api             # remove oms/api (topology left unstaged)
  $ oms unsync api --commit    # also create chore(oms): remove api submodule
`;
export const pullHelp = `
Scope: pulls the submodule branch only — it never stages or commits the root gitlink. Record a moved
root pointer afterward with "oms record <alias>".
Example:
  $ oms pull api
`;
export const pushHelp = `
Scope: pushes the submodule branch only — it never stages or commits the root gitlink. Staging a pointer
for review is not the same as recording a pointer commit: "--commit" is unsupported, so push the branch
with "oms push <alias>", then record the existing root pointer update with "oms record <alias>".
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
