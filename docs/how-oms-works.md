# How OMS works

OMS keeps independent Git source repositories beside one another. The workspace root shares their declarations; each computer keeps its own branches and source commits.

## Workspace layout

A workspace with `api` and `web` looks like this:

```text
oms.yaml               # declares each source repository
oms/
├── api/               # normal Git working tree
└── web/               # normal Git working tree
.oms-tree/             # machine-local task trees (not committed)
```

See [Managed trees](#managed-trees) for machine-local task worktrees under `.oms-tree/`.

`oms.yaml` belongs to the root repository. Each directory under `oms/` is an independent Git checkout where you can branch, edit, commit, pull, and push.

OMS ignores the checkout paths individually. Keep `oms/` itself visible so root-owned files such as `oms/AGENTS.md` can be tracked.

## Two Git boundaries

Commit the repository list and other shared workspace files in the root. Commit, pull, and push source work in the relevant checkout. `oms commit`, `oms pull`, and `oms push` act only in the source repository. A root checkout or pull does not update source branches.

## Managed trees

A **managed tree** is a separate Git working directory at `.oms-tree/<alias>/<task>/`. It shares its canonical source's history, branches, remotes, and objects.

Create a managed tree with `oms tree add <alias> <task>`. Managed trees support concurrent tasks without task-specific aliases or extra clones. A new `<task>` branch starts at the canonical checkout's HEAD, or at `--from <ref>`. OMS never moves the canonical checkout.

Adding, listing, and removing trees does not stage or commit anything in the root. Task checkouts stay on the current computer.

Before creating a managed tree, OMS adds the `.oms-tree/` rule to the root repository's local exclude file, usually `.git/info/exclude`. If another process holds the file's lock, OMS stops before creating the tree or its branch. OMS does not add a tracked `.gitignore` entry. Trees are machine-local; a teammate's clone does not contain them.

Use plain Git inside a managed tree. OMS source commands (`commit`, `branch`, `fetch`, `pull`, `push`, and `exec`) refuse to run there.

Use this pull-request workflow to return the merged result to the canonical checkout:

1. Commit the `<task>` branch changes inside the tree.
2. Push the `<task>` branch.
3. Open its pull request.
4. After the pull request merges, run `oms pull <alias>` in the canonical checkout.

`oms tree remove <alias> <task>` deletes only the worktree. The `<task>` branch and its commits remain. Delete one branch with `oms branch delete`, or confirm a merged-branch batch with `oms branch clean <alias>`.

`oms remove` refuses while a managed tree or external linked worktree exists for the source.

`oms status` reports every tree under `.oms-tree/`, including the `trees` array in JSON. `oms doctor` reports broken tree links, for example after you move the workspace root. It recommends `git worktree repair`.

## Workspace discovery

Workspace-aware commands search upward from the current directory and use the nearest `oms.yaml`. OMS treats the nearest entry as authoritative. OMS does not skip an invalid manifest to use an outer workspace.

The manifest must be a regular file or a symbolic link to a regular file. Before a command uses a source checkout, managed tree, or root ignore rules, OMS verifies that the manifest directory is the Git top-level.

You can run workspace-aware commands at the root or below it. Inside a declared `oms/<alias>/`, supported commands can infer the alias. An explicit alias wins. Other descendants can discover the workspace without setting a current alias.

`oms clone --list` only reads the manifest, so it remains available before Git initialization.

## Synchronization

`oms clone` provisions missing sources on the branch in `oms.yaml`, or the origin default branch when you omit it. It adds the declared remotes and ignores only the checkout paths. It never advances or rewrites a verified existing checkout.

An existing checkout must have its own `.git` directory and one `origin` that matches the declaration after Git URL rewriting. OMS preserves occupied paths, aliases now assigned to another origin, and legacy submodule data. Use `oms migrate --dry-run` to inspect a legacy workspace.

## Preparation and consent

`fetch`, `pull`, `branch list`, `branch switch`, and `branch checkout` may offer to clone missing sources in a terminal. OMS lists the missing targets and asks once. Decline leaves them absent; eligible existing targets can continue. Commands that require existing local work, including `commit`, `push`, and `exec`, do not offer to clone.

A **detached HEAD** means Git uses a commit directly instead of a branch. Before an operation that requires a branch, OMS may attach a local branch at that same commit. If attachment requires moving to another commit, OMS asks first or prints `oms branch switch` guidance.

`oms exec` verifies each target just before starting the child process. It accepts dirty and detached checkouts but never prepares an unavailable target. It reports the failure and continues with eligible targets.

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

OMS does not clone, migrate, fetch, switch branches, or repair targets around execution.
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

`oms status` reports the branch, current commit, dirtiness, and tracking divergence for each selected declaration. A missing checkout is `(not cloned)` and adds no error. A blocked checkout is `(unavailable)` with a diagnostic and makes the command exit `2`. A legacy submodule, an occupied path, or an unsafe checkout can block inspection. `oms doctor` separately identifies former checkouts and paths whose ownership cannot be verified.

`oms status --json` emits one JSON object with `schemaVersion: 2`, including the workspace root, current alias, declared source states, and managed trees. Run `oms status --help` for the field contract.

In JSON, both missing and blocked checkouts have `initialized: false`. A missing checkout has `error: null`; a blocked checkout has an error message. Do not interpret an uninitialized checkout's default change counts as proof that its files are clean.

## Branch safety

`oms branch delete` removes only one local source branch. It never deletes a remote branch or a remote-tracking ref.

OMS protects the current branch and reliably resolved baselines. It also refuses branch deletion during a merge, rebase, cherry-pick, revert, bisect, or sequencer operation.

Safe deletion uses Git's merged-branch check first. Force deletion requires an explicit choice. Before force deletion, OMS prints the branch tip and a recreation command. OMS then checks the tip again. If another process moves the branch, OMS stops deletion to preserve the unexpected commit.

### Merged branch cleanup safety

`oms branch clean [alias] [--base <ref>]` cleans local branches in one verified independent checkout. Omitted aliases always require interactive selection. Cleanup never clones a missing source and refuses managed-tree invocation, detached HEAD, in-progress Git operations, or unreliable inspection.

The **comparison base** is the existing local branch named by the selected declaration's `branch`, or by existing `origin/HEAD` when omitted. There is no fixed `main` default, remote substitution, or automatic refresh after preparation. `--base` accepts an unambiguous existing direct local or remote-tracking branch, not a tag, commit ID, or revision expression. Cached remote refs may be behind. Update them deliberately through the existing fetch/pull workflow before a new cleanup invocation. An explicit comparison base never bypasses unresolved **protected baselines**; declare `branch` or repair `origin/HEAD` first.

Eligibility requires that the branch tip is in the comparison base's history, regardless of HEAD or upstream. Patch equivalence, squash or rebase results without ancestry, and missing remote branches do not prove a merge. OMS excludes the current branch, local comparison base, protected baselines, and branches in any worktree. Dirty files are preserved. Shallow history protects unproven commits; explicitly deepen or repair it before retrying.

When candidates exist, OMS displays the base ref and commit, sorted branch tips, exclusions, and concurrency limits before one default-No confirmation. With no candidates and no exceptional diagnostic, it prints an alias-specific summary and exits `0`. A no-op does not imply clean working files or that all topic branches were merged.

Before each candidate, OMS rereads the selected declaration, checkout identity, source safety, protected baselines, worktree occupancy, ref types and commits, and ancestry. A changed candidate is preserved. A changed base or selected context, or unreliable shared safety, stops remaining work. Unrelated declarations or root commits alone do not invalidate the plan. Each ref transaction verifies the displayed base and candidate commits before deleting, without switching or retrying with force.

**External concurrent mutation is unsupported.** Other Git or IDE operations must not change source branches, worktrees, or configuration from confirmation waiting through completion. Commit verification does not atomically guard direct-ref type, branch generation, occupancy, metadata, operation markers, or configuration. Candidate identity is name plus commit ID: recreation at the same name and commit, or movement away and back to that commit, is not distinguished. A worktree introduced after inspection can lose its branch. Recreation between ref deletion and configuration cleanup can lose the new branch's settings. These checks are not a universal repository lock.

Results distinguish deleted, already absent, preserved, failed, and not run. Only successfully deleted branches have their configuration removed. A configuration failure reports a completed deletion and a repair command. Independently safe candidates can continue. Successful or already-absent batches exit `0`; incomplete batches exit `2` without rollback. Output includes original commit IDs and recreation commands while the commits remain available.

## Partial success and preserved state

Multi-source operations report per-alias success and failure. `oms remove` is stricter: it checks the entire selection before deleting anything and stops remaining deletions if the approved state changes. Recoverability is checked against current origin refs when origin is available. This check protects Git history, not discarded working files, and it cannot guarantee origin will retain those refs later. See [removal safeguards](commands.md#oms-remove) for the typed-alias exception and what `--force` can discard.

`oms migrate` is the one source lifecycle command that updates shared root files and the index. It records a local recovery journal before moving Git data and only resumes from verified states. See the [migration guide](migrations/2.x-to-3.0.0.md).

## Recovery checklist

1. Run `oms status` to identify the affected repository and Git boundary.
2. Run `oms doctor` to diagnose the manifest, Git-root identity, checkout ownership, and installed skills.
3. Follow the specific clone, migration, branch, or Git repair guidance printed by the failure.
4. Use manual Git repair only when the error explicitly requires it.
5. Limit the repair to the named repository and paths.

See [Commands](commands.md) to choose a command. Exact flags and exit behavior remain authoritative in `oms <command> --help`.
