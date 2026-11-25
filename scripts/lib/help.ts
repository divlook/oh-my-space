import { SKILL_NAMES_FOR_DISPLAY } from "./constants.js";

export const exitHelp = "\nExit codes: 0 ok | 1 usage/config error | 2 one or more git operations failed.";

export const workspaceContextHelp = `
Workspace discovery uses the nearest oms.yaml from the current directory upward. An invalid nearest
candidate is an error; OMS never falls back to a more distant manifest. Commands that use checkouts,
managed trees, or root ignore rules require that directory to be the root Git top-level. Move a
nested manifest to the Git root or initialize a separate Git repository.
`;
export const initHelp = `
The current directory must be outside a Git work tree or be its root top-level. Init refuses a child of
an existing Git work tree before changing any file, including with --force.
`;

export const independentStatusHelp = `
Machine-readable mode prints one JSON object on stdout with schemaVersion: 2.
Top-level fields: schemaVersion, toolVersion, workspaceRoot, currentAlias, root, repos, trees, errors.
root: branch, head (short SHA), detached, dirty, changes.
repos[]: alias, path, absolutePath, configured, initialized, branch, head (short SHA), detached,
trackingBranch, dirty, changes, ahead, behind, error. Only current declarations appear here.
For both root and repos[], changes contains numeric staged, unstaged, and untracked path counts.
A path modified in both the index and worktree counts as both staged and unstaged.
Without a tracking branch, trackingBranch, ahead, and behind are null. Detached HEAD has a null branch.
trees[]: alias, task, path, absolutePath, branch, head, dirty, error. Broken links and foreign
directories have a non-null error and null branch, head, and dirty values.
If a source cannot be inspected, its error also appears in errors; valid JSON is still printed and the
command exits 2. An unknown alias is reported on stderr before any JSON is printed.
Examples:
  $ oms status --json          # full workspace state for tools and agents
  $ oms status api --json      # narrow the source and tree lists to one alias
`;
export const commitHelp = `
Commits source changes in the selected oms/<alias>/ checkout only. Existing staged changes are
committed as-is; otherwise OMS stages all source changes with git add -A. This command never clones.
A detached HEAD attaches when a local branch points to the same commit. Otherwise OMS asks before
moving the checkout or prints branch-switch guidance.
An explicit alias takes precedence over an alias inferred from the current configured oms/<alias>/ path.
Examples:
  $ oms commit api -m "feat: add login"   # commit source changes
  $ oms commit -m "fix: typo"             # infer the alias from the current oms/<alias>/ directory
`;
export const cloneHelp = `
Clones missing sources on their declared branch or the remote default. Existing checkouts with
matching origin are not moved or rewritten. Clone never stages or commits. For legacy Git data,
run "oms migrate --dry-run" instead.
Examples:
  $ oms clone api
  $ oms clone --all
  $ oms clone --list             # list declarations without opening Git
`;
export const removeHelp = `
Deletes only verified local checkouts. Leaves the manifest, ignore rules, root index and history,
and remote repositories unchanged. Reviews the entire selection before deleting anything.
Use --yes after reviewing the plan for unattended removal. --force permits discarding working files
only. Stashes, linked worktrees, active operations, and unproven local history still block removal.
When origin is inaccessible, only a single explicitly named alias may use a separate exact-alias
confirmation in a terminal. Neither --yes nor --force supplies that confirmation.
Examples:
  $ oms remove api
  $ oms remove --all --yes
`;
export const migrateHelp = `
Converts the entire legacy OMS workspace. Does not accept aliases. Preview with --dry-run before
applying. A terminal confirmation defaults to No; unattended application requires --yes.
Local Git data and linked worktrees are preserved. Root changes are left for review; OMS never
commits or pushes. If interrupted, preserve the journal and rerun "oms migrate --dry-run".
`;
export const execHelp = `
Scope: runs in verified independent checkouts at oms/<alias>/, never in managed trees.
OMS performs no preparation: no cloning, migration, fetching, branch switching, or repair. Dirty
files and detached HEAD are allowed. Missing targets get "oms clone <alias>" guidance; unsafe or
legacy targets report repair or migration guidance. Later eligible targets still run.

The first -- separates OMS options from the executable and literal arguments. Child --help, --all,
and additional -- arguments are passed unchanged. OMS does not interpret shell syntax; invoke an
available shell explicitly when needed. A separator and non-empty executable are required.
Explicit aliases run once in first-occurrence order; --all takes precedence and uses manifest order.
Without a selection, OMS prompts only in an interactive terminal; otherwise name aliases or use --all.

Children inherit your environment, permissions, stdin, stdout, and stderr. Output streams live under
alias-labelled headers, with a final result for every alias. Stdin is consumed sequentially, not replayed
for each child. Non-zero exits, non-SIGINT signals, spawn failures, and target failures do not stop later
targets. Numeric child exit codes and failure reasons appear in results, not as the OMS exit code.

Ctrl+C (SIGINT) interrupts the active child and stops later targets. OMS waits for that child to close,
reports unstarted aliases as not run, and exits 130. A child ending with SIGINT also interrupts the
invocation. OMS does not forcibly kill children that ignore SIGINT or contain intentionally detached
descendants; such children can delay exit, and detached descendants may continue running.

This runner is not a sandbox. User commands can change files, Git state, or remote services and access
the network. OMS performs no additional network operations, implicit commit or push, or rollback.
Completed effects and changes from failed or interrupted children are preserved.
Examples:
  $ oms exec api web -- npm test
  $ oms exec --all -- node -e 'console.log(process.cwd())'
  $ oms exec api -- sh -c 'npm test && npm run build'
Exit codes: 0 all targets succeeded | 1 usage/workspace/selection error | 2 command or target failure
            130 invocation interrupted
`;
export const fetchHelp = `
In a terminal, OMS offers to clone missing aliases once before fetching. Explicit single targets
default to proceeding; batch and picker selections default to skipping. Fetch updates source refs
only and retries a failed fetch once.
Example:
  $ oms fetch api
`;
export const pullHelp = `
Pull fast-forwards source branches only. It does not stage or commit the workspace root.
Missing targets may be cloned after consent, as with fetch.
A detached HEAD attaches automatically when a local branch points at its commit; otherwise OMS asks before
moving the checkout or reports branch-switch guidance.
Example:
  $ oms pull api
`;
export const pushHelp = `
Push requires an existing verified checkout and never provisions a missing source. It pushes the
source branch only. A detached HEAD follows the same attach-or-choose rule as pull.
Examples:
  $ oms push api
  $ oms push api web           # push several aliases
  $ oms push --all             # push every declared source repo
  $ oms push                   # pick the aliases interactively
`;
export const branchSwitchHelp = `
Switches to or creates a local branch. OMS may offer to clone a missing alias in a terminal.
`;
export const branchCheckoutHelp = `
Fetches origin and checks out an existing remote branch. OMS may offer to clone a missing alias
in a terminal.
`;
export const branchListHelp = `
Behavior:
  In a terminal, OMS may offer to clone a missing alias.
  Refreshes declared remotes with prune and retries once, then shows cached refs as stale.
  Reports baseline certainty without changing the checked-out commit.

Examples:
  $ oms branch list api
  $ oms branch list
`;
export const branchDeleteHelp = `
Requires an existing independent checkout. Deletes one local branch; it never deletes remote
branches or changes the workspace root. The current branch and protected baselines are not deletable.
`;

export const branchCleanHelp = `
Examples:
  $ oms branch clean api
  $ oms branch clean api --base origin/develop

Deletes local branches only, with interactive confirmation that defaults to No.
The default base is the configured local branch, or the local branch named by
cached origin/HEAD. Cleanup does not refresh refs or provision missing checkouts.
Detached HEAD and active Git operations are refused.

Detailed safety and recovery:
  https://github.com/divlook/oh-my-space/blob/HEAD/docs/how-oms-works.md#merged-branch-cleanup-safety
`;
export const treeHelp = `
Task trees are Git worktrees of an independent checkout at oms/<alias>/. They live under
.oms-tree/<alias>/<task>/ and share that source's Git directory. OMS keeps .oms-tree/ out of root
status through the root's local exclude file.
Work inside a tree with plain Git; run oms commands from the canonical checkout or the root.
Examples:
  $ oms tree add api fix-auth   # worktree at .oms-tree/api/fix-auth/ on new branch fix-auth
  $ oms tree list               # every tree under .oms-tree/ with branch, dirty, and state
  $ oms tree remove api fix-auth # remove the worktree; branch fix-auth survives
`;
export const treeAddHelp = `
Creates a Git worktree of the verified independent checkout at .oms-tree/<alias>/<task>/ and
checks out branch <task> there. A new branch starts at the canonical HEAD, or at --from <ref>.
An existing branch resumes at its tip and cannot take --from. The canonical checkout stays unchanged.
No network, clone provisioning, or change to root history. The task must be a valid branch name
without "/" separators. Omitted arguments are prompted for interactively.
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
Removal creates no root commit. Omitted arguments are prompted for interactively (alias, then task).
Examples:
  $ oms tree remove api fix-auth   # remove the tree; resume later with oms tree add
`;
export const agentInstallHelp = `
Manages a marker-delimited block (<!-- OMS START --> ... <!-- OMS END -->) in oms/AGENTS.md and/or
oms/CLAUDE.md. These are root-owned files, not source files, and are not staged.
Example:
  $ oms agent install --target both
`;
export const agentUninstallHelp = `
Removes the marker-delimited OMS block; a file left empty is deleted. Missing files or blocks are a no-op.
Example:
  $ oms agent uninstall --target both
`;
export const skillsHelp = `
Installs the oms workspace skills (${SKILL_NAMES_FOR_DISPLAY}) via the external "skills" tool.
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
