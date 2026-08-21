# Proposal: add-temporary-worktree

## Why

Running a second task in a source repository currently requires registering a task-specific alias (for example `api@fix-auth`) in `oms.yaml`, syncing it as an extra submodule, and unsyncing it afterwards. That costs a manifest edit plus two root topology commits per task, leaves task gitlinks in shared history for every collaborator to clone, and duplicates the whole repository on disk. Most work is many tasks in one repository, not many repositories; a task needs a disposable checkout layered on an existing alias, not new workspace topology.

## What Changes

- New `oms tree add <alias> <task>`: creates a Git worktree of the initialized submodule `oms/<alias>/` at `<root>/.oms-tree/<alias>/<task>/`. Branch `<task>` is created at the canonical checkout's HEAD by default; `--from <ref>` overrides the start point; an existing `<task>` branch is resumed, and a conflicting `--from` with an existing branch fails. The canonical checkout is never touched — a detached HEAD stays detached and the task branch starts at the current HEAD commit — and success prints a one-line confirmation naming the alias and the task.
- New `oms tree list`: reports each inventory entry's alias, task, branch, and dirty state (untracked files count as dirty), detecting broken worktree links and foreign directories. The inventory owns the whole `.oms-tree/` namespace — a filesystem scan combined with `git worktree list --porcelain` — so trees of aliases no longer declared in `oms.yaml` stay listed and removable.
- New `oms tree remove <alias> <task>`: removes the worktree only — the branch is preserved — refuses a dirty worktree unless `--force` is given, refuses when run from inside the target tree, deletes empty foreign directories (non-empty only with `--force`), prunes broken worktree metadata, cleans up empty `.oms-tree/<alias>/` and `.oms-tree/` directories while keeping the local exclude entry, resolves omitted arguments through interactive alias-then-task selection (a usage error non-interactively), and prints resume (`oms tree add`) and branch deletion (`oms branch delete`) guidance.
- Trees live under `<root>/.oms-tree/`, added to the root's `.git/info/exclude` (local-only). The tree lifecycle creates no root commits, no `.gitmodules` entries, and no gitlinks.
- Alias-targeting commands (`commit`, `fetch`, `pull`, `push`, `record`, `branch` — bare form included, failing before its action selector — and `branch switch|checkout|list|delete`) refuse to run from inside `.oms-tree/` with guidance to use Git directly in the tree and to run `oms` commands from the canonical checkout or the workspace root. Read-only `status`, `doctor`, and `tree` commands remain available there.
- `oms unsync <alias>` refuses while any inventory entry exists for that alias — healthy, broken, or foreign, even with `--force` — because unsync deletes the shared submodule gitdir; the message names the entries and points to `oms tree remove`.
- `oms status` (human and `--json`) and `oms doctor` report managed trees; broken links carry `git worktree repair` guidance, and doctor warns when `.oms-tree/` exists but the root's local exclude entry is missing.
- The `oms-workspace` and `oms-branch` skills gain managed-tree guidance: agents work in trees with Git directly, push and open a PR from there, and reflect the result in the canonical checkout with `oms pull` plus `oms record`.
- Docs updated: `docs/commands.md` command map and tree command sections, `docs/how-oms-works.md` tree model, `docs/ai-coding-tools.md` agent workflow.

## Capabilities

### New Capabilities

- `temporary-worktrees`: Disposable per-task Git worktrees layered on initialized submodules — creation, whole-namespace inventory with foreign-directory reporting, removal, path hygiene and exclusion, the command guard, unsync protection, and status/doctor visibility.

### Modified Capabilities

- `workspace-context`: The submodule root Git identity precondition enumerates the commands it covers; `oms tree add`, `oms tree list`, and `oms tree remove` join that list.
- `ai-submodule-workflow`: Current submodule alias resolution gains an explicit managed-tree exception — a supported alias command run from inside a managed tree fails with tree guidance before candidate selection instead of resolving an alias. Shared preparation gains a `tree add` carve-out: it prepares the alias but never attaches a detached HEAD, starting the task branch at the current HEAD commit.
- `ai-workspace-skill`: The `oms-workspace` and `oms-branch` skills instruct agents on managed-tree scope (Git directly inside trees, `oms` commands outside them) and on starting task work with `oms tree add`.

## Impact

- CLI surface: `tree add|list|remove` commands in `scripts/oms.ts` backed by a new `scripts/lib/tree-ops.ts`; help text in `scripts/lib/help.ts`.
- Existing modules: `scripts/lib/status.ts` (trees in human and JSON output), `scripts/lib/doctor.ts` (tree diagnostics), `scripts/lib/repo-ops.ts` (unsync live-tree refusal), and a shared tree-cwd guard at the entry of the guarded commands.
- Skills: `skills/oms-workspace/SKILL.md` and `skills/oms-branch/SKILL.md` content updates with minor per-skill version bumps per the bump policy; the shared guardrail kernel is unchanged.
- Docs and release: `docs/commands.md`, `docs/how-oms-works.md`, `docs/ai-coding-tools.md`, and a changeset for a minor release.
- Tests: unit tests for the tree-ops decisions and blackbox tree journeys (`tests/cli-tree.contracts.js` sharded across two owners) registered in `tests/test-inventory.json` with process-boundary rationales; the canonical suite stays within the recorded performance budget.
- No new dependencies; `git worktree` needs nothing beyond the supported Git minimum. One spike verifies that worktrees attached to a submodule gitdir (`.git/modules/oms/<alias>`) survive workspace-root relocation, since Git may store relative gitdir paths there.
