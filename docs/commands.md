# Commands

Use this guide to choose a command. Check which Git repository the command affects. For complete arguments, options, examples, and exit behavior, run:

```bash
oms <command> --help
```

Built-in help ships with the installed CLI and is the authoritative exact reference.

## Command map

| Goal | Command | Affected repository |
| --- | --- | --- |
| Create a starter manifest | `oms init` | Current directory, no source repository |
| Diagnose the workspace | `oms doctor` | Read-only checks across the workspace |
| Clone missing declared repositories | `oms clone` | Selected local source checkouts and root-local ignore rules |
| Inspect repository state | `oms status` | Read-only across selected source repositories |
| Commit source changes | `oms commit` | One source repository only |
| Convert a 2.x workspace | `oms migrate` | Verified legacy Git data and affected root files and index entries |
| Start a second task in one repository | `oms tree add`, `oms tree list`, `oms tree remove` | Source-repository worktrees under `.oms-tree/`, no root history change |
| Clean merged local branches | `oms branch clean` | One source repository only |
| Fetch, pull, or push source history | `oms fetch`, `oms pull`, `oms push` | Selected source repositories |
| Run tests, builds, or other commands | `oms exec` | Selected canonical source checkouts. Child commands control additional effects. |
| Remove local checkouts | `oms remove` | Selected local source checkouts only |
| Install AI-agent instructions | `oms agent ...` | Root-owned files under `oms/` |
| Show or install agent skills | `oms skills` | Tool installation, not repository history |
| Check or update the CLI | `oms update` | CLI installation, not the workspace |

## Set up and inspect a workspace

### `oms init`

`oms init` creates a starter `oms.yaml` in the current directory. The directory must be outside Git or at the main Git repository's top level. OMS rejects nested Git working-tree directories before changing files. OMS protects existing manifests unless you explicitly allow replacement.

### `oms doctor`

`oms doctor` checks the nearest manifest and its main Git root identity. It diagnoses each declared repository. It separately reports installed skill freshness and compatibility with the running OMS version.

For older or unverifiable skills, OMS recommends `npx skills update`. For incompatible skills, OMS prefers an npm `latest` release that satisfies compatibility requirements. Otherwise, OMS recommends a `beta` release that satisfies those requirements. These findings and the bounded registry lookup are informational.

### `oms status`

`oms status` shows source branch, dirtiness, and ahead/behind state. It reports only current declarations and lists managed trees separately. A missing checkout appears as `(not cloned)` and is not an error. A blocked checkout, such as a legacy submodule or an occupied path, appears as `(unavailable)` with a diagnostic. For the exact JSON schema, run `oms status --help`.

## Add or remove repositories

### `oms clone`

`oms clone api` provisions the missing checkout on its declared branch, or the remote default when no branch is set. `--all` selects every declaration. `--list` reads declarations without opening Git. Without aliases or `--all`, a terminal prompts for selection.

An existing checkout with matching origin stays on its current branch and commit. OMS never overwrites an occupied or legacy path. For a legacy workspace, use `oms migrate --dry-run`.

### `oms remove`

`oms remove api web` deletes only the verified local checkouts after you approve the plan. It leaves `oms.yaml`, root ignore rules, the root index and history, and remote repositories unchanged. `--all` includes verified former checkouts and reports unidentified paths separately without deleting them. An already absent declared checkout is a no-op.

Review the branches and tags listed in the plan. The terminal prompt defaults to No; unattended removal requires `--yes`. OMS checks HEAD, local refs, and reflog-only commits against current origin refs, and requires each local tag to match by name and object. It does not rely on cached remote-tracking refs for this proof. If OMS cannot prove that history is recoverable, preserve it outside the checkout before retrying. A separate backup protects your data but does not make the origin check pass.

`--force` only allows discarding staged, unstaged, untracked, and ignored working files. It cannot bypass a stash, an in-progress Git operation, a linked worktree, an ownership mismatch, or failed history checks. Resolve the reported blocker and run `oms remove` again.

If origin is inaccessible, only a terminal invocation with one explicitly named alias can use the exception. Make a backup first: the checkout may be your only copy. OMS still blocks reflog-only commits. For local branches tracking origin, it requires each tip to be reachable from its last known upstream. A detached HEAD must be reachable from a last known origin branch. If the remaining checks pass, OMS requires the exact alias in a separate prompt even with `--yes` or `--force`. `--all` cannot use this exception.

One blocked target prevents the batch from starting. OMS checks each target again before deleting it. Do not change checkouts from another process during removal. If a target changes, OMS stops and reports completed and unattempted removals; it does not restore deleted checkouts.

## Work with source commits

### `oms commit`

`oms commit` commits changes inside one source repository. OMS commits existing staged changes as staged. If the source index has no staged changes, OMS stages that source repository's changes. The command never stages or commits root changes and never provisions a missing clone.

### `oms migrate`

`oms migrate --dry-run` previews conversion from OMS 2.x. `oms migrate` converts verified local Git data and updates only the affected root paths. Review the plan and authorize application before any changes. Read the [migration guide](migrations/2.x-to-3.0.0.md) before converting multiple computers.

## Work with branches

### `oms branch switch`

`oms branch switch` switches to or creates a local branch. Use it for new local work. It does not require a remote branch. OMS offers interactive selection when you omit the alias or branch.

### `oms branch checkout`

`oms branch checkout` fetches `origin`. It creates a local tracking branch for an existing remote branch, or switches to the existing local counterpart. Use `branch switch` instead for a new local branch.

### `oms branch list`

`oms branch list` refreshes every remote declared for one alias. It lists local and remote-tracking branches, baseline certainty, upstream divergence, and detached state. OMS retries each fetch once. Cached refs remain visible as `stale` after a failed refresh. A remote with no usable refs is `unavailable`.

Listing does not switch, create, delete, merge, or push branches.

### `oms branch delete`

`oms branch delete` deletes one local branch. It never deletes a remote branch or remote-tracking ref. OMS protects the current branch and resolved baseline branches, even in force mode.

OMS attempts safe deletion first. Force deletion prints recovery information and checks the branch commit again before deletion.

See [Branch safety](how-oms-works.md#branch-safety) before force deletion.

### `oms branch clean`

`oms branch clean [alias] [--base <ref>]` displays and confirms one batch of merged local branches in one source repository. Omit the alias to select interactively, even with a sole alias or from inside its checkout. There is no workspace-wide cleanup, force mode, or confirmation bypass.

The **comparison base** defaults to the existing local branch named by that repository's `oms.yaml` `branch`, otherwise by its cached `origin/HEAD`. There is no fixed `main` default or remote fallback. `--base` selects an unambiguous existing direct local or remote-tracking branch, including a full ref name. It does not replace **protected baselines**. If those cannot be resolved, declare `branch` or repair `origin/HEAD` first. Cleanup does not refresh refs or reconcile remotes after preparation.

```bash
oms branch clean api                      # use the configured local comparison base
oms branch clean api --base origin/develop # use a cached remote-tracking base
```

Use `oms branch clean --help` for a quick reference with examples and essential base, confirmation, and initialization guidance. The rules below and [Merged branch cleanup safety](how-oms-works.md#merged-branch-cleanup-safety) cover detailed safety, concurrency, exit codes, and recovery.

Cleanup requires a verified independent checkout. It never clones a missing source. When candidates exist, the plan shows full refs and commit IDs, candidates, exclusions, and concurrency restrictions. The prompt defaults to No. Decline, cancellation, or candidates without an interactive terminal leave branches unchanged and exit `1`.

After successful inspection, no candidates exits `0` without prompting. Without an exceptional diagnostic, OMS prints only an alias-specific no-op summary. A no-op does not mean working files are clean or all topic branches were merged.

Only proven ancestry in the comparison base qualifies a branch. Extra commits and non-ancestor squash or rebase results remain. The current branch, local comparison base, protected baselines, and branches checked out in any worktree are excluded. Shallow repositories allow proven ancestors but preserve unproven history; deepen or repair it before rerunning. OMS refuses a detached HEAD, an in-progress source Git operation, or unreliable inspection.

Keep other Git or IDE branch, worktree, and configuration changes paused from confirmation waiting through completion. Expected-commit checks do not lock all repository state. Same-name/OID recreation is not distinguished, and recreation between deletion and configuration cleanup can lose the recreated branch's settings. See [Merged branch cleanup safety](how-oms-works.md#merged-branch-cleanup-safety) for the full boundary.

Results distinguish deleted, already absent, preserved, failed, and not run. Deleted branches receive their full original tip and a shell-safe recreation command while the commit is available. Partial failure exits `2` without rollback or force retry. A configuration-cleanup failure leaves the ref deleted and includes a repair command. Cleanup preserves remote refs, source HEAD, source files and index, and the root repository.

## Work on tasks in managed trees

### `oms tree add`

`oms tree add` creates a disposable Git worktree of a verified source checkout at `.oms-tree/<alias>/<task>/`. It uses branch `<task>` there. A new branch starts at the canonical checkout's current HEAD, or at `--from <ref>`. An existing branch resumes at its tip; `--from` fails with an existing branch.

Tree creation needs no network and leaves the canonical checkout unchanged, even when detached. It does not provision missing sources. OMS excludes `.oms-tree/` through the root's local exclude file.

### `oms tree list`

`oms tree list` lists every entry in the `.oms-tree/` namespace:

- Trees for declared aliases.
- Trees for aliases no longer declared.
- Foreign directories that are not registered worktrees.

Each entry reports its alias, task, branch, dirty state, and broken-link state. Untracked files count as dirty. `oms status` reports the same inventory in the `trees` array of its JSON output.

### `oms tree remove`

`oms tree remove` removes the worktree but preserves the `<task>` branch and its commits. OMS refuses a dirty worktree without `--force`. Force discards working-tree changes only.

OMS prunes broken trees by removing leftover directories and stale administrative metadata. OMS deletes an empty foreign directory. OMS refuses a foreign directory that contains files unless you specify `--force`.

OMS removes empty `.oms-tree/<alias>/` and `.oms-tree/` directories. The root's local exclude entry remains.

Use Git directly inside a managed tree. These commands refuse to run there:

- `oms commit`
- `oms branch`
- `oms fetch`
- `oms pull`
- `oms push`
- `oms exec`

They direct you to the canonical checkout or the workspace root. `oms status`, `oms doctor`, and `oms tree` still work inside a tree. `oms remove` refuses while any managed or external linked worktree exists for the alias.

## Synchronize source history

### `oms fetch`

`oms fetch` fetches selected declared remotes with pruning. In a terminal, it may ask once whether to clone missing sources before fetching.

### `oms pull`

`oms pull` fast-forwards the current source branch from one selected remote. OMS rejects uncommitted source changes. The pull changes only the source checkout; the workspace root does not pin the source commit.

### `oms push`

`oms push` pushes the current source branch to selected remotes. It requires an existing verified checkout and limits upstream setup to `origin`.

## Run commands across repositories

### `oms exec`

`oms exec [aliases...] [--all] -- <command> [args...]` runs a command in each selected canonical checkout.
A **canonical checkout** is the declared source repository at `oms/<alias>/`.
OMS runs one child process at a time.
A **child process** runs the supplied command.
OMS accepts dirty files and detached HEAD.
It refuses invocation from a managed tree.

### Arguments and shell syntax

Put the first `--` before the executable.
OMS passes the executable and subsequent arguments unchanged.
These arguments can include:

- Empty strings.
- Child flags such as `--help` and `--all`.
- Additional `--` arguments.

OMS does not interpret shell syntax.
Your calling shell still processes quoting and expansions before OMS receives the arguments.
Quote values that must remain literal.
Invoke an available shell explicitly for pipelines or command chaining:

```bash
oms exec api web -- npm test
oms exec --all -- node -e 'console.log(process.cwd())'
oms exec api -- sh -c 'npm test && npm run build'
```

### Selection and target checks

OMS applies these selection rules before it starts a child process:

- Explicit aliases run once in first-occurrence order.
- `--all` takes precedence over explicit aliases. It selects every declared alias in manifest order.
- If you omit aliases and `--all`, OMS offers the repository selector only in an interactive terminal.
- Non-interactive sessions require explicit aliases or `--all`.
- An unknown explicit alias without `--all` causes the complete selection to fail. No child process starts.

A missing separator or an empty executable causes failure before selection.
`oms exec --help` needs no separator or command.

OMS does not clone, migrate, fetch, switch branches, or repair targets as preparation. Missing targets fail with `oms clone <alias>` guidance; legacy, occupied, and unsafe targets report the appropriate migration or repair step. Eligible later targets still run.
Other commands retain their preparation rules.

### Input, output, and results

Child processes inherit your environment and permissions.
They also inherit standard input (stdin), standard output (stdout), and standard error (stderr).
OMS streams output under a header that identifies the alias.
The final summary reports every selected alias.
Child processes consume stdin sequentially.
OMS does not replay piped input for each repository.

OMS continues after these failures:

- A child process exits with a non-zero code.
- A child process ends with a signal other than SIGINT.
- OMS cannot start a child process.
- A target is unavailable.

Results report numeric child exit codes or failure reasons.
OMS does not use a child exit code as its own exit code:

| Condition | OMS exit code |
| --- | --- |
| Every selected target succeeds | 0 |
| Usage, workspace discovery, or selection fails | 1 |
| A command or target fails | 2 |
| Ctrl+C or SIGINT interrupts the invocation | 130 |

### Interruption and side effects

SIGINT is the interrupt signal that a terminal normally sends for Ctrl+C.
Ctrl+C interrupts the active child process.
OMS starts no later targets.
It waits for the active child process to finish.
The summary preserves completed results and identifies unstarted aliases as not run.
OMS then exits 130.
If a child process ends with SIGINT, OMS also interrupts the invocation.

OMS does not forcibly kill a child process that ignores SIGINT.
That child process can delay exit.
OMS does not control descendant processes that intentionally detach.
Those processes may continue to run.

This runner is not a sandbox.
User commands can change files, Git state, or remote services.
They can also access the network.
OMS performs no additional network operations.
It does not implicitly commit, push, or undo changes.
Child effects remain after failure or interruption.


## AI tooling

### `oms agent install` and `oms agent uninstall`

These commands manage an OMS instruction block in `oms/AGENTS.md`, `oms/CLAUDE.md`, or both. These main-project files under `oms/` do not belong to a source repository. OMS preserves content outside OMS markers. OMS creates or updates the files but does not stage them.

### `oms skills`

`oms skills` shows installation commands for the OMS workspace skills. Install mode delegates to the external `npx skills` tool. OMS resolves project-scoped installation to the workspace root. See [AI coding tools](ai-coding-tools.md) for installation and repository-boundary guidance.

## Update the CLI

### `oms update`

`oms update` checks the npm registry. It updates only when OMS can confidently identify a supported global installation. OMS gives manual guidance for project-local, temporary-runner, development, and unknown installations. OMS does not change those installations.

When OMS is already current, the command reports skill freshness and runtime compatibility. It uses the same guidance as `oms doctor`: stable first, then beta. After an upgrade, the old process defers those checks to `oms doctor`. Use check mode for a version check that makes no changes. See `oms update --help` for exact syntax.
