# How OMS works

OMS keeps source repositories beside one another. The main project records each source repository's exact commit. This page explains repository boundaries and safety rules for everyday work and recovery.

## Workspace layout

A workspace with `api` and `web` looks like this:

```text
oms.yaml               # declares each source repository
.gitmodules            # registers each oms/<alias> Git submodule
oms/
├── api/               # normal Git working tree
└── web/               # normal Git working tree
.oms-tree/             # machine-local task trees (not committed)
```

See [Managed trees](#managed-trees) for machine-local task worktrees under `.oms-tree/`.

`oms.yaml` is the declaration. The main project tracks `.gitmodules` and each `oms/<alias>` entry. Each directory under `oms/` is a separate Git repository where you can branch, edit, commit, pull, and push.

Do not add `oms/` to `.gitignore`. The submodule entry is how the main project records each source repository's exact commit. `oms sync` removes the stale `oms/` ignore entry created by older OMS versions.

## Two Git boundaries

Every source change crosses two deliberate boundaries:

1. Commit the source change inside `oms/<alias>/`.
2. Push the source commit.
3. Record the new source commit in the main project with `oms record <alias>`.

`oms commit`, `oms pull`, and `oms push` operate in the source repository only. They never stage or commit the main project's submodule entry. `oms record` is the command that commits an existing pointer update in the main project.

The exact submodule commit stored by the main project is the **recorded commit**. A source checkout can move to another commit. `git status` and `oms status` show that change until you record it.

## Managed trees

A **managed tree** is a disposable Git worktree at `.oms-tree/<alias>/<task>/`. It uses the submodule's Git directory and shares its history, branches, remotes, and objects.

Create a managed tree with `oms tree add <alias> <task>`. Managed trees support concurrent tasks without task-specific aliases or extra clones. A new `<task>` branch starts at the canonical checkout's HEAD, or at `--from <ref>`. OMS never moves the canonical checkout.

Adding, listing, and removing trees creates no root commit, `.gitmodules` entry, or gitlink. Task checkouts never enter shared root history.

OMS excludes `.oms-tree/` from root status through the root's local `.git/info/exclude` file. OMS never adds a tracked `.gitignore` entry because that entry requires a root commit. Trees are machine-local. A teammate's fresh clone does not contain them.

Use plain Git inside a managed tree. OMS alias commands (`commit`, `record`, `branch`, `fetch`, `pull`, `push`, `exec`) refuse to run there.

Use this pull-request workflow to return the merged result to the canonical checkout:

1. Commit the `<task>` branch changes inside the tree.
2. Push the `<task>` branch.
3. Open its pull request.
4. After the pull request merges, run `oms pull <alias>` in the canonical checkout to move the submodule branch.
5. Run `oms record <alias>` to commit the moved root pointer.

`oms tree remove <alias> <task>` deletes only the worktree. The `<task>` branch and its commits remain. Delete one branch with `oms branch delete`, or confirm a merged-branch batch with `oms branch clean <alias>`.

`oms unsync` refuses while any tree exists for the alias. Unsync deletes the shared submodule Git directory that those trees use.

`oms status` reports every tree under `.oms-tree/`, including the `trees` array in JSON. `oms doctor` reports broken tree links, for example after you move the workspace root. It recommends `git worktree repair`.

## Workspace discovery

Workspace-aware commands search upward from the current directory and use the nearest `oms.yaml`. OMS treats the nearest entry as authoritative. OMS does not skip an invalid manifest to use an outer workspace.

The manifest must be a regular file or a symbolic link to a regular file. Commands that inspect or change submodules require the manifest directory to be the main Git repository's top level. This prevents a nested manifest from changing the wrong `.gitmodules`, index, or `oms/` directory.

You can run workspace-aware commands at the root or below it. Inside a declared `oms/<alias>/`, OMS can infer the alias for commands such as `oms commit` and `oms record`. An explicit alias always wins. Other descendants can discover the workspace but do not become a current alias.

`oms sync --list` only reads the manifest, so it remains available before Git initialization.

## Synchronization

`oms sync` makes the registered workspace match `oms.yaml` without silently advancing source code:

- OMS registers missing repositories with `git submodule add`.
- OMS initializes registered but uninitialized repositories at the commit recorded by the main project.
- OMS reconciles declared remotes. `remotes.origin` controls both the local `origin` URL and the `.gitmodules` URL.
- An explicit `branch` becomes the baseline. If the manifest omits `branch`, OMS uses the remote's default branch.
- OMS attaches the baseline branch only when this preserves the checked-out commit.

The remote baseline can advance beyond the recorded commit. In this case, synchronization preserves the checkout at the recorded commit and explains how to switch and pull. A fresh clone remains reproducible. Synchronization does not implicitly update source code.

By default, OMS commits repository registration and OMS-managed `.gitmodules` changes in one path-limited main-project commit. Use `--no-commit` to leave those changes unstaged. A failed baseline check leaves the alias's metadata unchanged. OMS reports the failure without printing remote URLs.

## Registration and preparation

Commands other than `oms exec` use these registration and preparation rules:

- **Registered and initialized:** Commands continue normally.
- **Registered but uninitialized:** Commands initialize the repository without changing the main project's registered paths. They then continue.
- **Declared but unregistered:** Read-only or fetch-like workflows may offer `oms sync`. Commit, push, branch deletion, and other commands that require existing local work refuse. A fresh checkout cannot contain that work.
- **Partially or inconsistently registered:** Commands refuse and direct you to `oms sync`. They do not guess which state is correct.

OMS never registers a repository silently. In a non-interactive session, an operation that needs your decision fails without changing the registered workspace.

Before commit, pull, or push, OMS may attach a detached checkout to a local branch that points to the same commit. A **detached HEAD** means Git uses a commit directly instead of a branch. If attachment requires a different commit, OMS asks first or prints `oms branch switch` guidance.

`oms exec` does not use automatic preparation.
It checks each selected canonical checkout immediately before it starts the child process.
OMS accepts initialized repositories with consistent registration, including dirty or detached checkouts.
Missing, uninitialized, occupied, or inconsistent targets fail with `oms sync <alias>` guidance.
OMS preserves those targets and continues with later eligible targets.
It does not prepare targets or offer repair prompts.

## Command execution boundaries

A **canonical checkout** is the declared source repository at `oms/<alias>/`.
`oms exec` selects these checkouts.
It does not infer the current alias or use a managed task tree.
OMS checks the complete selection before it starts a child process.

- Explicit aliases run once in first-occurrence order.
- `--all` takes precedence over explicit aliases and uses manifest order.
- Without a selection, OMS prompts only in an interactive terminal.

The first `--` separates OMS arguments from the executable and its arguments.
OMS invokes the executable directly without a shell.
It preserves argument boundaries and child flags.
Invoke a shell explicitly when you need shell syntax:

```bash
oms exec api -- sh -c 'npm test && npm run build'
```

A **child process** runs the supplied command in the selected checkout.
OMS runs one child process at a time.
Each child process inherits your environment and standard input, output, and error streams.
OMS streams output under a header that identifies the alias.
Child processes consume input sequentially.
OMS does not replay piped input for each target.

OMS does not initialize, register, fetch, switch branches, record pointers, or repair targets around execution.
It does not implicitly commit, push, or undo changes.
It performs no additional network operations.
Child processes retain your permissions.
They may change files, Git state, and remote services.
This runner is not a sandbox.

Child effects remain after failure or interruption.
OMS continues with later eligible targets after non-zero exits, non-SIGINT signals, spawn failures, and target failures.
A **spawn failure** means that OMS cannot start the child process.
The final summary reports every selected alias with its child exit code or failure reason.
OMS uses these exit codes instead of the numeric child exit code:

- `0`: Every selected target succeeds.
- `1`: Usage, workspace discovery, or selection fails.
- `2`: A command or target fails.
- `130`: Ctrl+C or SIGINT interrupts the invocation.

SIGINT is the interrupt signal that a terminal normally sends for Ctrl+C.
Ctrl+C, or a child process that ends with SIGINT, interrupts the invocation.
OMS interrupts the active child process.
It starts no later targets.
It waits for the active child process to finish.

OMS preserves completed effects and results.
It reports unstarted aliases as not run.
It then exits 130.

OMS does not forcibly kill child processes that ignore SIGINT.
Such a child process can delay exit.
OMS does not control descendant processes that intentionally detach.
Those processes may continue to run.

See [Run commands across repositories](commands.md#run-commands-across-repositories) for syntax and examples.


## Status

`oms status` reports each repository's branch, dirtiness, ahead/behind state, and pointer state:

- `ok`: checked out at the recorded commit.
- `moved`: The checkout uses a different commit. Use `oms record` after the source commit is available remotely.
- `uninit`: registered but not initialized.
- `missing`: expected repository state is absent.
- `conflict`: the main-project submodule entry is conflicted.

`oms status --json` emits one schema-versioned JSON object for tools and AI agents. It includes the workspace root, current alias, recorded pointers, and source-repository state. Run `oms status --help` for the authoritative field contract.

## Branch safety

`oms branch delete` removes only one local source-repository branch. It never deletes remote or remote-tracking branches and never changes the recorded commit.

OMS protects the current branch and every reliably resolved baseline, including both sides of baseline metadata drift. OMS refuses ambiguous or malformed baseline metadata to protect branches. OMS also refuses deletion during a merge, rebase, cherry-pick, revert, bisect, or sequencer operation.

Safe deletion uses Git's merged-branch check first. Force deletion requires an explicit choice. Before force deletion, OMS prints the branch tip and a recreation command. OMS then checks the tip again. If another process moves the branch, OMS stops deletion to preserve the unexpected commit.

### Merged branch cleanup safety

`oms branch clean [alias] [--base <ref>]` cleans local branches in exactly one source repository. Omitted aliases always require interactive selection. OMS prepares existing registration without offering new registration; initialization, fetched data, baseline branch creation or attachment, and tracking settings remain if you decline deletion. Managed-tree invocation, inconsistent registration, in-progress source Git operations, and detached HEAD different from the source gitlink committed in root HEAD are refused. A staged gitlink is not the **recorded commit**. Inspection errors fail closed.

The **comparison base** is the existing local branch named by the selected declaration's `branch`, or by existing `origin/HEAD` when omitted. There is no fixed `main` default, remote substitution, or automatic refresh after preparation. `--base` accepts an unambiguous existing direct local or remote-tracking branch, not a tag, commit ID, or revision expression. Cached remote refs may be behind. Update them deliberately through the existing fetch/pull workflow before a new cleanup invocation. An explicit comparison base never bypasses unresolved **protected baselines**; declare `branch` or repair `origin/HEAD` first.

Eligibility requires the branch tip to be contained in the comparison base's history, regardless of HEAD or upstream. Patch equivalence, squash/rebase results without ancestry, and missing remote branches do not prove a merge. OMS excludes the current branch, local comparison base, every reliably resolved protected baseline (including metadata drift), and branches in any registered worktree, even outside `.oms-tree/`. Dirty files are allowed and preserved. Shallow history allows proven ancestors only; explicitly deepen or repair unproven history before rerunning. No implicit fetch fills the gaps.

OMS displays the full base ref and commit, sorted branch tips, exclusions, preparation effects, and concurrency limits before one default-No confirmation. No candidates exits `0` without prompting. Decline, cancellation, or candidates without an interactive terminal exits `1` without deletion. There is no force, workspace-wide, standalone preview, or confirmation-bypass mode.

Before each candidate, OMS rereads the selected declaration, registration, root-committed gitlink, source safety, protected baselines, all-worktree occupancy, ref types and commits, and ancestry. A changed candidate is preserved. A changed base or selected context, unsafe source state, or unreliable shared inspection stops remaining work. Unrelated declarations or root commits alone do not invalidate the plan. Each ref transaction verifies the displayed base and candidate commit values before deleting that candidate; it never switches the checkout or retries with force.

**External concurrent mutation is unsupported.** Other Git or IDE operations must not change source branches, worktrees, or configuration from confirmation waiting through completion. Commit verification does not atomically guard direct-ref type, branch generation, occupancy, metadata, operation markers, or configuration. Candidate identity is name plus commit ID: recreation at the same name and commit, or movement away and back to that commit, is not distinguished. A worktree introduced after inspection can lose its branch. Recreation between ref deletion and configuration cleanup can lose the new branch's settings. These checks are not a universal repository lock.

Results distinguish deleted, already absent, preserved, failed, and not run. Only successfully deleted branch names have their configuration sections removed; missing configuration is harmless. A configuration failure remains a completed ref deletion with incomplete cleanup, a precise repair command, and exit `2`. Candidate-local failures allow later independently safe candidates; shared safety changes stop them. Successful or already-absent batches exit `0`; incomplete batches exit `2` without rollback. Output includes original full tips and shell-safe recreation commands while commits remain available, plus rerun or repair guidance. There is no durable recovery journal. After preparation, remote refs, source HEAD/files/index, root tracked state, and recorded commits remain unchanged.

## Partial success and preserved state

Multi-repository operations isolate failures by alias and summarize partial success. Root finalization records only successful aliases and preserves unrelated staged paths.

When finalizing repository registration or metadata, OMS writes durable recovery state before replacing the main index. If interruption leaves finalization state behind, `oms sync`, `oms unsync`, and `oms record` run a shared recovery preflight. They either complete the known operation safely or stop before making another main-project change.

OMS limits automation to user intent. OMS performs deterministic preparation, but asks before choices such as registering a missing repository. When OMS cannot continue safely, the error names the failed operation and describes preserved state. The error points to an OMS command or limited Git repair.

## Recovery checklist

1. Run `oms status` to identify the affected repository and Git boundary.
2. Run `oms doctor` to diagnose the manifest, Git-root identity, registrations, and installed skill versions.
3. Follow the specific `oms sync`, `oms branch switch`, or `oms record` command printed by the failure.
4. Use manual Git repair only when the error explicitly requires it.
5. Limit the repair to the named repository and paths.

See [Commands](commands.md) to choose a command. Exact flags and exit behavior remain authoritative in `oms <command> --help`.
