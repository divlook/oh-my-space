# Design: add-temporary-worktree

## Context

OMS manages each source repository as a Git submodule at `oms/<alias>/` whose gitdir lives at `.git/modules/oms/<alias>`. Commands that operate inside a submodule working tree already share one preparation path (`scripts/lib/alias-preparation.ts`) that classifies registration, auto-initializes registered-but-uninitialized aliases, and offers `oms sync` only interactively. Workspace-aware commands discover the root by walking up from the current directory, so anything the CLI must operate on from inside has to live below the workspace root. The 0.5.x bare-clone-plus-worktrees data model was removed in 0.6.0 because the *canonical* checkout was a worktree and recorded commits were not reproducible; this change reintroduces worktrees only as disposable satellites while the submodule stays canonical, so that removal reason does not apply. See `proposal.md` for motivation. Detached-HEAD handling is caller-side (`resolveDetachedHead`, invoked by `commit` and the manage-ops commands after `prepareAlias`), every guarded command enters through `loadForSubmodules()` (`scripts/lib/manifest.ts`), doctor currently inspects only the tracked `.gitignore`, and no `.git/info/exclude` writer exists — `workspace-ignore.ts` only strips entries — so the exclude append is new code.

## Goals / Non-Goals

**Goals:**

- Layer a disposable task checkout on an initialized alias with one command, delete it with one command, and leave root history untouched in between.
- Reuse the shared alias preparation and the existing safety vocabulary (refusal messages that name preserved state and the recovery command).
- Keep agent guidance coherent: the guard refuses `oms` alias commands inside trees, and the skills teach the Git-direct, PR-centric flow that replaces them.

**Non-Goals:**

- No `oms` command integration inside trees — `oms commit`/`oms push` never target a tree; reflection happens in the canonical checkout via `oms pull` + `oms record` (or `oms branch switch` + `oms record` for direct local flow).
- No new published skill; the existing `oms-workspace` and `oms-branch` skills are extended.
- No cross-machine persistence: `.oms-tree/` is machine-local by design and never serialized into the manifest or root history.
- No worktrees for the root repository itself, and no change to the submodule data model.

## Decisions

### D1: Backend is `git worktree` attached to the submodule gitdir

`oms tree add <alias> <task>` runs `git -C oms/<alias> worktree add <absolute .oms-tree path> [-b <task> [<start-point>]]`. The tree shares the submodule's objects, refs, and remotes.

Why not an isolated clone (from origin or from the canonical checkout): a clone must re-point remotes and re-register upstreams, `--from origin/x` would resolve against a different (possibly stale or absent) remote namespace until a fetch happens, and a detached canonical HEAD makes "clone from the submodule" semantically murky. A worktree inherits all of this for free and is created offline. The worktree-specific risks (unsync deletes the shared gitdir; root relocation can break links; Git refuses the same branch in two worktrees) are all front-of-path failures we can detect and guard, whereas the clone's problems are quiet semantic drift.

Alternatives considered: isolated clone from origin (rejected: remote re-pointing, false `origin/*` view, network dependency); local clone with hardlinks (rejected: fast but inherits the same remote surgery plus a second divergence source).

### D2: Trees live at `<root>/.oms-tree/<alias>/<task>/`, excluded via `.git/info/exclude`

The location must be inside the workspace root for discovery to work from inside a tree. The local exclude file keeps the root's `git status` clean while committing nothing — a tracked `.gitignore` entry would itself violate the no-root-commit goal. The entry is appended idempotently by a new exclude writer that reuses the `# managed by oms` comment constant from `scripts/lib/constants.ts` — `workspace-ignore.ts` only strips `.gitignore` entries today, so the writer is new code. A path inside `oms/` was rejected: it would pollute root status as untracked noise and brush against the `oms/<alias>` submodule path convention and the root-tx path filters.

Because the exclude is local, a fresh clone by a teammate never sees `.oms-tree/`; trees are machine-local, which is the intent.

Removing the last inventory entry deletes the empty `.oms-tree/` root but leaves the exclude entry — it is harmless and the next `tree add` reuses it. `oms doctor` warns when `.oms-tree/` exists but the entry is missing (manual `.git/info/exclude` surgery), naming `oms tree add` as the command that re-asserts it; this resolves the change's earlier open question in favor of warning, because doctor is the diagnostic surface and the check is cheap.

### D3: Command surface is `oms tree add|list|remove`; bare `oms tree` prints help

`oms branch` has an interactive action selector because its subcommands are prompt-heavy; `tree` is explicit-first (`add`/`remove` are creating/deleting operations where an accidental default is harmful), so bare `oms tree` falls through to Commander's help. `oms tree list` gets no `--json`: `oms status --json` owns the machine-readable contract and gains the `trees` array (D6).

`oms tree add` prints a one-line confirmation naming the alias and the task, without the filesystem path — agents derive the path from the `.oms-tree/<alias>/<task>/` rule. `oms tree remove` resolves omitted arguments interactively (the alias first, then the task, never auto-selecting, following the `branch delete` destructive-selection convention) and fails with a usage error non-interactively, mirroring `tree add`'s argument contract.

### D4: `oms tree add` joins the shared alias preparation; `list`/`remove` do not

Tree creation needs the submodule gitdir, so `tree add` uses `prepareAlias` exactly like `branch switch`: registered-but-uninitialized aliases are initialized without root topology; an unregistered alias is offered `oms sync` interactively (a fresh registration can serve tree creation) and refused non-interactively with the `oms sync <alias>` hint. `tree list` and `tree remove` deliberately do not prepare — they enumerate and tear down worktree metadata and must keep working on degraded states (broken links, missing gitdir) instead of refusing early.

`tree add` does not run the caller-side detached-HEAD resolution (`resolveDetachedHead`): the start point is the current HEAD *commit*, so a detached canonical checkout stays detached and no prompt or working-tree move can happen. The baseline attachment inside `prepareAlias`'s initialization of a registered-uninitialized alias is unchanged.

### D5: The tree-cwd guard is a shared pre-check at command entry

A helper resolves the workspace root from the current directory and fails when the cwd is under `<root>/.oms-tree/` — before alias resolution, candidate selection, preparation, or any Git mutation, and regardless of an explicit alias. It runs in `commit`, `record`, the `branch` subcommands, and the `manage-ops` commands (`fetch`/`pull`/`push`). `status`, `doctor`, and `tree` are exempt (read-only or tree-scoped). `sync` and `unsync` are not cwd-guarded: they are root-level commands, and `unsync` gets its own stronger alias-level guard (D7). The message states both halves of the contract: Git is used directly inside a tree; `oms` commands run from the canonical checkout or the workspace root.

Guarding only the inferred-alias case was rejected: the installed skills teach `oms commit <alias>` with an explicit alias, so the explicit form is exactly the path a well-meaning agent would take into the wrong checkout.

Bare `oms branch` is guarded before its action selector: every selector outcome is a guarded command, so presenting the menu inside a tree only to fail after the choice is noise.

### D6: Inventory owns the whole `.oms-tree/` namespace

OMS treats `<root>/.oms-tree/` as its own namespace rather than a view filtered by declared aliases: the inventory is the union of a filesystem scan of `<alias>/<task>` entries and the `git worktree list --porcelain` output of every locatable submodule gitdir — the declared aliases' and the gitdirs the trees' own `.git` files reference. Manifest edits therefore cannot orphan a tree: a tree of an alias removed from `oms.yaml` stays listed, removable, and blocking for `unsync`. A filesystem entry no porcelain run reports is a foreign directory (manual creation, crashed creation, lost gitdir) and carries a non-null `error`; a broken entry (unreadable directory, unreadable `.git` link, or prunable porcelain entry) reports `branch`, `head`, and `dirty` as `null`. The namespace unit is the second-level `<alias>/<task>` path; stray files directly under `.oms-tree/` are not tree units. `dirty` counts staged, unstaged, and untracked changes — the same semantics as `repos[].dirty` — so `dirty: false` means exactly "removable without `--force`". `oms status --json` gains a top-level `trees` array (additive under `schemaVersion` 1, which explicitly permits optional fields): one entry per inventory entry with `alias`, `task`, `path`, `absolutePath`, `branch`, `head`, `dirty`, `error`. Human `oms status` lists trees only when any exist, to avoid noise in the common no-tree case. Alias-filtered status narrows `trees` alongside `repos`. A worktree the user attached manually outside `.oms-tree/` is still not OMS's to manage, list, or remove.

### D7: `oms unsync` refuses while the alias has inventory entries, force included

Unsync removes `.git/modules/oms/<alias>`, which deletes every attached worktree's gitdir — including branches with unpushed or unmerged commits. The preflight enumerates the alias's inventory entries and fails with their names and `oms tree remove` as the remediation; every entry state — healthy, broken, or foreign — blocks, because `tree remove` is the remediation for all three. `--force` does not bypass this, following the precedent that `oms branch delete` protects branches even in force mode: force discards *working-tree* changes, and this guard protects *commit history* the user has not chosen to discard.

### D8: `tree remove` deletes the worktree, never the branch

`git worktree remove` already refuses a dirty or untracked-containing worktree, which gives us the safe default; `--force` forwards the discard decision to the user while the branch and its commits survive either way. Broken trees are handled with `git worktree prune` (after removing a leftover directory if one exists) so removal doubles as the recovery path for relocation damage. The success message names the resume command (`oms tree add`) and the branch-deletion command (`oms branch delete`), because branch deletion is deliberately a separate, protected decision.

Removal also refuses when the cwd is inside the tree being removed — the caller's shell would otherwise sit in a deleted directory. Cleanup is the inverse of creation: empty `.oms-tree/<alias>/` parents are deleted, up to the `.oms-tree/` root when the last entry goes, while the exclude entry stays. A foreign directory is deleted when empty and refused when it contains files unless `--force` is given, mirroring the dirty refusal's working-tree protection.

### D9: Task names are single-segment branch names

The task is both the directory name and the branch name, so `oms tree add` rejects any task containing `/` (or otherwise failing branch-name validation, checked with `git check-ref-format`) before touching anything. This keeps the `.oms-tree/<alias>/<task>/` mapping injective and makes the worktree's administrative name (the path basename) equal to the task.

## Risks / Trade-offs

- [Unsync deletes the shared gitdir, killing trees and their branches] → D7 preflight refusal; removal is always an explicit `oms tree remove` step.
- [Workspace root relocation breaks the relative `.git` links of trees] → detection in `tree list`, `status --json`, and `doctor` with `git worktree repair` guidance; the first task is a spike that verifies the actual link layout under a submodule gitdir and the repair behavior, so the detection logic is written against observed behavior rather than assumption.
- [Same branch checked out in two worktrees is refused by Git] → surfaced as a normal failure with the existing refusal style; per-task distinct branches are the expected usage.
- [Local-only exclusion means the exclude entry can be missing after manual `.git/info/exclude` edits] → `tree add` re-asserts the entry idempotently on every run, and `doctor` warns about the missing entry until then.
- [Unpushed commits on a removed tree's branch are invisible] → the branch survives removal, the success message names the resume path, and `oms branch delete` keeps its merged-branch safety checks as the final guard.
- [`.oms-tree` name collision with unrelated user directories] → the guard and inventory only consider the directory below the *resolved* workspace root, so an unrelated `.oms-tree` elsewhere has no effect; inside the root the namespace is OMS-owned, and foreign directories surface as error entries.
- [Foreign directories under `.oms-tree/` may hold unrelated user files] → `tree remove` refuses a non-empty foreign directory without `--force`, mirroring the dirty refusal.

## Test Layering

The tree surface follows the least-expensive-layer rule of `openspec/specs/test-execution/spec.md`. The pure tree-ops decisions — porcelain parsing for healthy, broken, and prunable entries, the filesystem-scan ∪ porcelain union with foreign-directory classification, broken-entry null fields, untracked-inclusive dirty derivation, task-name validation, and the exclude-append idempotence decision — are unit-tested against a queued mock runner (`tests/unit/git.test.ts` pattern), fed the porcelain shapes the spike records. The process-boundary behavior stays blackbox as `tests/cli-tree.contracts.js` sharded across two owners (`tests/cli-tree-a.test.js`, `tests/cli-tree-b.test.js`, the preparation-sharding pattern): lifecycle journeys share one workspace fixture per journey, and the cross-command contracts cover only representative guard paths rather than every guarded command, keeping the new owners near the existing slowest-owner floor instead of becoming the new blackbox bottleneck. New contracts register in `tests/test-inventory.json` with process-boundary rationales, and the change keeps the canonical suite inside the recorded performance budget (median `npm test` ≤ 60 s, no run over 75 s).

## Migration Plan

Purely additive CLI surface with no data-model change; no migration steps and no breaking behavior. Existing workspaces are unaffected until they run `oms tree`. Rollback is removing the commands. Ship as a minor release with a changeset; update `docs/commands.md`, `docs/how-oms-works.md`, and `docs/ai-coding-tools.md` in the same change.

## Spike findings

Observed against a scratch workspace (root repository plus one submodule whose gitdir is absorbed
under `.git/modules/oms/<alias>`):

- `git -C oms/<alias> worktree add` from a branch or a detached HEAD writes the tree's `.git` file
  as `gitdir: <absolute path to .git/modules/oms/<alias>/worktrees/<task>>`; the administrative
  metadata lands there with `commondir` = `../..`. The canonical checkout is untouched: a detached
  HEAD stays detached and the task branch starts at the current HEAD commit.
- `git --git-dir=<submodule-gitdir> worktree list --porcelain` enumerates satellite trees without
  the canonical working tree; its first entry is the gitdir path itself. A healthy entry prints
  `worktree <path>`, `HEAD <oid>`, `branch refs/heads/<name>` (or `detached`); an entry whose
  administrative `gitdir` file points at a non-existent location adds `prunable <reason>`. After a
  workspace-root move the prunable entry still carries the OLD absolute path, so the inventory
  matches porcelain entries to filesystem entries by the `.oms-tree/<alias>/<task>` path suffix,
  not by full-path equality.
- Moving the workspace root breaks both directions of the link. Bare `git worktree repair` from the
  canonical checkout does not restore the satellite links in one shot; `git -C oms/<alias> worktree
  repair <tree-path>` with an explicit tree path restores both directions, so that is the form the
  diagnostics name.
- `git worktree remove` refuses a worktree containing modified or untracked files and `--force`
  removes it while the branch survives. For a prunable entry `worktree remove` fails validation
  even with `--force`, so the broken path is: remove the leftover directory, then `git --git-dir=
  <gitdir> worktree prune`, which drops the stale metadata and preserves branches.
- `git check-ref-format --branch` accepts multi-segment names such as `feat/x` and rejects `a..b`,
  leading `-`, leading `.`, and names with spaces; the no-separator rule is therefore enforced by
  OMS itself before the `git check-ref-format` call (D9 unchanged).
- `git worktree add -b <task>` fails when the branch already exists, and `worktree add` fails when
  the branch is checked out elsewhere — both surfaced as ordinary Git failures, matching D1.

D1 and D6 need no correction; the suffix-based porcelain matching refines how D6's union is keyed.
