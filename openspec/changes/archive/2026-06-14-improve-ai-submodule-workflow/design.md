## Context

`oms` manages Git submodules under `oms/<alias>/` and smooths over common submodule workflows such as sync, branch switching, pull, push, and root gitlink staging. The current `oms push --commit` option creates a root repository commit for the moved gitlink, but there is no first-party command for committing source changes inside a submodule and no machine-readable status contract for AI agents.

This leaves two boundaries ambiguous for AI-assisted work:

- Repository scope: root repository versus `oms/<alias>/` submodule repository.
- Commit scope: submodule source commit versus root gitlink pointer commit.

The existing README already teaches users to commit inside the submodule, run `oms push`, then record the root pointer. This change makes those boundaries explicit in the CLI and provides agent instructions that can be installed into the workspace.

## Goals / Non-Goals

**Goals:**

- Provide a stable JSON status output that agents can inspect before branch, commit, push, or pointer-record work.
- Provide an `oms commit` command that commits only inside the selected submodule and never stages or commits root repository gitlinks.
- Provide an `oms record` command that commits only existing recorded gitlink pointer updates for the selected submodule.
- Make `oms record` the only CLI path that creates automatic commits for existing root gitlink pointer updates; sync/unsync topology commits remain a separate add/remove-submodule path.
- Stop leaving automatically staged root index changes from sync-oriented commands by default, while allowing explicit root topology commits through sync/unsync prompts or `--commit`.
- Use Conventional Commit messages for automatic root pointer-update commits and sync/unsync topology commits.
- Manage concise AI instruction blocks in `oms/AGENTS.md` and/or `oms/CLAUDE.md` without overwriting unrelated user content.

**Non-Goals:**

- Replace Git's general-purpose commit, branch, or status commands outside `oms` workflows.
- Add an embedded AI agent runtime or build the installable `oms` workspace skill (handled by a separate change).
- Auto-detect user intent in non-interactive mode from dirty or moved state alone.
- Support multi-pointer `oms record --all` in this change.
- Support `--no-verify` for submodule commits or root pointer records in this change.
- Manage root-level `AGENTS.md` or `CLAUDE.md` files.
- Add `oms push --record`.
- Extend current-path alias inference beyond `oms commit` and `oms record` to multi-alias commands such as `oms pull`, `oms push`, `oms sync`, `oms unsync`, or `oms status`.

## Decisions

### Decision: Add JSON status as the agent-facing state contract

`oms status --json` will emit exactly one pretty-printed JSON object on stdout. Warnings and errors may be written to stderr, but stdout must remain parseable JSON.

Top-level fields:

```json
{
  "schemaVersion": 1,
  "toolVersion": "0.9.1",
  "workspaceRoot": "/path/to/workspace",
  "currentAlias": "api",
  "root": {
    "branch": "main",
    "head": "abc1234",
    "detached": false,
    "dirty": true,
    "changes": {
      "staged": 0,
      "unstaged": 1,
      "untracked": 0
    },
    "submodulePointers": {
      "moved": ["api"],
      "staged": [],
      "split": [],
      "conflict": []
    }
  },
  "repos": [
    {
      "alias": "api",
      "path": "oms/api",
      "absolutePath": "/path/to/workspace/oms/api",
      "configured": true,
      "initialized": true,
      "branch": "feature/login",
      "head": "def5678",
      "detached": false,
      "trackingBranch": "origin/feature/login",
      "pin": "moved",
      "dirty": true,
      "changes": {
        "staged": 1,
        "unstaged": 2,
        "untracked": 3
      },
      "ahead": 1,
      "behind": 0,
      "error": null
    }
  ],
  "errors": []
}
```

`schemaVersion` versions the JSON contract. Version 1 allows adding new optional fields without changing the version, but changing or removing existing field names, meanings, or types requires a new `schemaVersion`. `toolVersion` records the `oms` package version for debugging. `workspaceRoot` and `absolutePath` use OS-native absolute paths. `repos[].path` uses POSIX-style workspace-relative paths.

`currentAlias` is based on the current path being inside a configured `oms/<alias>/` subtree, independent of whether the submodule is initialized. If the current path is not inside a configured alias, `currentAlias` is `null`. For detached HEAD states, `branch` is `null`, `detached` is `true`, and `head` contains the short SHA. If a tracking branch is absent or cannot be inspected, `trackingBranch`, `ahead`, and `behind` are `null`; otherwise `ahead` and `behind` are numbers, including `0`. Uninitialized repos remain in `repos[]`; Git-dependent scalar fields are `null` when unknown and structured fields preserve their normal shape with safe defaults. `configured` means the alias exists in `oms.yaml`; it does not mean the submodule is registered in `.gitmodules`.

`pin` values are `ok`, `moved`, `uninit`, `missing`, and `conflict`. `missing` means the alias is configured but the root repository HEAD has no recorded gitlink for `oms/<alias>`. `uninit` means the root repository HEAD has a recorded gitlink for `oms/<alias>` but the submodule working tree is not initialized. `conflict` means the root repository has a conflicted gitlink for the alias. When more than one condition holds, `pin` reports the highest-precedence value in the order `conflict > missing > uninit > moved > ok`. A never-synced configured alias therefore reports `missing`, not `uninit`, because there is no recorded root gitlink to initialize from. `staged` and `split` are never `pin` values: by construction `staged` implies `moved` and `split` implies `moved`, so such aliases report `pin: "moved"` and the index-versus-worktree detail lives only in `root.submodulePointers`. Human-readable `oms status` should show the same pin vocabulary rather than collapsing `missing` or `conflict` into another value.

`root.submodulePointers` separates raw root repository status from OMS pointer semantics:

- `moved`: the root repository HEAD recorded pointer differs from either the root repository index pointer or working tree submodule HEAD, including pending removal where the root HEAD still has a gitlink but the working tree path has been removed.
- `staged`: the root repository index pointer differs from the root repository HEAD recorded pointer.
- `split`: the alias is staged (the root repository index pointer differs from the root repository HEAD pointer) and that staged index pointer differs from the working tree submodule HEAD.
- `conflict`: the root repository has a conflicted gitlink for the alias.

`oms status --json` emits two-space pretty JSON plus a trailing newline. Stdout contains only the JSON object. Diagnostics, warnings, and partial failure details may be written to stderr. If a repo status cannot be read, the command keeps stdout as valid JSON, preserves the repo entry shape, sets unknown scalar values to `null`, keeps structured fields such as `changes` in their normal object shape with safe default values, sets `repos[].error`, adds an entry to top-level `errors`, and exits non-zero. Observed states such as dirty changes, moved pointers, and conflict pins do not make status fail by themselves.

When aliases filter `oms status --json`, `repos[]`, `root.submodulePointers`, repo-level errors, and the exit code reflect only the selected aliases. `root` status and `currentAlias` remain present. Unknown aliases are invalid invocation errors and fail before JSON is emitted.

Change counts use `git status --porcelain=v1 -z` path counts. Rename and copy entries count as one resulting path. A path with both staged and unstaged changes contributes to both counts. `root.changes` reports non-submodule root repository paths only; root gitlink movement is reported through `root.submodulePointers`, and submodule source changes are authoritative in `repos[].changes`.

Rationale: table output is readable for humans but brittle for agents. JSON lets agent instructions require an inspection step without parsing columns or terminal styling.

### Decision: Resolve aliases with explicit, path-based, and interactive rules

Single-alias commands use this resolution order:

1. Use the explicit alias argument when provided.
2. Infer the alias when `process.cwd()` is exactly inside `oms/<alias>` or one of its child paths.
3. In interactive mode, present command-specific valid candidates.
4. In non-interactive mode, fail and require an explicit alias.

Path inference is based on path segments, not string prefixes. `oms/api-extra` must not match alias `api`. If the inferred alias is uninitialized, resolution still succeeds, and the command then fails its own initialization precondition with a targeted message.

Interactive candidate filters are command-specific:

- `oms commit`: dirty submodules only.
- `oms record`: moved root pointers only, excluding pending removals (a pending removal is recorded with `oms unsync <alias> --commit`).

In interactive mode, zero candidates produce a no-op exit 0, one candidate is auto-selected with a short message, and multiple candidates show a picker. In non-interactive mode, candidate count is not used for auto-selection.

Rationale: this supports the common agent case of being asked to work from inside a submodule while avoiding guesses from dirty or moved state in automation.

### Decision: `oms commit` commits only inside the selected submodule

`oms commit <alias> -m <message>` will run the commit workflow inside `oms/<alias>/` only. If the selected submodule already has staged changes, the command commits only those staged changes and does not run `git add -A`. If the selected submodule has no staged changes, the command stages all changes inside that submodule with `git add -A`, so untracked, modified, and deleted files are included. It never stages or commits the root gitlink.

When staged and unstaged or untracked submodule changes are both present, `oms commit` commits only the staged changes and warns that remaining changes were left uncommitted. This supports users and agents that split a submodule's work into multiple logical commits by staging paths or hunks with raw Git or an editor before invoking `oms commit`.

The command supports repeated `-m` values and passes them through to `git commit`. It does not open an editor. A message is required only when the command needs to create a submodule source commit; complete no-op cases may run without `-m`. If submodule changes exist and `-m` is absent, the command fails. It does not validate the user's commit message format. Conventional Commit enforcement applies only to automatic root pointer-update commits and sync/unsync topology commits.

Safety preconditions:

- Fail on detached HEAD and direct the user to `oms switch <alias> <branch>`.
- Fail when merge, rebase, cherry-pick, revert, bisect, or similar Git operation state is in progress.
- Fail when the submodule is not initialized.
- Do not block on remote `behind` state; Git push/pull policies remain repo-specific.

No-op behavior:

- If there are no submodule changes, print `Nothing to commit for <alias>.` and exit 0.
- If an existing recorded root pointer is moved, print a hint to run `oms record <alias>`.
- If the alias has pending add topology because the root repository HEAD has no recorded gitlink, print a hint to create the topology commit with `oms sync <alias> --commit` instead of suggesting `oms record <alias>`.
- If a commit succeeds, print the short commit SHA and the appropriate root follow-up hint.

Rationale: the primary safety goal is repository scope. A scoped command that respects an existing submodule index preserves partial commit workflows without requiring another option. Falling back to `git add -A` only when nothing is staged preserves the common all-changes workflow.

### Decision: Record root pointers explicitly with strict index safety

Pointer recording is centralized in a helper used by `oms record`. For a single alias, the automatic root commit message is:

```text
chore(oms): update <alias> submodule to <short-sha>
```

The `<short-sha>` comes from `git rev-parse --short HEAD` inside the submodule. The alias is placed unchanged in the subject; the Conventional Commit scope remains `oms`.

`oms record <alias>` stages and commits only the selected existing `oms/<alias>` gitlink update. It uses path-limited root repository commit semantics after safety checks. It does not include unrelated root repository changes and is not used for initial submodule adds or removals.

Safety rules:

- Fail if the root repository is detached HEAD.
- Fail if a root repository merge, rebase, cherry-pick, revert, bisect, or similar operation is in progress.
- Fail if the root repository HEAD has no recorded gitlink for the alias (`pin: "missing"`) and, when pending add topology is detected, direct the user to `oms sync <alias> --commit`.
- Fail if the alias has a conflicted root gitlink (`pin: "conflict"`).
- Fail if the alias is a pending removal (the root repository HEAD has a gitlink for `oms/<alias>` but the working tree path has been removed); direct the user to `oms unsync <alias> --commit`.
- Fail if the root repository index has staged paths other than exactly `oms/<alias>`.
- Treat staged `oms/<alias>/...` child paths as unrelated staged changes and fail.
- Use NUL-delimited staged path checks, such as `git diff --cached --name-only -z`.
- Allow unrelated unstaged root repository changes.
- Allow the selected gitlink if it is already the only staged path and matches the working tree pointer.
- Fail if the selected alias has a staged/worktree pointer split.
- Warn, but allow recording, if the submodule has uncommitted source changes; record only the current HEAD pointer.

Pointer OID comparisons should use direct Git object queries rather than status text: root repository HEAD gitlink, root repository index gitlink, and submodule working tree HEAD.

No-op behavior:

- If there is no pointer movement, print `Nothing to record for <alias>.` and exit 0.
- If record succeeds, print the root commit short SHA and commit message.
- If the final root commit fails after staging the selected gitlink, leave the staged gitlink in place, matching Git's normal failed-commit behavior.

Rationale: `record` names the root gitlink operation more precisely than `commit`, and strict index checks preserve the one-alias commit boundary.

### Decision: Keep pull and push root-safe and make `record` explicit

`oms pull <alias>` and `oms push <alias>` change behavior to synchronize only the submodule branch. They may leave the root gitlink visibly moved in the root working tree when the submodule HEAD changes, but they do not stage or commit the root gitlink. Documentation and help must describe this as:

- `pull`: pull the selected submodule branch only.
- `push`: push the selected submodule branch only.
- `record`: commit the selected pointer.

`oms pull` pulls only the selected submodule branch with the existing fast-forward policy. It fails before running Git when the submodule has uncommitted changes and asks the user to commit, stash, or clean first. `oms push` pushes only the selected submodule branch and warns, but proceeds, when the submodule has uncommitted changes because only the current HEAD is pushed. A detached submodule HEAD fails before pull or push and directs the user to `oms switch <alias> <branch>`. If an existing recorded root pointer is moved after a successful pull or push, the command prints a hint to run `oms record <alias>`. If the alias has pending add topology instead, it prints a topology commit hint rather than a record hint.

When pushing multiple aliases, process aliases independently, continue after per-alias push failures, summarize results at the end, and exit non-zero if any alias failed.

`oms push --commit` is removed as a supported workflow shortcut. It is rejected before any push starts, prints migration guidance explaining that submodule branches are pushed with `oms push <alias>` and existing root gitlink pointer updates are committed with `oms record <alias>`, and exits with a usage/config error. `oms push --record` is not added; it is also rejected before pushing as an unsupported option.

Rationale: keeping existing root gitlink pointer-update commits behind `oms record` makes the scope boundary simpler for both users and agents. Rejecting `--commit` before pushing avoids a confusing non-zero exit after a successful push and prevents automation from retrying a command that already mutated a remote.

### Decision: Stop leaving automatic root index staging from sync commands

`oms sync` and `oms unsync` still perform their workspace topology changes in the root working tree, such as `.gitmodules` updates and submodule directory changes. By default, they must not leave those changes staged in the root index. After successful topology changes, if no topology commit is created, the commands unstage the root paths they caused to be staged by underlying Git submodule operations. The unstage operation is path-limited to `.gitmodules` and the selected `oms/<alias>` paths, so unrelated staged root changes are preserved.

In interactive mode without `--commit`, when a successful `oms sync` or `oms unsync` leaves detected pending topology for the selected aliases, the command asks whether to create a root topology commit. This prompt is driven by detected pending topology from root HEAD, working tree, and `.gitmodules` state, not only by a change made in the current invocation, so it re-appears on a later `oms sync`/`oms unsync` while the topology change remains uncommitted. The prompt defaults to Yes and shows the automatic commit message. If the user declines, the command applies the path-limited unstage behavior. In non-interactive mode without `--commit`, they do not commit and apply the path-limited unstage behavior. With explicit `--commit`, they create a topology commit without prompting in both interactive and non-interactive environments. `sync --commit` and `unsync --commit` also work when the topology working tree changes already exist from a previous no-commit run.

Pending add topology is detected when the root HEAD has no `oms/<alias>` gitlink, the working tree has an initialized `oms/<alias>` submodule, and `.gitmodules` contains an entry whose path is `oms/<alias>`. Pending removal topology is detected when the root HEAD has an `oms/<alias>` gitlink and both the working tree path and `.gitmodules` entry for `oms/<alias>` have been removed. A state where only one of the path or `.gitmodules` entry is absent is partial removal topology; automatic topology commits must not commit that partial state unless the current `oms unsync` invocation completes the matching cleanup first.

Topology commit messages are automatic:

- Single-alias sync: `chore(oms): add <alias> submodule`
- Single-alias unsync: `chore(oms): remove <alias> submodule`
- Multi-alias sync: `chore(oms): add submodules`
- Multi-alias unsync: `chore(oms): remove submodules`

Topology commits are distinct from `oms record` pointer-update commits: topology commits add or remove submodule registrations and may include `.gitmodules` plus `oms/<alias>` gitlinks, while `oms record` updates an existing recorded gitlink to the selected submodule HEAD. Topology commits are the only non-`record` CLI path that may create root commits, and they are limited to add/remove topology rather than existing pointer updates. Topology commits fail before commit creation if unrelated root paths are already staged. In that safety-failure case, selected topology paths are path-limited unstaged before the command fails. If the final Git commit process itself fails after staging topology paths, leave those staged paths in place, matching Git's normal failed-commit behavior. Multi-alias sync/unsync with `--commit` creates one root topology commit only when all requested aliases are processed successfully. If any requested alias fails, no topology commit prompt is shown and no topology commit is created; successful topology working tree changes are path-limited unstaged and summarized for manual review.

In interactive multi-alias sync/unsync without `--commit`, the command asks once whether to commit the successfully processed topology changes, but only if all requested aliases succeeded.

Rationale: automatic root index staging conflicts with strict `oms record` safety checks and is surprising during AI-assisted workflows. Default unstage behavior keeps staged state explicit, while prompt/`--commit` support gives users a first-class topology commit path at the moment the topology change is created.

### Decision: Manage concise agent instructions under `oms/` with marker blocks

`oms agent install` and `oms agent uninstall` manage instruction blocks in selected root-repository files under the workspace `oms/` directory:

- `oms/AGENTS.md`
- `oms/CLAUDE.md`
- both files

Targets are selected with `--target agents|claude|both`. Without `--target`, interactive mode prompts; non-interactive mode fails. Root-level instruction files are not managed in this change.

The managed block is delimited by:

```markdown
<!-- OMS START -->
...
<!-- OMS END -->
```

The block should be concise and contain only durable workspace rules plus help guidance, for example:

```markdown
<!-- OMS START -->
## OMS Workspace Rules

- Run `oms status --json` before Git work involving `oms/`.
- Treat each `oms/<alias>/` directory as a separate Git repository.
- Use `oms` commands for scoped submodule workflows; do not guess root repository versus submodule Git scope.
- Do not create root commits for existing submodule pointer updates unless the user explicitly runs `oms record <alias>`.
- Check `oms --help` and `oms <command> --help` for exact command usage.
<!-- OMS END -->
```

Install behavior:

- Create `oms/` if needed.
- Create a missing target file with the managed block.
- Append the block after two blank lines when a non-empty target file has no OMS block.
- Replace exactly one complete existing OMS block.
- Normalize modified files to one trailing newline.
- Do not stage created or modified instruction files.

Uninstall behavior:

- Remove exactly one complete OMS block.
- If the file becomes empty or whitespace-only, delete it.
- If the file is missing or has no OMS block, exit 0 as a no-op.

Malformed marker states fail without modifying files. Malformed means start-only, end-only, mismatched marker counts, or more than one complete managed block. For multi-target operations, validate all selected files before writing any file. OS-level write failures are reported, but no cross-file rollback is guaranteed.

Rationale: marker-based management avoids symlink portability issues and avoids overwriting project-specific instructions. Keeping the block short makes CLI help the detailed source of truth.

### Decision: Make CLI help authoritative for new commands

Because managed agent instructions point users and agents to help output, each new or changed command help must include its purpose, scope boundary, and at least one usage example.

Minimum help coverage:

- `oms status --json`: machine-readable workspace state.
- `oms commit`: submodule source commit only; existing staged submodule changes are respected for partial commits.
- `oms record`: existing root gitlink pointer-update commit only.
- `oms pull` / `oms push`: submodule synchronization only; root pointer updates require `oms record`; `push --commit` is unsupported and fails before pushing with `oms record` guidance.
- `oms sync` / `oms unsync`: root topology working tree changes; default unstage behavior, optional prompt or `--commit` topology commit.
- `oms agent install/uninstall`: marker-managed `oms/` instruction files.

Rationale: short managed blocks only work if CLI help is useful enough to be the operational reference.

## Risks / Trade-offs

- `oms commit` has dual behavior: it respects existing staged submodule changes, but falls back to staging all changes when nothing is staged. Help and output must make this staged-first rule clear so users know how to make partial commits.
- Agent instruction files under `oms/` may not be read by every AI tool when the session starts at the workspace root. Root-level guidance or an installable workspace skill can be considered later if needed.
- Removing `push --commit` as a supported shortcut may break existing automation, but failing before pushing is safer than pushing successfully and then exiting non-zero.
- Marker block updates can conflict with manual edits inside the managed block. Treat the block as owned by `oms`; users should put custom guidance outside the markers.
- Path-limited pointer commits and split pointer detection require careful Git tests for staged/index/worktree edge cases.

## Migration Plan

- Update README examples and command reference to use `oms record <alias>` after push when a root pointer commit is desired.
- Treat `oms push --commit` as an unsupported option in this change; users should run `oms push <alias>` followed by `oms record <alias>` when they want to push and then commit the existing root gitlink pointer update.
- Existing workspaces are unaffected until users opt into `oms agent install`.

## Open Questions

- None.
