# Commands

Use this guide to choose the command and confirm which Git repository it affects. For complete arguments, options, examples, and exit behavior, run:

```bash
oms <command> --help
```

Built-in help ships with the installed CLI and is the authoritative exact reference.

## Command map

| Goal | Command | Affected repository |
| --- | --- | --- |
| Create a starter manifest | `oms init` | Current directory; no source repository |
| Diagnose the workspace | `oms doctor` | Read-only checks across the workspace |
| Add or initialize declared repositories | `oms sync` | Main-project registration and selected source repositories |
| Inspect repository state | `oms status` | Read-only across selected source repositories |
| Commit source changes | `oms commit` | One source repository only |
| Record moved source commits | `oms record` | Main project only |
| Start a second task in one repository | `oms tree add`, `oms tree list`, `oms tree remove` | One source repository's worktrees under `.oms-tree/`; no root history change |
| Fetch, pull, or push source history | `oms fetch`, `oms pull`, `oms push` | Selected source repositories |
| Remove registered repositories | `oms unsync` | Main-project registration and selected source repositories |
| Install AI-agent instructions | `oms agent ...` | Root-owned files under `oms/` |
| Show or install agent skills | `oms skills` | Tool installation, not repository history |
| Check or update the CLI | `oms update` | CLI installation, not the workspace |

## Set up and inspect a workspace

### `oms init`

Creates a starter `oms.yaml` in the current directory. The directory must be outside Git or the main Git repository's top level. A nested Git working-tree directory is rejected before files change. Existing manifests are protected unless you explicitly allow replacement.

### `oms doctor`

Checks the nearest manifest, confirms that it belongs to the main Git root, diagnoses each declared repository, and independently reports installed skill freshness and compatibility with the running OMS version. Older or unverifiable skills receive `npx skills update`; incompatible skills prefer a satisfying npm `latest` release and otherwise a satisfying `beta`. These findings and the bounded registry lookup are informational.

### `oms status`

Shows branch, recorded-commit relationship, dirtiness, and ahead/behind state. `moved` means the source checkout differs from the commit recorded by the main project. JSON output is intended for tools and AI agents; see `oms status --help` for its exact schema.

## Add or remove repositories

### `oms sync`

Registers missing repositories, initializes existing registrations, fetches source history, and attaches the configured starting branch (the baseline) only when that preserves the recorded commit. It reconciles OMS-managed remote and branch metadata from `oms.yaml`.

Registration and metadata changes are committed in the main project by default. Choose the no-commit mode when you want them left unstaged. Partial failures isolate successful aliases and preserve unrelated staged paths. See [How OMS works](how-oms-works.md#synchronization) for the safety and recovery model.

### `oms unsync`

Deinitializes and removes selected submodules while keeping their declarations in `oms.yaml`. It refuses to discard uncommitted source changes unless force is explicitly chosen. The removal is committed in the main project by default; no-commit mode leaves it unstaged.

Use `oms sync` and `oms unsync` for repository additions and removals. `oms record` is only for an existing registered repository whose checked-out commit moved.

## Work with source commits

### `oms commit`

Commits changes inside one source repository. Existing staged changes are committed as staged; otherwise OMS stages that source repository's changes. The command never stages or commits the main-project submodule entry.

A registered but uninitialized repository is initialized automatically. An unregistered repository is refused because a fresh checkout cannot contain the source changes you intend to commit.

### `oms record`

Commits selected moved submodule entries in the main project. The commit is path-limited to those entries and refuses unrelated staged paths. It can record the successful selections even when another selected alias cannot be recorded, then reports partial failure.

Push the source commit before recording it so collaborators can fetch the recorded commit.

## Work with branches

### `oms branch switch`

Switches to or creates a local branch. Use it when starting local work; no remote branch is required. Interactive selection is available when the alias or branch is omitted.

### `oms branch checkout`

Fetches `origin` and checks out an existing remote branch as a local tracking branch, or switches to its existing local counterpart. Use `branch switch` instead for a new local branch.

### `oms branch list`

Refreshes every remote declared for one alias, then lists local and remote-tracking branches, baseline certainty, upstream divergence, and detached state. Fetches are retried once. Cached refs remain visible as `stale` after a failed refresh; a remote with no usable refs is `unavailable`.

Listing does not switch, create, delete, merge, or push branches. It does not change the recorded commit unless you explicitly accept a required synchronization.

### `oms branch delete`

Deletes one local branch. It never deletes a remote branch or remote-tracking ref and never changes the recorded commit. The current branch and resolved baseline branches are protected even in force mode. Safe deletion is attempted first; force deletion prints recovery information and rechecks the branch commit before deletion.

See [Branch safety](how-oms-works.md#branch-safety) before force deletion.

## Work on tasks in managed trees

### `oms tree add`

Creates a disposable Git worktree of an initialized repository at `.oms-tree/<alias>/<task>/` and checks out branch `<task>` there. A new branch starts at the submodule's current HEAD (`--from` overrides the start point); an existing branch resumes at its tip, and `--from` with an existing branch fails. The canonical checkout is never moved — a detached HEAD stays detached. Creation needs no network.

Creating a tree makes no root commit and no `.gitmodules` entry; `.oms-tree/` is kept out of root status through the root's local exclude file, so trees are machine-local.

### `oms tree list`

Lists every entry in the `.oms-tree/` namespace: trees of declared aliases and of aliases no longer declared, plus foreign directories that are not registered worktrees. Each entry reports its alias, task, branch, dirty state (untracked files count as dirty), and broken-link state. `oms status` reports the same inventory in the `trees` array of its JSON output.

### `oms tree remove`

Removes the worktree but preserves the `<task>` branch and its commits. A dirty worktree is refused without `--force`; force discards working-tree changes only. Broken trees are pruned (leftover directory removed, stale administrative metadata dropped). A foreign directory is deleted when empty and refused when it contains files unless `--force` is given. Empty `.oms-tree/<alias>/` and `.oms-tree/` directories are cleaned up; the root's local exclude entry stays.

Inside a managed tree, use Git directly; `oms commit`, `oms record`, `oms branch`, `oms fetch`, `oms pull`, and `oms push` refuse to run there and ask you to use the canonical checkout or the workspace root. `oms status`, `oms doctor`, and `oms tree` keep working from inside a tree. `oms unsync` refuses while any tree exists for the alias, because unsync deletes the shared submodule Git directory.

## Synchronize source history

### `oms fetch`

Fetches selected declared remotes with pruning. Registered but uninitialized repositories are initialized. Missing registration may be offered as one explicit synchronization decision.

### `oms pull`

Fast-forwards the current source branch from one selected remote. Dirty source changes are rejected. The command does not record the moved source commit in the main project; follow the printed `oms record` hint after a successful move.

### `oms push`

Pushes the current source branch to selected remotes. It refuses an unregistered repository and never records the moved source commit. Recording is a separate `oms record` step. Upstream setup is limited to `origin`.

## AI tooling

### `oms agent install` and `oms agent uninstall`

Manage an OMS instruction block in `oms/AGENTS.md`, `oms/CLAUDE.md`, or both. These are main-project files under `oms/`, not files in a source repository. Content outside OMS markers is preserved. OMS creates or updates the files but does not stage them.

### `oms skills`

Shows installation commands for the OMS workspace skills. Install mode delegates to the external `npx skills` tool and resolves project-scoped installation to the workspace root. See [AI coding tools](ai-coding-tools.md).

## Update the CLI

### `oms update`

Checks the npm registry and updates only when OMS can confidently identify a supported global installation. Project-local, temporary-runner, development, and unknown installations receive manual guidance instead of being mutated.

When OMS is already current, the command also reports skill freshness and runtime compatibility using the same stable-first, then beta guidance as `oms doctor`. After an upgrade, the old process defers those checks to `oms doctor`. Use check mode for a non-mutating version check; see `oms update --help` for exact syntax.
