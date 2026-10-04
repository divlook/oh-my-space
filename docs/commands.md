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
| Add or initialize declared repositories | `oms sync` | Main-project registration and selected source repositories |
| Inspect repository state | `oms status` | Read-only across selected source repositories |
| Commit source changes | `oms commit` | One source repository only |
| Record moved source commits | `oms record` | Main project only |
| Start a second task in one repository | `oms tree add`, `oms tree list`, `oms tree remove` | Source-repository worktrees under `.oms-tree/`, no root history change |
| Fetch, pull, or push source history | `oms fetch`, `oms pull`, `oms push` | Selected source repositories |
| Run tests, builds, or other commands | `oms exec` | Selected canonical source checkouts. Child commands control additional effects. |
| Remove registered repositories | `oms unsync` | Main-project registration and selected source repositories |
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

`oms status` shows branch, recorded-commit relationship, dirtiness, and ahead/behind state. `moved` means the source checkout differs from the commit recorded by the main project. JSON output serves tools and AI agents. See `oms status --help` for its exact schema.

## Add or remove repositories

### `oms sync`

`oms sync` registers missing repositories, initializes existing registrations, and fetches source history. It attaches the configured starting branch, called the baseline, only when this preserves the recorded commit. It reconciles OMS-managed remote and branch metadata from `oms.yaml`.

OMS commits registration and metadata changes in the main project by default. Choose no-commit mode to leave those changes unstaged. Partial failures isolate successful aliases and preserve unrelated staged paths. See [How OMS works](how-oms-works.md#synchronization) for safety and recovery behavior.

### `oms unsync`

`oms unsync` deinitializes and removes selected submodules but keeps their declarations in `oms.yaml`. It refuses to discard uncommitted source changes unless you explicitly choose force. OMS commits the removal in the main project by default. No-commit mode leaves the removal unstaged.

Use `oms sync` and `oms unsync` for repository additions and removals. `oms record` is only for an existing registered repository whose checked-out commit moved.

## Work with source commits

### `oms commit`

`oms commit` commits changes inside one source repository. OMS commits existing staged changes as staged. If the source index has no staged changes, OMS stages that source repository's changes. The command never stages or commits the main-project submodule entry.

OMS automatically initializes a registered but uninitialized repository. OMS refuses an unregistered repository because a fresh checkout cannot contain the source changes you intend to commit.

### `oms record`

`oms record` commits selected moved submodule entries in the main project. The commit includes only those entries. OMS refuses unrelated staged paths. OMS can record successful selections even when it cannot record another selected alias. OMS then reports partial failure.

Push the source commit before recording it so collaborators can fetch the recorded commit.

## Work with branches

### `oms branch switch`

`oms branch switch` switches to or creates a local branch. Use it for new local work. It does not require a remote branch. OMS offers interactive selection when you omit the alias or branch.

### `oms branch checkout`

`oms branch checkout` fetches `origin`. It creates a local tracking branch for an existing remote branch, or switches to the existing local counterpart. Use `branch switch` instead for a new local branch.

### `oms branch list`

`oms branch list` refreshes every remote declared for one alias. It lists local and remote-tracking branches, baseline certainty, upstream divergence, and detached state. OMS retries each fetch once. Cached refs remain visible as `stale` after a failed refresh. A remote with no usable refs is `unavailable`.

Listing does not switch, create, delete, merge, or push branches. It does not change the recorded commit unless you explicitly accept a required synchronization.

### `oms branch delete`

`oms branch delete` deletes one local branch. It never deletes a remote branch or remote-tracking ref. It never changes the recorded commit. OMS protects the current branch and resolved baseline branches, even in force mode.

OMS attempts safe deletion first. Force deletion prints recovery information and checks the branch commit again before deletion.

See [Branch safety](how-oms-works.md#branch-safety) before force deletion.

## Work on tasks in managed trees

### `oms tree add`

`oms tree add` creates a disposable Git worktree of an initialized repository at `.oms-tree/<alias>/<task>/`. It uses branch `<task>` there. A new branch starts at the submodule's current HEAD. `--from` overrides the start point. An existing branch resumes at its tip. `--from` fails with an existing branch.

OMS never moves the canonical checkout. A detached HEAD stays detached. Creation needs no network.

Creating a tree makes no root commit or `.gitmodules` entry. OMS excludes `.oms-tree/` from root status through the root's local exclude file. Trees are machine-local.

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
- `oms record`
- `oms branch`
- `oms fetch`
- `oms pull`
- `oms push`
- `oms exec`

They direct you to the canonical checkout or the workspace root. `oms status`, `oms doctor`, and `oms tree` still work inside a tree. `oms unsync` refuses while any tree exists for the alias. Unsync deletes the shared submodule Git directory.

## Synchronize source history

### `oms fetch`

`oms fetch` fetches selected declared remotes with pruning. OMS initializes registered but uninitialized repositories. OMS may offer missing registration as one explicit synchronization decision.

### `oms pull`

`oms pull` fast-forwards the current source branch from one selected remote. OMS rejects dirty source changes. The command does not record the moved source commit in the main project. Follow the printed `oms record` hint after a successful move.

### `oms push`

`oms push` pushes the current source branch to selected remotes. It refuses an unregistered repository and never records the moved source commit. Recording requires a separate `oms record` step. OMS limits upstream setup to `origin`.

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

OMS does not initialize, register, fetch, switch branches, record pointers, or repair targets as preparation.
Missing, uninitialized, occupied, or inconsistently registered targets fail individually.
OMS gives `oms sync <alias>` guidance for each failed target.
It preserves that target and continues with later eligible targets.
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
